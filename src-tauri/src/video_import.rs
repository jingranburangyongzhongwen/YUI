//! Video → remote WHAM pkl → local VRMA install.
//!
//! Uploads a dropped mp4/mov to the configured WHAM HTTP service, then runs the
//! existing pkl converter at the clip's frame rate so playback speed matches.

use crate::pkl_import::{
    converter_script, custom_motions_dir, dest_stem, write_vrma, ImportedPklMotion,
};
use serde::Deserialize;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::command;

const MAX_VIDEO_BYTES: u64 = 200 * 1024 * 1024;
const POLL_MS: u64 = 2000;
const JOB_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MIN_FPS: f64 = 1.0;
const MAX_FPS: f64 = 240.0;

#[derive(Debug, Deserialize)]
struct JobCreated {
    id: String,
}

#[derive(Debug, Deserialize)]
struct JobStatus {
    status: String,
    error: Option<String>,
}

pub(crate) fn is_video_path(src: &Path) -> bool {
    src.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "mov"))
}

pub(crate) fn validate_video(src: &Path) -> Result<PathBuf, String> {
    let src = src
        .canonicalize()
        .map_err(|_| "source file not found".to_string())?;
    if !is_video_path(&src) {
        return Err("not a video file".to_string());
    }
    let mut file = std::fs::File::open(&src).map_err(|_| "source file not found".to_string())?;
    let len = file
        .metadata()
        .map_err(|_| "source file not found".to_string())?
        .len();
    if len > MAX_VIDEO_BYTES {
        return Err("source file too large".to_string());
    }
    let mut header = [0u8; 8];
    let n = file
        .read(&mut header)
        .map_err(|_| "source file not found".to_string())?;
    if n < 8 || &header[4..8] != b"ftyp" {
        return Err("not a video file".to_string());
    }
    Ok(src)
}

fn u32_be(data: &[u8], i: usize) -> Option<u32> {
    data.get(i..i + 4)?.try_into().ok().map(u32::from_be_bytes)
}

struct BoxIter<'a> {
    data: &'a [u8],
    i: usize,
}

impl<'a> Iterator for BoxIter<'a> {
    type Item = (&'a [u8], &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let i = self.i;
        if i + 8 > self.data.len() {
            return None;
        }
        let mut size = u32_be(self.data, i)? as u64;
        let typ = &self.data[i + 4..i + 8];
        let mut hdr = 8usize;
        if size == 1 {
            if i + 16 > self.data.len() {
                return None;
            }
            size = u64::from_be_bytes(self.data[i + 8..i + 16].try_into().ok()?);
            hdr = 16;
        } else if size == 0 {
            size = (self.data.len() - i) as u64;
        }
        let end = i.checked_add(usize::try_from(size).ok()?)?;
        if size < hdr as u64 || end > self.data.len() {
            return None;
        }
        self.i = end;
        Some((typ, &self.data[i + hdr..end]))
    }
}

fn boxes(data: &[u8]) -> BoxIter<'_> {
    BoxIter { data, i: 0 }
}

fn mdhd_timescale(payload: &[u8]) -> Option<u32> {
    let version = *payload.first()?;
    if version == 1 {
        u32_be(payload, 20)
    } else {
        u32_be(payload, 12)
    }
}

fn stts_delta(payload: &[u8]) -> Option<f64> {
    let n = u32_be(payload, 4)? as usize;
    if n < 1 || payload.len() < 8 + 8 * n {
        return None;
    }
    let mut total_count: u64 = 0;
    let mut total_ticks: u64 = 0;
    for i in 0..n {
        let count = u32_be(payload, 8 + 8 * i)? as u64;
        let delta = u32_be(payload, 12 + 8 * i)? as u64;
        total_count += count;
        total_ticks += count * delta;
    }
    if total_count == 0 || total_ticks == 0 {
        return None;
    }
    Some(total_ticks as f64 / total_count as f64)
}

