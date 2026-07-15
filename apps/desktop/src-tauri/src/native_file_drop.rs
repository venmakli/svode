use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

use tauri::{Manager, ipc::InvokeBody};

use crate::AppError;

#[cfg(target_os = "macos")]
use objc2::ClassType;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSURL};

const DROP_CACHE_DIRECTORY: &str = "terminal-drops";
const DROP_FILE_NAME_HEADER: &str = "x-svode-drop-file-name";
const MAX_MATERIALIZED_DROP_BYTES: u64 = 100 * 1024 * 1024;

#[tauri::command]
pub fn native_file_drop_paths() -> Vec<String> {
    platform_drag_paths()
        .into_iter()
        .filter(|path| path.exists())
        .filter_map(|path| path.into_os_string().into_string().ok())
        .collect()
}

#[tauri::command]
pub async fn materialize_file_drop(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, AppError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::General(
            "Dropped file content must use raw IPC".to_string(),
        ));
    };
    let bytes = bytes.clone();
    validate_materialized_drop_size(bytes.len() as u64)?;

    let encoded_name = request
        .headers()
        .get(DROP_FILE_NAME_HEADER)
        .ok_or_else(|| AppError::General("Dropped file name is missing".to_string()))?
        .to_str()
        .map_err(|_| AppError::General("Dropped file name is invalid".to_string()))?;
    let file_name = decode_drop_file_name(encoded_name)?;
    let root = materialized_drop_root(&app)?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        materialize_drop_bytes(&root, &file_name, &bytes)
    })
    .await
    .map_err(|error| AppError::General(format!("Dropped-file worker failed: {error}")))??;

    path.into_os_string()
        .into_string()
        .map_err(|_| AppError::General("Dropped file path is not UTF-8".to_string()))
}

#[tauri::command]
pub async fn materialize_native_file_drop_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let root = materialized_drop_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || materialize_native_drop_paths(&root, paths))
        .await
        .map_err(|error| AppError::General(format!("Dropped-file worker failed: {error}")))??
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| AppError::General("Dropped file path is not UTF-8".to_string()))
        })
        .collect()
}

pub fn clear_materialized_file_drops(app: &tauri::AppHandle) -> Result<(), AppError> {
    let root = materialized_drop_root(app)?;
    match fs::remove_dir_all(root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn materialized_drop_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join(DROP_CACHE_DIRECTORY))
        .map_err(|error| {
            AppError::General(format!("Failed to resolve dropped-file cache: {error}"))
        })
}

fn materialize_drop_bytes(root: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
    validate_materialized_drop_size(bytes.len() as u64)?;
    let path = unique_drop_path(root, file_name)?;
    fs::write(&path, bytes)?;
    restrict_materialized_file_permissions(&path)?;
    Ok(path)
}

fn materialize_native_drop_paths(
    root: &Path,
    paths: Vec<String>,
) -> Result<Vec<PathBuf>, AppError> {
    materialize_native_drop_paths_with_limit(root, paths, MAX_MATERIALIZED_DROP_BYTES)
}

fn materialize_native_drop_paths_with_limit(
    root: &Path,
    paths: Vec<String>,
    max_bytes: u64,
) -> Result<Vec<PathBuf>, AppError> {
    let mut sources = Vec::with_capacity(paths.len());
    let mut declared_size = 0_u64;
    for path in paths {
        let source = PathBuf::from(path);
        if !source.is_absolute() || !source.is_file() {
            return Err(AppError::General(
                "Dropped file path is not accessible".to_string(),
            ));
        }
        let size = fs::metadata(&source)?.len();
        declared_size = declared_size.checked_add(size).ok_or_else(|| {
            AppError::General("Dropped virtual files exceed the 100 MiB limit".to_string())
        })?;
        if declared_size > max_bytes {
            return Err(AppError::General(
                "Dropped virtual files exceed the 100 MiB limit".to_string(),
            ));
        }
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::General("Dropped file name is invalid".to_string()))?
            .to_string();
        sources.push((source, file_name));
    }

    let mut materialized_paths = Vec::with_capacity(sources.len());
    let mut remaining_bytes = max_bytes;
    for (source, file_name) in sources {
        let target = match unique_drop_path(root, &file_name) {
            Ok(target) => target,
            Err(error) => {
                remove_materialized_paths(&materialized_paths);
                return Err(error);
            }
        };
        match copy_drop_file_limited(&source, &target, remaining_bytes) {
            Ok(copied_bytes) => {
                remaining_bytes -= copied_bytes;
                materialized_paths.push(target);
            }
            Err(error) => {
                remove_materialized_paths(&materialized_paths);
                remove_materialized_path(&target);
                return Err(error);
            }
        }
    }
    Ok(materialized_paths)
}

