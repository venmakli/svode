//! The terminal chats of the Cursor CLI (Stage 10 `07` N2, N3, N7): a
//! folder per chat, `chats/<md5(cwd)>/<chatId>/`, whose `meta.json` gives
//! its catalogue row. The chat's `store.db` holds its conversation and is
//! never opened: the reader only sees that it exists.

use std::ffi::OsString;
use std::fmt::Write;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use md5::{Digest, Md5};
use serde::Deserialize;
use serde_json::Value;
use svode_agents::catalog::{ListBounds, ListedSession};
use svode_agents::identity::{IdentityNamespace, SessionKey};
use svode_core::agent_adapters::AgentAdapterKind;

use super::{CatalogEntry, NativeList, NativeListing, bounded};

/// A `meta.json` larger than this is not a chat's metadata.
const META_BYTES: u64 = 64 * 1024;

/// The format of `meta.json` this reader knows (N5, N7).
const SCHEMA_VERSION: i64 = 1;

/// The Cursor CLI config directory: `CURSOR_CONFIG_DIR`, else `cursor`
/// under `XDG_CONFIG_HOME` on every system, else `.cursor` in the home
/// folder (N7).
pub(crate) fn config_dir(home: &Path, var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    let var = |name: &str| var(name).filter(|value| !value.is_empty());
    if let Some(dir) = var("CURSOR_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(config) = var("XDG_CONFIG_HOME") {
        return PathBuf::from(config).join("cursor");
    }
    home.join(".cursor")
}

/// The only fields of `meta.json` the reader keeps (N3).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    schema_version: Option<Value>,
    created_at_ms: Option<f64>,
    updated_at_ms: Option<f64>,
    #[serde(default)]
    has_conversation: bool,
    cwd: Option<String>,
    title: Option<String>,
    #[serde(default)]
    is_subagent: bool,
}

/// The terminal chats the catalogue lists (N2, N7): with a conversation, a
/// folder and a `store.db`, not of a subagent; the newest first within the
/// bounds. A chat continues in the terminal only from a folder whose path
/// still hashes to its chat folder (N6). A `meta.json` of another format
/// fails the source; one without its creation time or not readable is
/// skipped.
pub(super) fn list(root: &Path, bounds: &ListBounds) -> Result<NativeList, String> {
    if !root.is_dir() {
        return Err(format!("no Cursor config directory {}", root.display()));
    }
    let mut chats = Vec::new();
    let mut skipped = 0;
    for (folder, chat) in chat_dirs(&root.join("chats")) {
        let meta = chat.join("meta.json");
        if !meta.is_file() {
            continue;
        }
        let Some(meta) = read_meta(&meta) else {
            skipped += 1;
            continue;
        };
        let version = meta.schema_version.as_ref();
        if version.and_then(Value::as_i64) != Some(SCHEMA_VERSION) {
            return Err(format!(
                "{} has schemaVersion {}, not the format Svode reads",
                chat.join("meta.json").display(),
                version.map_or_else(|| "none".to_string(), Value::to_string)
            ));
        }
        if !meta.has_conversation || meta.is_subagent {
            continue;
        }
        let Some(cwd) = meta
            .cwd
            .filter(|cwd| cwd.len() <= bounds.cwd_bytes && Path::new(cwd).is_absolute())
        else {
            continue;
        };
        if !chat.join("store.db").is_file() {
            continue;
        }
        let Some(created_at) = meta.created_at_ms.and_then(at_millis) else {
            skipped += 1;
            continue;
        };
        let updated_at = meta.updated_at_ms.and_then(at_millis).unwrap_or(created_at);
        let Some(chat_id) = chat.file_name().and_then(|id| id.to_str()) else {
            continue;
        };
        let continues = Path::new(&cwd).is_dir() && chat_folder(&cwd, cfg!(windows)) == folder;
        chats.push((
            updated_at,
            CatalogEntry {
                listed: ListedSession {
                    key: SessionKey {
                        agent: AgentAdapterKind::Cursor.as_str().to_string(),
                        namespace: IdentityNamespace::Native,
                        session_id: chat_id.to_string(),
                    },
                    cwd: PathBuf::from(cwd),
                    title: meta
                        .title
                        .map(|title| bounded(title.trim(), bounds.title_bytes).to_string()),
                    updated_at: Some(updated_at.to_rfc3339_opts(SecondsFormat::Secs, true)),
                },
                listing: Some(NativeListing {
                    resume_id: chat_id.to_string(),
                    profile: None,
                    opens_in_chat: false,
                    continues_in_terminal: continues,
                    aliases: Vec::new(),
                    folders: Vec::new(),
                }),
            },
        ));
    }
    chats.sort_by_key(|(updated_at, _)| std::cmp::Reverse(*updated_at));
    let truncated = chats.len() > bounds.sessions;
    chats.truncate(bounds.sessions);
    Ok(NativeList {
        sessions: chats.into_iter().map(|(_, entry)| entry).collect(),
        truncated,
        skipped,
    })
}

