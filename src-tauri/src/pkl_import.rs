//! WHAM pkl → VRMA install into `public/custom_motions` (native half).
//!
//! Spawns the repo `pkl2vrma/wham_to_vrma.py` converter. A native command can
//! read an Explorer-dropped path that the webview cannot; the webview then
//! hot-merges the stem into the live motion registry.

use crate::import_fs::{collides, derive_dest_stem, ensure_within};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::command;

/// Max accepted source size for a WHAM pickle.
const MAX_PKL_BYTES: u64 = 256 * 1024 * 1024;

/// Installed clip handle returned to the webview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPklMotion {
    pub id: String,
    pub file_name: String,
}

pub(crate) fn is_pkl_path(src: &Path) -> bool {
    src.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pkl"))
        == Some(true)
}

pub(crate) fn validate_pkl(src: &Path) -> Result<(), String> {
    let src = src
        .canonicalize()
        .map_err(|_| "source file not found".to_string())?;
    if !src.is_file() {
        return Err("source file not found".to_string());
    }
    if !is_pkl_path(&src) {
        return Err("not a .pkl file".to_string());
    }
    if std::fs::metadata(&src)
        .map_err(|_| "source file not found".to_string())?
        .len()
        > MAX_PKL_BYTES
    {
        return Err("source file too large".to_string());
    }
    let mut header = [0u8; 1];
    let n = std::fs::File::open(&src)
        .and_then(|mut f| f.read(&mut header))
        .map_err(|_| "source file not found".to_string())?;
    if n == 0 || header[0] != 0x80 {
        return Err("not a .pkl file".to_string());
    }
    Ok(())
}

pub(crate) fn converter_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pkl2vrma/wham_to_vrma.py")
}

pub(crate) fn custom_motions_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/custom_motions")
}

pub(crate) fn dest_stem(src: &Path, reserved: &HashSet<String>, dest_dir: &Path) -> String {
    derive_dest_stem(src, |candidate| {
        reserved.contains(candidate) || collides(&dest_dir.join(format!("{candidate}.vrma")))
    })
}

pub(crate) fn python_commands() -> &'static [(&'static str, &'static [&'static str])] {
    if cfg!(windows) {
        &[("py", &["-3"]), ("python", &[]), ("python3", &[])]
    } else {
        &[("python3", &[]), ("python", &[])]
    }
}

/// Node rejects Windows `\\?\` extended paths (`EISDIR lstat 'D:'`).
fn subprocess_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

pub(crate) fn run_converter(
    script: &Path,
    pkl: &Path,
    dest: &Path,
    fps: Option<f64>,
) -> Result<(), String> {
    let script = script
        .canonicalize()
        .map_err(|_| "pkl converter unavailable".to_string())?;
    if !script.is_file() {
        return Err("pkl converter unavailable".to_string());
    }
    let cwd = script
        .parent()
        .ok_or_else(|| "pkl converter unavailable".to_string())?;
    let cwd = subprocess_path(cwd);
    let script = subprocess_path(&script);
    let pkl = subprocess_path(pkl);
    let dest = subprocess_path(dest);
    let mut last_fail: Option<String> = None;
    for (bin, prefix) in python_commands() {
        let mut cmd = Command::new(bin);
        cmd.args(*prefix)
            .arg(&script)
            .arg(&pkl)
            .arg("-o")
            .arg(&dest);
        if let Some(fps) = fps {
            cmd.arg("--fps").arg(format!("{fps}"));
        }
        cmd.current_dir(&cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        match cmd.output() {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log::error!(
                    "pkl_convert_failed bin={bin} status={:?} stderr={stderr}",
                    out.status
                );
                last_fail = Some("conversion failed".to_string());
                continue;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                log::error!("pkl_convert_spawn_failed bin={bin} error={err}");
                last_fail = Some("conversion failed".to_string());
                continue;
            }
        }
    }
    Err(last_fail.unwrap_or_else(|| "pkl converter unavailable".to_string()))
}

fn import_pkl_at(
    src_path: &str,
    reserved_ids: &[String],
    dest_dir: &Path,
    script: &Path,
) -> Result<ImportedPklMotion, String> {
    let src = PathBuf::from(src_path)
        .canonicalize()
        .map_err(|_| "source file not found".to_string())?;
    validate_pkl(&src)?;
    std::fs::create_dir_all(dest_dir).map_err(|_| "storage unavailable".to_string())?;
    let dest_dir = dest_dir
        .canonicalize()
        .map_err(|_| "storage unavailable".to_string())?;
    let reserved: HashSet<String> = reserved_ids.iter().cloned().collect();
    let stem = dest_stem(&src, &reserved, &dest_dir);
    write_vrma(&dest_dir, &stem, &src, script, None)
}

pub(crate) fn write_vrma(
    dest_dir: &Path,
    stem: &str,
    pkl: &Path,
    script: &Path,
    fps: Option<f64>,
) -> Result<ImportedPklMotion, String> {
    let dest = dest_dir.join(format!("{stem}.vrma"));
    ensure_within(dest_dir, &dest)?;
    run_converter(script, pkl, &dest, fps)?;
    if !dest.is_file() {
        return Err("conversion failed".to_string());
    }
    Ok(ImportedPklMotion {
        id: stem.to_string(),
        file_name: dest
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("clip.vrma")
            .to_string(),
    })
}

