//! Paths on disk of files dropped from the OS into a WebView2 webview
//! (Windows; Stage 10 `08` R5). The DOM drag lifecycle of WebView2 gives the
//! page `File` objects without paths, so the page hands them to the host
//! with `chrome.webview.postMessageWithAdditionalObjects({ svodeFileDrop:
//! id }, files)` and the host answers with their paths, read from the
//! `ICoreWebView2File` objects, in an event to that webview. A drop whose
//! files are not all on disk gets no paths: the page then saves the files
//! as before.

#[cfg(any(windows, test))]
use serde::Serialize;

/// The event that answers a drop message of the page.
#[cfg(windows)]
const DROP_PATHS_EVENT: &str = "webview-file-drop-paths";
/// Bounds what the page may name a drop.
#[cfg(any(windows, test))]
const DROP_ID_LIMIT: usize = 64;

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DropPaths {
    id: String,
    paths: Vec<String>,
}

/// Every webview of the app answers drop messages of its page.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("svode-webview-file-drop")
        .on_webview_ready(|webview| answer_drop_messages(&webview))
        .build()
}

#[cfg(not(windows))]
fn answer_drop_messages(_webview: &tauri::Webview) {}

#[cfg(windows)]
fn answer_drop_messages(webview: &tauri::Webview) {
    use tauri::Emitter;
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows::core::PWSTR;

    let target = webview.clone();
    let registered = webview.with_webview(move |platform| unsafe {
        let core = match platform.controller().CoreWebView2() {
            Ok(core) => core,
            Err(error) => {
                tracing::warn!(%error, "WebView2 is not ready for dropped file paths");
                return;
            }
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut message = PWSTR::null();
            args.WebMessageAsJson(&mut message)?;
            let Some(id) = drop_message_id(&take_pwstr(message)) else {
                return Ok(());
            };
            let paths = match file_paths(&args) {
                Ok(paths) => drop_paths(paths),
                Err(error) => {
                    tracing::warn!(%error, "Failed to read dropped file paths");
                    Vec::new()
                }
            };
            if let Err(error) =
                target.emit_to(target.label(), DROP_PATHS_EVENT, DropPaths { id, paths })
            {
                tracing::warn!(%error, "Failed to answer a file drop");
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = core.add_WebMessageReceived(&handler, &mut token) {
            tracing::warn!(%error, "Failed to listen for dropped file paths");
        }
    });
    if let Err(error) = registered {
        tracing::warn!(%error, "Failed to reach WebView2 for dropped file paths");
    }
}

/// The paths of the `ICoreWebView2File` objects a message carries, in order.
#[cfg(windows)]
unsafe fn file_paths(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
) -> windows::core::Result<Vec<Option<String>>> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::take_pwstr;
    use windows::core::{Interface, PWSTR};

    unsafe {
        let objects = args
            .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
            .AdditionalObjects()?;
        let mut count = 0u32;
        objects.Count(&mut count)?;
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let Ok(file) = objects.GetValueAtIndex(index)?.cast::<ICoreWebView2File>() else {
                paths.push(None);
                continue;
            };
            let mut path = PWSTR::null();
            file.Path(&mut path)?;
            paths.push(Some(take_pwstr(path)));
        }
        Ok(paths)
    }
}

/// The id of a drop message `{ "svodeFileDrop": id }`; none for any other
/// message, such as the IPC of Tauri.
#[cfg(any(windows, test))]
fn drop_message_id(json: &str) -> Option<String> {
    let serde_json::Value::Object(message) = serde_json::from_str(json).ok()? else {
        return None;
    };
    if message.len() != 1 {
        return None;
    }
    let id = message.get("svodeFileDrop")?.as_str()?;
    let valid = !id.is_empty()
        && id.len() <= DROP_ID_LIMIT
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    valid.then(|| id.to_string())
}

/// The paths of a drop when every file has an absolute path, else none: the
/// page saves files without a path on disk. A network share stays in the
/// list, so the target refuses it rather than reading its file.
#[cfg(any(windows, test))]
fn drop_paths(paths: Vec<Option<String>>) -> Vec<String> {
    let paths: Option<Vec<String>> = paths
        .into_iter()
        .map(|path| {
            path.filter(|path| {
                !path.chars().any(char::is_control) && std::path::Path::new(path).is_absolute()
            })
        })
        .collect();
    paths.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_drop_message_of_the_page_names_a_drop() {
        assert_eq!(
            drop_message_id(r#"{"svodeFileDrop":"drop-17-3"}"#).as_deref(),
            Some("drop-17-3")
        );
        for message in [
            r#""svodeFileDrop""#,
            r#"{"cmd":"plugin:event|listen"}"#,
            r#"{"svodeFileDrop":"drop-1","paths":["C:\\a"]}"#,
            r#"{"svodeFileDrop":""}"#,
            r#"{"svodeFileDrop":7}"#,
            r#"{"svodeFileDrop":"../x"}"#,
            r#"[{"svodeFileDrop":"drop-1"}]"#,
            "not json",
        ] {
            assert_eq!(drop_message_id(message), None, "{message}");
        }
        let long = format!(r#"{{"svodeFileDrop":"{}"}}"#, "a".repeat(DROP_ID_LIMIT + 1));
        assert_eq!(drop_message_id(&long), None);
    }

    #[test]
    fn a_drop_has_paths_only_when_every_file_is_on_disk() {
        let absolute = |name: &str| {
            std::env::temp_dir()
                .join(name)
                .to_string_lossy()
                .into_owned()
        };
        let (a, b) = (absolute("a.png"), absolute("Мои файлы"));
        assert_eq!(
            drop_paths(vec![Some(a.clone()), Some(b.clone())]),
            vec![a.clone(), b]
        );
        assert!(drop_paths(vec![Some(a.clone()), None]).is_empty());
        assert!(drop_paths(vec![Some(a.clone()), Some(String::new())]).is_empty());
        assert!(drop_paths(vec![Some(a.clone()), Some("relative.png".into())]).is_empty());
        assert!(drop_paths(vec![Some(format!("{a}\n"))]).is_empty());
        assert!(drop_paths(Vec::new()).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_network_share_stays_for_the_target_to_refuse() {
        assert_eq!(
            drop_paths(vec![
                Some(r"C:\Users\me\a.png".into()),
                Some(r"\\server\share\b.png".into()),
            ]),
            vec![
                r"C:\Users\me\a.png".to_string(),
                r"\\server\share\b.png".to_string()
            ]
        );
    }

    #[test]
    fn the_answer_names_the_drop_and_its_paths() {
        assert_eq!(
            serde_json::to_value(DropPaths {
                id: "drop-1".into(),
                paths: vec!["/a".into()],
            })
            .unwrap(),
            serde_json::json!({ "id": "drop-1", "paths": ["/a"] })
        );
    }
}