/// Every chat folder with the name of the folder of its `cwd` hash; none
/// while the CLI has no chat.
fn chat_dirs(chats: &Path) -> Vec<(String, PathBuf)> {
    let subdirs = |dir: &Path| {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>()
    };
    subdirs(chats)
        .into_iter()
        .filter_map(|folder| {
            let name = folder.file_name()?.to_str()?.to_string();
            Some((name, folder))
        })
        .flat_map(|(name, folder)| {
            subdirs(&folder)
                .into_iter()
                .map(move |chat| (name.clone(), chat))
        })
        .collect()
}

fn read_meta(path: &Path) -> Option<Meta> {
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(META_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > META_BYTES {
        return None;
    }
    serde_json::from_str(&text).ok()
}

fn at_millis(millis: f64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(millis as i64)
}

/// The chat folder the Cursor CLI keeps the chats of a folder in, and
/// looks for one to resume in: `md5(path.resolve(cwd))` as Node computes
/// it, with the separators of the system and without following links.
fn chat_folder(cwd: &str, windows: bool) -> String {
    Md5::digest(resolved(cwd, windows).as_bytes())
        .iter()
        .fold(String::new(), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// An absolute path as Node's `path.resolve` gives it: `.` and `..`
/// resolved, repeated and trailing separators dropped and, on Windows, `/`
/// turned into `\` with the drive or share kept as written.
fn resolved(path: &str, windows: bool) -> String {
    let separator = if windows { '\\' } else { '/' };
    let path = if windows {
        path.replace('/', "\\")
    } else {
        path.to_string()
    };
    let (prefix, rest) = if windows {
        windows_prefix(&path)
    } else {
        ("", path.as_str())
    };
    let mut parts = Vec::new();
    for part in rest.split(separator) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("{prefix}{separator}{}", parts.join(&separator.to_string()))
}

/// The drive (`C:`) or share (`\\server\share`) of a Windows path and the
/// rest of it.
fn windows_prefix(path: &str) -> (&str, &str) {
    if let Some(unc) = path.strip_prefix("\\\\") {
        let mut end = 2;
        for (index, part) in unc.splitn(3, '\\').take(2).enumerate() {
            end += part.len() + usize::from(index > 0);
        }
        return path.split_at(end.min(path.len()));
    }
    match path.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => path.split_at(2),
        _ => ("", path),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// A chat folder of the CLI under `root` with this `meta.json` and,
    /// when `store`, a `store.db`.
    pub(crate) fn chat(root: &Path, folder: &str, id: &str, meta: Value, store: bool) {
        let dir = root.join("chats").join(folder).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.json"), meta.to_string()).unwrap();
        if store {
            fs::write(dir.join("store.db"), "not read").unwrap();
        }
    }

    /// The `meta.json` of a chat with a conversation in `cwd`.
    pub(crate) fn meta(cwd: &Path, title: Option<&str>) -> Value {
        json!({
            "schemaVersion": 1,
            "createdAtMs": 1_800_000_000_000_i64,
            "updatedAtMs": 1_800_000_100_000_i64,
            "hasConversation": true,
            "cwd": cwd.to_string_lossy(),
            "title": title,
        })
    }

    /// The chat folder of `cwd` on this system.
    pub(crate) fn folder_of(cwd: &Path) -> String {
        chat_folder(&cwd.to_string_lossy(), cfg!(windows))
    }

    fn with(mut meta: Value, field: &str, value: Value) -> Value {
        meta[field] = value;
        meta
    }

    fn without(mut meta: Value, field: &str) -> Value {
        meta.as_object_mut().unwrap().remove(field);
        meta
    }

    fn ids(list: &NativeList) -> Vec<&str> {
        list.sessions
            .iter()
            .map(|entry| entry.listed.key.session_id.as_str())
            .collect()
    }

    #[test]
    fn the_catalogue_lists_the_terminal_chats_with_a_conversation_a_folder_and_a_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".cursor");
        let cwd = temp.path().join("w");
        fs::create_dir_all(&cwd).unwrap();
        let folder = folder_of(&cwd);
        let add = |id: &str, meta: Value, store: bool| chat(&root, &folder, id, meta, store);
        add("listed", meta(&cwd, Some("  Fix the build  ")), true);
        add("created", without(meta(&cwd, None), "updatedAtMs"), true);
        add(
            "no-conversation",
            with(meta(&cwd, None), "hasConversation", json!(false)),
            true,
        );
        add("no-cwd", without(meta(&cwd, None), "cwd"), true);
        add("relative", with(meta(&cwd, None), "cwd", json!("w")), true);
        add("no-store", meta(&cwd, None), false);
        add(
            "subagent",
            with(meta(&cwd, None), "isSubagent", json!(true)),
            true,
        );
        fs::create_dir_all(root.join("chats").join(&folder).join("no-meta")).unwrap();

        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(ids(&list), ["listed", "created"], "the newest first");
        assert_eq!(list.skipped, 0);
        let listed = &list.sessions[0];
        assert_eq!(listed.listed.key.agent, "cursor");
        assert_eq!(listed.listed.key.namespace, IdentityNamespace::Native);
        assert_eq!(listed.listed.cwd, cwd);
        assert_eq!(listed.listed.title.as_deref(), Some("Fix the build"));
        assert_eq!(
            listed.listed.updated_at.as_deref(),
            Some("2027-01-15T08:01:40Z")
        );
        let listing = listed.listing.as_ref().unwrap();
        assert_eq!(listing.resume_id, "listed");
        assert!(!listing.opens_in_chat, "ACP does not load a terminal chat");
        assert!(listing.continues_in_terminal);
        assert!(listing.aliases.is_empty());
        assert_eq!(
            list.sessions[1].listed.updated_at.as_deref(),
            Some("2027-01-15T08:00:00Z"),
            "the creation time without an update"
        );

        let bounded = super::list(
            &root,
            &ListBounds {
                sessions: 1,
                ..ListBounds::default()
            },
        )
        .unwrap();
        assert!(bounded.truncated);
        assert_eq!(ids(&bounded), ["listed"]);
    }

    #[test]
    fn a_chat_continues_only_from_an_existing_folder_that_hashes_to_its_chat_folder() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".cursor");
        let cwd = temp.path().join("w");
        let gone = temp.path().join("gone");
        fs::create_dir_all(&cwd).unwrap();
        chat(&root, &folder_of(&cwd), "home", meta(&cwd, None), true);
        chat(
            &root,
            &folder_of(&temp.path().join("moved")),
            "moved",
            meta(&cwd, None),
            true,
        );
        chat(&root, &folder_of(&gone), "gone", meta(&gone, None), true);

        let list = list(&root, &ListBounds::default()).unwrap();
        let continues = |id: &str| {
            list.sessions
                .iter()
                .find(|entry| entry.listed.key.session_id == id)
                .unwrap_or_else(|| panic!("no {id}"))
                .listing
                .as_ref()
                .unwrap()
                .continues_in_terminal
        };
        assert!(continues("home"));
        assert!(!continues("moved"), "the CLI looks in another chat folder");
        assert!(!continues("gone"), "the folder no longer exists");
    }

    #[test]
    fn another_schema_version_fails_the_source() {
        let cases: [fn(&Path) -> Value; 3] = [
            |cwd: &Path| with(meta(cwd, None), "schemaVersion", json!(2)),
            |cwd: &Path| without(meta(cwd, None), "schemaVersion"),
            |cwd: &Path| {
                with(
                    with(meta(cwd, None), "schemaVersion", json!(2)),
                    "hasConversation",
                    json!(false),
                )
            },
        ];
        for meta_of in cases {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join(".cursor");
            let cwd = temp.path().join("w");
            chat(&root, &folder_of(&cwd), "listed", meta(&cwd, None), true);
            chat(&root, &folder_of(&cwd), "other", meta_of(&cwd), true);

            let error = list(&root, &ListBounds::default()).unwrap_err();
            assert!(error.contains("schemaVersion"), "{error}");
        }
    }

    #[test]
    fn a_chat_without_its_creation_time_or_a_readable_meta_is_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".cursor");
        let cwd = temp.path().join("w");
        let folder = folder_of(&cwd);
        chat(&root, &folder, "listed", meta(&cwd, None), true);
        chat(
            &root,
            &folder,
            "no-created",
            without(meta(&cwd, None), "createdAtMs"),
            true,
        );
        let broken = root.join("chats").join(&folder).join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("meta.json"), "{\"schemaVersion\": 1, \"cwd\"").unwrap();
        fs::write(broken.join("store.db"), "").unwrap();
        let large = root.join("chats").join(&folder).join("large");
        fs::create_dir_all(&large).unwrap();
        fs::write(
            large.join("meta.json"),
            with(
                meta(&cwd, None),
                "title",
                json!("x".repeat(META_BYTES as usize)),
            )
            .to_string(),
        )
        .unwrap();

        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(ids(&list), ["listed"]);
        assert_eq!(list.skipped, 3);
    }

    #[test]
    fn the_store_of_a_chat_is_never_opened() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".cursor");
        let cwd = temp.path().join("w");
        chat(&root, &folder_of(&cwd), "listed", meta(&cwd, None), true);
        let store = root
            .join("chats")
            .join(folder_of(&cwd))
            .join("listed/store.db");
        // A store no one may open: without permissions on Unix, held
        // without sharing on Windows.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&store, fs::Permissions::from_mode(0o000)).unwrap();
        }
        #[cfg(windows)]
        let _held = {
            use std::os::windows::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&store)
                .unwrap()
        };
        assert!(
            fs::File::open(&store).is_err(),
            "the fixture blocks opening"
        );

        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(ids(&list), ["listed"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&store, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn a_missing_config_directory_fails_the_source_and_one_without_chats_has_none() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".cursor");
        assert!(list(&root, &ListBounds::default()).is_err());

        fs::create_dir_all(&root).unwrap();
        let list = list(&root, &ListBounds::default()).unwrap();
        assert!(list.sessions.is_empty());
    }

    #[test]
    fn the_chat_folder_is_the_md5_of_the_path_as_node_resolves_it() {
        for path in [
            "/Users/me/p",
            "/Users/me/p/",
            "/Users/me/./x/../p",
            "//Users//me/p",
        ] {
            assert_eq!(
                chat_folder(path, false),
                "4a5b50f1b58a39358aa381ec846fdec2",
                "{path}"
            );
        }
        assert_eq!(chat_folder("/", false), "6666cd76f96956469e7be39d750cc7d9");
        for path in [
            r"C:\Users\Me\P",
            r"C:\Users\Me\P\",
            "C:/Users/Me/P/",
            r"C:\Users\Me\P\.",
            r"C:\Users\Me\..\Me\P",
        ] {
            assert_eq!(
                chat_folder(path, true),
                "c657348d0d3917486d66bb878a3bf19f",
                "{path}"
            );
        }
        assert_eq!(
            chat_folder(r"C:\", true),
            "2f158c4731d76d5975b8546d85de1b34"
        );
        assert_eq!(
            chat_folder(r"\\server\share\p\", true),
            "cca298731319dadc3bfa62cb68fa0e4d"
        );
        assert_eq!(resolved(r"\\server\share", true), r"\\server\share\");
        assert_eq!(
            resolved(r"c:\Users", true),
            r"c:\Users",
            "the drive as written"
        );
    }

    #[test]
    fn the_store_is_the_cursor_config_directory_of_the_agents_environment() {
        let home = Path::new("/home/me");
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| OsString::from(value))
            }
        };
        assert_eq!(
            config_dir(
                home,
                env(&[("CURSOR_CONFIG_DIR", "/cfg"), ("XDG_CONFIG_HOME", "/xdg")])
            ),
            PathBuf::from("/cfg")
        );
        assert_eq!(
            config_dir(
                home,
                env(&[("CURSOR_CONFIG_DIR", ""), ("XDG_CONFIG_HOME", "/xdg")])
            ),
            PathBuf::from("/xdg/cursor")
        );
        assert_eq!(
            config_dir(home, env(&[])),
            PathBuf::from("/home/me/.cursor")
        );
    }
}