fn trak_fps(trak: &[u8]) -> Option<f64> {
    let mut timescale = None;
    let mut delta = None;
    let mut is_video = false;
    for (typ, payload) in boxes(trak) {
        if typ != b"mdia" {
            continue;
        }
        for (mtyp, mpay) in boxes(payload) {
            match mtyp {
                b"mdhd" => timescale = mdhd_timescale(mpay),
                b"hdlr" => is_video = mpay.get(8..12) == Some(b"vide"),
                b"minf" => {
                    for (ntyp, npay) in boxes(mpay) {
                        if ntyp != b"stbl" {
                            continue;
                        }
                        for (styp, spay) in boxes(npay) {
                            if styp == b"stts" {
                                delta = stts_delta(spay);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if !is_video {
        return None;
    }
    let ts = timescale.filter(|t| *t > 0)?;
    let d = delta.filter(|d| *d > 0.0)?;
    Some(ts as f64 / d)
}

#[cfg(test)]
fn fps_from_iso_bmff(data: &[u8]) -> Option<f64> {
    let moov = boxes(data).find(|(typ, _)| *typ == b"moov")?.1;
    boxes(moov).find_map(|(typ, payload)| {
        if typ == b"trak" {
            trak_fps(payload)
        } else {
            None
        }
    })
}

fn read_moov(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|_| "cannot read video fps".to_string())?;
    let file_len = file
        .metadata()
        .map_err(|_| "cannot read video fps".to_string())?
        .len();
    let mut offset = 0u64;
    loop {
        if offset.saturating_add(8) > file_len {
            break;
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| "cannot read video fps".to_string())?;
        let mut hdr = [0u8; 8];
        file.read_exact(&mut hdr)
            .map_err(|_| "cannot read video fps".to_string())?;
        let mut size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let typ = &hdr[4..8];
        let mut hdr_len = 8u64;
        if size == 1 {
            let mut ext = [0u8; 8];
            file.read_exact(&mut ext)
                .map_err(|_| "cannot read video fps".to_string())?;
            size = u64::from_be_bytes(ext);
            hdr_len = 16;
        } else if size == 0 {
            size = file_len - offset;
        }
        if size < hdr_len || offset.saturating_add(size) > file_len {
            break;
        }
        if typ == b"moov" {
            let payload_len = usize::try_from(size - hdr_len)
                .map_err(|_| "cannot read video fps".to_string())?;
            let mut payload = vec![0u8; payload_len];
            file.read_exact(&mut payload)
                .map_err(|_| "cannot read video fps".to_string())?;
            return Ok(payload);
        }
        offset += size;
    }
    Err("cannot read video fps".to_string())
}

pub(crate) fn probe_fps(video: &Path) -> Result<f64, String> {
    let moov = read_moov(video)?;
    let fps = boxes(&moov)
        .find_map(|(typ, payload)| {
            if typ == b"trak" {
                trak_fps(payload)
            } else {
                None
            }
        })
        .ok_or_else(|| "cannot read video fps".to_string())?;
    if fps.is_finite() && (MIN_FPS..=MAX_FPS).contains(&fps) {
        Ok(fps)
    } else {
        Err("cannot read video fps".to_string())
    }
}

fn valid_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn map_ureq(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(409, _) => "wham busy".to_string(),
        ureq::Error::Status(413, _) => "source file too large".to_string(),
        ureq::Error::Status(_, _) | ureq::Error::Transport(_) => "wham request failed".to_string(),
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(10 * 60))
        .timeout_write(Duration::from_secs(10 * 60))
        .build()
}

fn upload_job(
    http: &ureq::Agent,
    base: &str,
    video: &Path,
    filename: &str,
) -> Result<String, String> {
    let bytes = std::fs::read(video).map_err(|_| "source file not found".to_string())?;
    let resp = http
        .post(&join_url(base, "/jobs"))
        .set("Content-Type", "application/octet-stream")
        .set("X-Filename", filename)
        .send_bytes(&bytes)
        .map_err(map_ureq)?;
    let created: JobCreated = resp
        .into_json()
        .map_err(|_| "wham request failed".to_string())?;
    if !valid_job_id(&created.id) {
        return Err("wham request failed".to_string());
    }
    Ok(created.id)
}

fn poll_job(http: &ureq::Agent, base: &str, id: &str) -> Result<(), String> {
    let url = join_url(base, &format!("/jobs/{id}"));
    let deadline = Instant::now() + JOB_TIMEOUT;
    loop {
        let resp = http
            .get(&url)
            .timeout(Duration::from_secs(15))
            .call()
            .map_err(map_ureq)?;
        let job: JobStatus = resp
            .into_json()
            .map_err(|_| "wham request failed".to_string())?;
        match job.status.as_str() {
            "done" => return Ok(()),
            "error" => {
                log::error!("wham_job_error error={:?}", job.error);
                return Err("inference failed".to_string());
            }
            "queued" | "running" => {
                if Instant::now() >= deadline {
                    return Err("wham timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(POLL_MS));
            }
            _ => return Err("wham request failed".to_string()),
        }
    }
}

fn download_pkl(http: &ureq::Agent, base: &str, id: &str, dest: &Path) -> Result<(), String> {
    let url = join_url(base, &format!("/jobs/{id}/pkl"));
    let resp = http.get(&url).call().map_err(map_ureq)?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .read_to_end(&mut bytes)
        .map_err(|_| "wham request failed".to_string())?;
    if bytes.is_empty() || bytes[0] != 0x80 {
        return Err("wham request failed".to_string());
    }
    std::fs::write(dest, bytes).map_err(|_| "storage unavailable".to_string())
}

fn drop_filename(src: &Path) -> String {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_ascii_lowercase();
    format!("clip.{ext}")
}

pub(crate) fn import_video_at(
    src_path: &str,
    reserved_ids: &[String],
    wham_base_url: &str,
    dest_dir: &Path,
    converter: &Path,
    http: &ureq::Agent,
) -> Result<ImportedPklMotion, String> {
    let base = wham_base_url.trim().trim_end_matches('/');
    if base.is_empty() || !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("wham not configured".to_string());
    }
    let src = validate_video(Path::new(src_path))?;
    let fps = probe_fps(&src)?;
    std::fs::create_dir_all(dest_dir).map_err(|_| "storage unavailable".to_string())?;
    let dest_dir = dest_dir
        .canonicalize()
        .map_err(|_| "storage unavailable".to_string())?;
    let reserved: HashSet<String> = reserved_ids.iter().cloned().collect();
    let stem = dest_stem(&src, &reserved, &dest_dir);
    let tmp = tempfile_pkl();
    let id = upload_job(http, base, &src, &drop_filename(&src))?;
    poll_job(http, base, &id)?;
    download_pkl(http, base, &id, &tmp)?;
    let imported = write_vrma(&dest_dir, &stem, &tmp, converter, Some(fps));
    let _ = std::fs::remove_file(&tmp);
    imported
}

fn tempfile_pkl() -> PathBuf {
    std::env::temp_dir().join(format!(
        "yui_wham_{}.pkl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

#[command]
pub async fn import_video_motion(
    src_path: String,
    reserved_ids: Vec<String>,
    wham_base_url: String,
) -> Result<ImportedPklMotion, String> {
    let dest_dir = custom_motions_dir();
    let converter = converter_script();
    tauri::async_runtime::spawn_blocking(move || {
        import_video_at(
            &src_path,
            &reserved_ids,
            &wham_base_url,
            &dest_dir,
            &converter,
            &agent(),
        )
    })
    .await
    .map_err(|_| "conversion failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::Arc;
    use std::thread;

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("yui_video_test_{tag}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn box_bytes(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = (8 + payload.len()) as u32;
        let mut out = size.to_be_bytes().to_vec();
        out.extend_from_slice(typ);
        out.extend_from_slice(payload);
        out
    }

    fn trak(timescale: u32, sample_delta: u32, handler: &[u8; 4]) -> Vec<u8> {
        let mdhd = {
            let mut p = vec![0u8; 4];
            p.extend_from_slice(&0u32.to_be_bytes());
            p.extend_from_slice(&0u32.to_be_bytes());
            p.extend_from_slice(&timescale.to_be_bytes());
            p.extend_from_slice(&300u32.to_be_bytes());
            p.extend_from_slice(&0x55C4u16.to_be_bytes());
            p.extend_from_slice(&0u16.to_be_bytes());
            box_bytes(b"mdhd", &p)
        };
        let mut hdlr_p = vec![0u8; 8];
        hdlr_p.extend_from_slice(handler);
        hdlr_p.extend_from_slice(&[0u8; 12]);
        let hdlr = box_bytes(b"hdlr", &hdlr_p);
        let mut stts_p = 0u32.to_be_bytes().to_vec();
        stts_p.extend_from_slice(&1u32.to_be_bytes());
        stts_p.extend_from_slice(&10u32.to_be_bytes());
        stts_p.extend_from_slice(&sample_delta.to_be_bytes());
        let stbl = box_bytes(b"stbl", &box_bytes(b"stts", &stts_p));
        let minf = box_bytes(b"minf", &stbl);
        let mut mdia_p = mdhd;
        mdia_p.extend_from_slice(&hdlr);
        mdia_p.extend_from_slice(&minf);
        box_bytes(b"trak", &box_bytes(b"mdia", &mdia_p))
    }

    fn wrap_mp4(moov_payload: &[u8]) -> Vec<u8> {
        let mut ftyp_p = b"isom".to_vec();
        ftyp_p.extend_from_slice(&0u32.to_be_bytes());
        ftyp_p.extend_from_slice(b"isom");
        let mut out = box_bytes(b"ftyp", &ftyp_p);
        out.extend_from_slice(&box_bytes(b"moov", moov_payload));
        out
    }

    fn synthetic_mp4(timescale: u32, sample_delta: u32) -> Vec<u8> {
        wrap_mp4(&trak(timescale, sample_delta, b"vide"))
    }

    fn python_present() -> bool {
        crate::pkl_import::python_commands()
            .iter()
            .any(|(bin, prefix)| {
                Command::new(bin)
                    .args(*prefix)
                    .arg("-c")
                    .arg("print(1)")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
    }

    fn pickle_bytes() -> Vec<u8> {
        let mut bytes = vec![0x80, 0x04];
        bytes.extend_from_slice(b"yui");
        bytes
    }

    fn spawn_wham(pkl: Vec<u8>, job_json: &'static str) -> (u16, thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let pkl = Arc::new(pkl);
        let handle = thread::spawn(move || loop {
            let mut req = match server.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(Some(r)) => r,
                _ => break,
            };
            let url = req.url().to_string();
            let method = req.method().to_string();
            if method == "POST" && url == "/jobs" {
                let _ = req.as_reader().read_to_end(&mut Vec::new());
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"id":"j1","status":"queued"}"#)
                        .with_status_code(202),
                );
            } else if method == "GET" && url == "/jobs/j1" {
                let _ = req.respond(tiny_http::Response::from_string(job_json));
            } else if method == "GET" && url == "/jobs/j1/pkl" {
                let _ = req.respond(tiny_http::Response::from_data(pkl.as_slice().to_vec()));
            } else {
                let _ = req.respond(tiny_http::Response::from_string("no").with_status_code(404));
            }
        });
        (port, handle)
    }

    fn fake_converter(dir: &Path) -> PathBuf {
        let script = dir.join("fake_convert.py");
        fs::write(
            &script,
            r#"import sys
dest = sys.argv[sys.argv.index("-o") + 1]
fps = sys.argv[sys.argv.index("--fps") + 1]
open(dest, "w").write(fps)
"#,
        )
        .unwrap();
        script
    }

    #[test]
    fn is_video_path_accepts_mp4_mov() {
        assert!(is_video_path(Path::new("a.MP4")));
        assert!(is_video_path(Path::new("/tmp/clip.mov")));
        assert!(!is_video_path(Path::new("d.webm")));
        assert!(!is_video_path(Path::new("a.pkl")));
        assert!(!is_video_path(Path::new("a.vrma")));
    }

    #[test]
    fn validate_video_rejects_wrong_magic() {
        let dir = unique_dir("magic");
        let src = dir.join("clip.mp4");
        fs::write(&src, b"not a movie").unwrap();
        assert_eq!(validate_video(&src).unwrap_err(), "not a video file");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_video_accepts_ftyp() {
        let dir = unique_dir("ok");
        let src = dir.join("clip.mp4");
        fs::write(&src, synthetic_mp4(30, 1)).unwrap();
        assert!(validate_video(&src).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_errors_carry_no_path_separators() {
        let err = validate_video(Path::new("/no/such.mp4")).unwrap_err();
        assert!(!err.contains('/') && !err.contains('\\'), "{err}");
    }

    #[test]
    fn fps_from_iso_bmff_reads_timescale_over_stts() {
        assert!((fps_from_iso_bmff(&synthetic_mp4(30, 1)).unwrap() - 30.0).abs() < 0.01);
        assert!(
            (fps_from_iso_bmff(&synthetic_mp4(30000, 1001)).unwrap() - 30000.0 / 1001.0).abs()
                < 0.01
        );
        assert!(fps_from_iso_bmff(b"not a movie").is_none());
    }

    #[test]
    fn fps_from_iso_bmff_skips_audio_track() {
        let mut moov = trak(44100, 1024, b"soun");
        moov.extend_from_slice(&trak(24, 1, b"vide"));
        let data = wrap_mp4(&moov);
        assert!((fps_from_iso_bmff(&data).unwrap() - 24.0).abs() < 0.01);
    }

    #[test]
    fn probe_fps_reads_moov_after_mdat() {
        let dir = unique_dir("mdat");
        let src = dir.join("clip.mp4");
        let mut ftyp_p = b"isom".to_vec();
        ftyp_p.extend_from_slice(&0u32.to_be_bytes());
        ftyp_p.extend_from_slice(b"isom");
        let mut out = box_bytes(b"ftyp", &ftyp_p);
        out.extend_from_slice(&box_bytes(b"mdat", &[0u8; 64 * 1024]));
        out.extend_from_slice(&box_bytes(b"moov", &trak(24, 1, b"vide")));
        fs::write(&src, out).unwrap();
        let fps = probe_fps(&src).unwrap();
        assert!((fps - 24.0).abs() < 0.01, "{fps}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_video_at_uses_probed_fps_and_video_stem() {
        if !python_present() {
            return;
        }
        let dir = unique_dir("wham");
        let src = dir.join("spin.mp4");
        fs::write(&src, synthetic_mp4(24, 1)).unwrap();
        let (port, handle) = spawn_wham(pickle_bytes(), r#"{"id":"j1","status":"done"}"#);
        let dest_dir = dir.join("motions");
        fs::create_dir_all(&dest_dir).unwrap();
        let script = fake_converter(&dir);
        let imported = import_video_at(
            src.to_str().unwrap(),
            &[],
            &format!("http://127.0.0.1:{port}"),
            &dest_dir,
            &script,
            &agent(),
        )
        .unwrap();
        assert_eq!(imported.id, "spin");
        assert_eq!(imported.file_name, "spin.vrma");
        assert_eq!(
            fs::read_to_string(dest_dir.join("spin.vrma"))
                .unwrap()
                .trim(),
            "24"
        );
        fs::remove_dir_all(&dir).ok();
        let _ = handle.join();
    }

    #[test]
    fn import_video_at_rejects_empty_base_url() {
        let dir = unique_dir("empty");
        let src = dir.join("clip.mp4");
        fs::write(&src, synthetic_mp4(30, 1)).unwrap();
        let err = import_video_at(
            src.to_str().unwrap(),
            &[],
            "  ",
            &dir,
            Path::new("missing.py"),
            &agent(),
        )
        .unwrap_err();
        assert_eq!(err, "wham not configured");
        fs::remove_dir_all(&dir).ok();
    }
}
