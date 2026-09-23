//! Read a user-dropped image into a data URL the webview can show and send.
//!
//! The webview cannot read an Explorer path. Size and extension are checked
//! here; the webview downscales what comes back.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use tauri::command;

pub(crate) fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?;
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Read `path` when it is an allowed image no larger than `max_bytes`.
pub(crate) fn read_image_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    if image_mime(path).is_none() {
        return Err("not an image".to_string());
    }
    if max_bytes == 0 {
        return Err("image too large".to_string());
    }
    let meta = std::fs::metadata(path).map_err(|err| err.to_string())?;
    if meta.len() > max_bytes {
        return Err("image too large".to_string());
    }
    let mut file = File::open(path).map_err(|err| err.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("image too large".to_string());
    }
    Ok(bytes)
}

fn data_url(path: &Path, bytes: &[u8]) -> Result<String, String> {
    let mime = image_mime(path).ok_or_else(|| "not an image".to_string())?;
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

#[command]
pub fn read_dropped_image(path: String, max_bytes: u64) -> Result<String, String> {
    let path = Path::new(&path);
    let bytes = read_image_bytes(path, max_bytes)?;
    data_url(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_a_non_image_extension() {
        let err = read_image_bytes(Path::new("clip.mp4"), 1024).unwrap_err();
        assert_eq!(err, "not an image");
    }

    #[test]
    fn rejects_an_oversized_png() {
        let path = std::env::temp_dir().join(format!("yui_image_drop_{}.png", std::process::id()));
        let mut file = File::create(&path).unwrap();
        file.write_all(&[0, 1, 2, 3]).unwrap();
        let err = read_image_bytes(&path, 3).unwrap_err();
        assert_eq!(err, "image too large");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_a_png_under_the_cap() {
        let path =
            std::env::temp_dir().join(format!("yui_image_drop_ok_{}.png", std::process::id()));
        let mut file = File::create(&path).unwrap();
        file.write_all(b"png").unwrap();
        let bytes = read_image_bytes(&path, 16).unwrap();
        assert_eq!(bytes, b"png");
        let url = data_url(&path, &bytes).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_file(&path);
    }
}