#[command]
pub async fn import_pkl_motion(
    src_path: String,
    reserved_ids: Vec<String>,
) -> Result<ImportedPklMotion, String> {
    let dest_dir = custom_motions_dir();
    let script = converter_script();
    tauri::async_runtime::spawn_blocking(move || {
        import_pkl_at(&src_path, &reserved_ids, &dest_dir, &script)
    })
    .await
    .map_err(|_| "conversion failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::process::Command;

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("yui_pkl_test_{tag}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_pkl(dir: &Path, name: &str) -> PathBuf {
        let src = dir.join(name);
        let mut f = fs::File::create(&src).unwrap();
        f.write_all(&[0x80, 0x04]).unwrap();
        src
    }

    #[test]
    fn validate_pkl_rejects_wrong_extension() {
        let dir = unique_dir("ext");
        let src = dir.join("clip.vrma");
        fs::write(&src, [0x80u8]).unwrap();
        assert_eq!(validate_pkl(&src).unwrap_err(), "not a .pkl file");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_pkl_rejects_non_pickle_magic() {
        let dir = unique_dir("magic");
        let src = dir.join("clip.pkl");
        fs::write(&src, b"not pickle").unwrap();
        assert_eq!(validate_pkl(&src).unwrap_err(), "not a .pkl file");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_pkl_accepts_pickle_protocol_header() {
        let dir = unique_dir("ok");
        let src = write_pkl(&dir, "clip.pkl");
        assert!(validate_pkl(&src).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dest_stem_avoids_catalog_and_existing_files() {
        let dir = unique_dir("stem");
        let dest = dir.join("motions");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("dance.vrma"), b"x").unwrap();
        let src = write_pkl(&dir, "dance.pkl");
        let mut reserved = HashSet::new();
        reserved.insert("idle".into());
        reserved.insert("dance".into());
        let stem = dest_stem(&src, &reserved, &dest);
        assert_ne!(stem, "dance");
        assert_ne!(stem, "idle");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn subprocess_path_strips_windows_extended_prefix() {
        assert_eq!(
            subprocess_path(Path::new(r"\\?\D:\a\wham_to_vrma.py")),
            PathBuf::from(r"D:\a\wham_to_vrma.py")
        );
        assert_eq!(
            subprocess_path(Path::new(r"\\?\UNC\server\share\clip.pkl")),
            PathBuf::from(r"\\server\share\clip.pkl")
        );
        assert_eq!(
            subprocess_path(Path::new(r"D:\a\clip.pkl")),
            PathBuf::from(r"D:\a\clip.pkl")
        );
    }

    #[test]
    fn import_errors_carry_no_path_separators() {
        let dir = unique_dir("err");
        let src = dir.join("clip.txt");
        fs::write(&src, [0x80u8]).unwrap();
        let err = validate_pkl(&src).unwrap_err();
        assert!(!err.contains('/') && !err.contains('\\'), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    fn python_present() -> bool {
        python_ok("print(1)")
    }

    fn python_ok(code: &str) -> bool {
        super::python_commands().iter().any(|(bin, prefix)| {
            Command::new(bin)
                .args(*prefix)
                .arg("-c")
                .arg(code)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
    }

    fn run_python(code: &str) -> bool {
        super::python_commands().iter().any(|(bin, prefix)| {
            Command::new(bin)
                .args(*prefix)
                .arg("-c")
                .arg(code)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
    }

    #[test]
    fn import_pkl_at_runs_converter_and_returns_stem() {
        if !python_present() {
            return;
        }
        let dir = unique_dir("spawn");
        let src = write_pkl(&dir, "spin.pkl");
        let dest_dir = dir.join("motions");
        fs::create_dir_all(&dest_dir).unwrap();
        let script = dir.join("fake_convert.py");
        fs::write(
            &script,
            r#"import sys
dest = sys.argv[sys.argv.index("-o") + 1]
open(dest, "wb").write(b"glTF")
"#,
        )
        .unwrap();
        let imported =
            super::import_pkl_at(src.to_str().unwrap(), &[], &dest_dir, &script).unwrap();
        assert_eq!(imported.id, "spin");
        assert_eq!(imported.file_name, "spin.vrma");
        assert!(dest_dir.join("spin.vrma").is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_converter_passes_fps_flag() {
        if !python_present() {
            return;
        }
        let dir = unique_dir("fps");
        let src = write_pkl(&dir, "clip.pkl");
        let dest = dir.join("clip.vrma");
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
        super::run_converter(&script, &src, &dest, Some(29.97)).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap().trim(), "29.97");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_pkl_at_converts_synthetic_wham_pkl() {
        if !python_ok("import numpy") || Command::new("node").arg("-v").output().is_err() {
            return;
        }
        let dir = unique_dir("wham");
        let src = dir.join("drop.pkl");
        let src_lit = src.to_string_lossy().replace('\\', "\\\\");
        let code = format!(
            "import pickle,numpy as np; p='{src_lit}'; pose=np.zeros((8,24,3)); trans=np.zeros((8,3)); trans[:,2]=np.linspace(0,0.4,8); pickle.dump({{0:{{'pose_world':pose,'trans_world':trans}}}}, open(p,'wb'))"
        );
        assert!(run_python(&code), "failed to write synthetic WHAM pkl");
        let dest_dir = dir.join("motions");
        fs::create_dir_all(&dest_dir).unwrap();
        let imported = super::import_pkl_at(
            src.to_str().unwrap(),
            &[],
            &dest_dir,
            &super::converter_script(),
        )
        .expect("real pkl converter");
        assert_eq!(imported.id, "drop");
        let vrma = dest_dir.join("drop.vrma");
        assert!(vrma.is_file());
        let magic = fs::read(&vrma).unwrap();
        assert_eq!(&magic[..4], b"glTF");
        fs::remove_dir_all(&dir).ok();
    }
}