fn copy_drop_file_limited(source: &Path, target: &Path, max_bytes: u64) -> Result<u64, AppError> {
    let source = File::open(source)?;
    let mut limited_source = source.take(max_bytes.saturating_add(1));
    let mut target_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let copied_bytes = io::copy(&mut limited_source, &mut target_file)?;
    drop(target_file);
    if copied_bytes > max_bytes {
        let _ = fs::remove_file(target);
        return Err(AppError::General(
            "Dropped virtual files exceed the 100 MiB limit".to_string(),
        ));
    }
    restrict_materialized_file_permissions(target)?;
    Ok(copied_bytes)
}

fn remove_materialized_paths(paths: &[PathBuf]) {
    for path in paths {
        remove_materialized_path(path);
    }
}

fn remove_materialized_path(path: &Path) {
    if let Some(directory) = path.parent() {
        let _ = fs::remove_dir_all(directory);
    }
}

fn unique_drop_path(root: &Path, file_name: &str) -> Result<PathBuf, AppError> {
    let file_name = sanitize_drop_file_name(file_name)?;
    let directory = root.join(ulid::Ulid::new().to_string());
    fs::create_dir_all(&directory)?;
    restrict_materialized_directory_permissions(&directory)?;
    Ok(directory.join(file_name))
}

fn sanitize_drop_file_name(file_name: &str) -> Result<String, AppError> {
    let candidate = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    let sanitized = candidate
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_end_matches([' ', '.'])
        .to_string();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err(AppError::General(
            "Dropped file name is invalid".to_string(),
        ));
    }
    Ok(sanitized)
}

fn decode_drop_file_name(encoded: &str) -> Result<String, AppError> {
    if encoded.len() > 4096 {
        return Err(AppError::General(
            "Dropped file name is too long".to_string(),
        ));
    }
    let input = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'%' {
            decoded.push(input[index]);
            index += 1;
            continue;
        }
        if index + 2 >= input.len() {
            return Err(AppError::General(
                "Dropped file name encoding is invalid".to_string(),
            ));
        }
        let high = decode_hex(input[index + 1]);
        let low = decode_hex(input[index + 2]);
        let (Some(high), Some(low)) = (high, low) else {
            return Err(AppError::General(
                "Dropped file name encoding is invalid".to_string(),
            ));
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded)
        .map_err(|_| AppError::General("Dropped file name is not UTF-8".to_string()))
}

fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn validate_materialized_drop_size(size: u64) -> Result<(), AppError> {
    if size > MAX_MATERIALIZED_DROP_BYTES {
        return Err(AppError::General(
            "Dropped virtual files exceed the 100 MiB limit".to_string(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_materialized_directory_permissions(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_materialized_directory_permissions(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(unix)]
fn restrict_materialized_file_permissions(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_materialized_file_permissions(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_drag_paths() -> Vec<PathBuf> {
    let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    let mut paths = Vec::new();

    // Finder and modern macOS drag sources publish file URLs. Reading NSURL
    // objects also avoids the legacy-only path collection used by Wry 0.54.
    let url_classes = NSArray::from_slice(&[NSURL::class()]);
    if let Some(items) = unsafe { pasteboard.readObjectsForClasses_options(&url_classes, None) } {
        for item in &items {
            let Some(url) = item.downcast_ref::<NSURL>() else {
                continue;
            };
            if let Some(path) = file_url_to_path(url) {
                paths.push(path);
            }
        }
    }

    paths
}

#[cfg(target_os = "macos")]
fn file_url_to_path(url: &NSURL) -> Option<PathBuf> {
    url.isFileURL().then(|| url.to_file_path()).flatten()
}

#[cfg(not(target_os = "macos"))]
fn platform_drag_paths() -> Vec<std::path::PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{
        MAX_MATERIALIZED_DROP_BYTES, copy_drop_file_limited, decode_drop_file_name,
        materialize_drop_bytes, materialize_native_drop_paths_with_limit, sanitize_drop_file_name,
        validate_materialized_drop_size,
    };

    #[test]
    fn decodes_unicode_drop_file_names() {
        assert_eq!(
            decode_drop_file_name(
                "%D0%A1%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA%20%D1%8D%D0%BA%D1%80%D0%B0%D0%BD%D0%B0.png"
            )
            .unwrap(),
            "Снимок экрана.png"
        );
    }

    #[test]
    fn keeps_materialized_file_names_inside_the_drop_directory() {
        assert_eq!(
            sanitize_drop_file_name("../../Screenshot: 1.png").unwrap(),
            "Screenshot_ 1.png"
        );
    }

    #[test]
    fn materializes_drop_bytes_in_a_unique_private_directory() {
        let temp = tempdir().unwrap();
        let path = materialize_drop_bytes(temp.path(), "Снимок.png", b"png-bytes").unwrap();

        assert!(path.starts_with(temp.path()));
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("Снимок.png")
        );
        assert_eq!(fs::read(path).unwrap(), b"png-bytes");
    }

    #[cfg(unix)]
    #[test]
    fn restricts_materialized_drop_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempdir().unwrap();
        let path = materialize_drop_bytes(temp.path(), "Screenshot.png", b"png-bytes").unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[test]
    fn stops_native_copy_at_the_materialization_limit() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source.png");
        let target = temp.path().join("target.png");
        fs::write(&source, b"12345").unwrap();

        assert!(copy_drop_file_limited(&source, &target, 4).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn materializes_multiple_native_files_within_the_drop_limit() {
        let temp = tempdir().unwrap();
        let source_one = temp.path().join("one.png");
        let source_two = temp.path().join("two.png");
        fs::write(&source_one, b"12").unwrap();
        fs::write(&source_two, b"345").unwrap();
        let cache = temp.path().join("cache");

        let paths = materialize_native_drop_paths_with_limit(
            &cache,
            vec![
                source_one.to_string_lossy().into_owned(),
                source_two.to_string_lossy().into_owned(),
            ],
            5,
        )
        .unwrap();

        assert_eq!(paths.len(), 2);
        assert_eq!(fs::read(&paths[0]).unwrap(), b"12");
        assert_eq!(fs::read(&paths[1]).unwrap(), b"345");
    }

    #[test]
    fn rejects_native_files_over_the_aggregate_drop_limit_before_copying() {
        let temp = tempdir().unwrap();
        let source_one = temp.path().join("one.png");
        let source_two = temp.path().join("two.png");
        fs::write(&source_one, b"123").unwrap();
        fs::write(&source_two, b"456").unwrap();
        let cache = temp.path().join("cache");

        assert!(
            materialize_native_drop_paths_with_limit(
                &cache,
                vec![
                    source_one.to_string_lossy().into_owned(),
                    source_two.to_string_lossy().into_owned(),
                ],
                5,
            )
            .is_err()
        );
        assert!(!cache.exists());
    }

    #[test]
    fn rejects_oversized_virtual_files() {
        assert!(validate_materialized_drop_size(MAX_MATERIALIZED_DROP_BYTES).is_ok());
        assert!(validate_materialized_drop_size(MAX_MATERIALIZED_DROP_BYTES + 1).is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::path::Path;

    use objc2_foundation::{NSString, NSURL};

    use super::file_url_to_path;

    #[test]
    fn converts_unicode_file_urls_to_paths() {
        let path = Path::new("/tmp/Снимок экрана 1.png");
        let url = NSURL::from_file_path(path).expect("valid file URL");

        assert_eq!(file_url_to_path(&url).as_deref(), Some(path));
    }

    #[test]
    fn rejects_non_file_urls() {
        let value = NSString::from_str("https://example.com/image.png");
        let url = NSURL::URLWithString(&value).expect("valid URL");

        assert_eq!(file_url_to_path(&url), None);
    }
}
