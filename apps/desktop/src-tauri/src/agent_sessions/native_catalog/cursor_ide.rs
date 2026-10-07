//! The chats of the Cursor IDE (Stage 10 `07` N2, N3, N7): their headers
//! in `User/globalStorage/state.vscdb` of the app data, the table
//! `composerHeaders`, else the earlier blob `composer.composerHeaders` of
//! `ItemTable`. Only the header fields are read; the chats' data, their
//! conversation records and the conversation search stay unread. A chat
//! continues only in the IDE: neither the chat of Svode nor a terminal
//! opens it.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat};
use serde::Deserialize;
use serde_json::Value;
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};
use svode_agents::catalog::{ListBounds, ListedSession};
use svode_agents::identity::{IdentityNamespace, SessionKey};
use svode_core::agent_adapters::AgentAdapterKind;

use super::{CatalogEntry, NativeList, NativeListing, bounded};
use crate::agent_sessions::native_status::sqlite::{read_only, table_columns};

/// The columns of `composerHeaders` the reader needs (N5, N7).
const HEADER_COLUMNS: [&str; 5] = [
    "composerId",
    "lastUpdatedAt",
    "isArchived",
    "isSubagent",
    "value",
];

/// The key of the blob of headers the IDE kept before the table.
const HEADERS_KEY: &str = "composer.composerHeaders";

/// A workspace file larger than this is not read.
const WORKSPACE_BYTES: u64 = 1024 * 1024;

/// At most this many folders of a workspace file are kept.
const WORKSPACE_FOLDERS: usize = 256;

/// The app data folder of the Cursor IDE: `Cursor` in the application
/// support folder on macOS, in `APPDATA` on Windows and in
/// `XDG_CONFIG_HOME`, else `~/.config`, on Linux (N7).
pub(crate) fn app_data_dir(home: &Path, var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    app_data_dir_on(home, var, std::env::consts::OS)
}

fn app_data_dir_on(home: &Path, var: impl Fn(&str) -> Option<OsString>, os: &str) -> PathBuf {
    let var = |name: &str| var(name).filter(|value| !value.is_empty());
    let app_data = match os {
        "macos" => home.join("Library").join("Application Support"),
        "windows" => var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming")),
        _ => var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config")),
    };
    app_data.join("Cursor")
}

/// The fields of a chat header the reader keeps (N3).
struct Header {
    id: Option<String>,
    updated_at: Option<i64>,
    archived: Option<bool>,
    subagent: Option<bool>,
    draft: Option<bool>,
    /// The header's JSON is readable.
    readable: bool,
    name: Option<String>,
    /// The folder of a one-folder workspace and its URI scheme.
    folder: Option<(String, Option<String>)>,
    /// The `.code-workspace` file of a multi-root workspace and its URI
    /// scheme.
    workspace: Option<(String, Option<String>)>,
}

/// The IDE chats the catalogue lists (N2, N7): not a draft, archived or of
/// a subagent, with a time and a folder; the newest first within the
/// bounds. A chat of a multi-root workspace lists the folders of its file
/// and has none once the file is gone. Without the app data folder the IDE
/// has no chats; a store without the table and the blob of headers fails
/// the source.
pub(super) fn list(root: &Path, bounds: &ListBounds) -> Result<NativeList, String> {
    if !root.is_dir() {
        return Ok(NativeList::default());
    }
    let db = root.join("User").join("globalStorage").join("state.vscdb");
    if !db.is_file() {
        return Err(format!("no chat store of the Cursor IDE {}", db.display()));
    }
    let headers = read_only(&db, |connection| Box::pin(headers(connection)))
        .map_err(|error| format!("{}: {error}", db.display()))?
        .map_err(|problem| format!("{}: {problem}", db.display()))?;

    let mut workspaces = HashMap::new();
    let mut chats = Vec::new();
    let mut skipped = 0;
    for header in headers {
        let (Some(id), true, Some(archived), Some(subagent), Some(draft)) = (
            header.id.filter(|id| !id.is_empty()),
            header.readable,
            header.archived,
            header.subagent,
            header.draft,
        ) else {
            skipped += 1;
            continue;
        };
        if archived || subagent || draft {
            continue;
        }
        let Some(updated_at) = header.updated_at else {
            continue;
        };
        let Some(updated_at) = DateTime::from_timestamp_millis(updated_at) else {
            skipped += 1;
            continue;
        };
        let folders = if let Some(folder) = header.folder.and_then(local) {
            vec![PathBuf::from(folder)]
        } else if let Some(file) = header.workspace.and_then(local) {
            workspaces
                .entry(file.clone())
                .or_insert_with(|| workspace_folders(Path::new(&file)))
                .clone()
        } else {
            continue;
        };
        let mut folders = folders
            .into_iter()
            .filter(|folder| folder.is_absolute() && folder.as_os_str().len() <= bounds.cwd_bytes);
        let Some(cwd) = folders.next() else {
            continue;
        };
        chats.push((
            updated_at,
            CatalogEntry {
                listed: ListedSession {
                    key: SessionKey {
                        agent: AgentAdapterKind::Cursor.as_str().to_string(),
                        namespace: IdentityNamespace::Ide,
                        session_id: id.clone(),
                    },
                    cwd,
                    title: header
                        .name
                        .map(|name| bounded(name.trim(), bounds.title_bytes).to_string()),
                    updated_at: Some(updated_at.to_rfc3339_opts(SecondsFormat::Secs, true)),
                },
                listing: Some(NativeListing {
                    resume_id: id,
                    profile: None,
                    opens_in_chat: false,
                    continues_in_terminal: false,
                    aliases: Vec::new(),
                    folders: folders.collect(),
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

/// The path of a local file URI's `fsPath`; none for a remote one.
fn local((path, scheme): (String, Option<String>)) -> Option<String> {
    (scheme.is_none_or(|scheme| scheme == "file") && !path.is_empty()).then_some(path)
}

/// The chat headers: the table, else the earlier blob; neither, or a table
/// without a needed column, is a problem of the store's format (N5, N7).
async fn headers(
    connection: &mut SqliteConnection,
) -> Result<Result<Vec<Header>, String>, sqlx::Error> {
    let columns = table_columns(connection, "composerHeaders").await?;
    let (source, blob) = if !columns.is_empty() {
        if let Some(missing) = HEADER_COLUMNS
            .iter()
            .find(|column| !columns.contains(**column))
        {
            return Ok(Err(format!(
                "composerHeaders has no column {missing}, not the format Svode reads"
            )));
        }
        (
            "SELECT composerId AS id,
                    CAST(lastUpdatedAt AS INTEGER) AS updated,
                    COALESCE(isArchived, 0) AS archived,
                    COALESCE(isSubagent, 0) AS subagent,
                    CASE WHEN json_valid(CAST(value AS TEXT)) THEN CAST(value AS TEXT) END AS v
             FROM composerHeaders",
            false,
        )
    } else {
        if !table_columns(connection, "ItemTable")
            .await?
            .contains("value")
        {
            return Ok(Err(
                "neither composerHeaders nor ItemTable, not the format Svode reads".to_string(),
            ));
        }
        let headers = sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE WHEN json_valid(CAST(value AS TEXT))
                         THEN json_type(CAST(value AS TEXT), '$.allComposers') END
             FROM ItemTable WHERE key = ?",
        )
        .bind(HEADERS_KEY)
        .fetch_optional(&mut *connection)
        .await?
        .flatten();
        if headers.as_deref() != Some("array") {
            return Ok(Err(format!(
                "neither composerHeaders nor a readable {HEADERS_KEY}, not the format Svode reads"
            )));
        }
        // The blob alone is parsed, not the other values of the table.
        (
            "WITH blob AS MATERIALIZED (
                 SELECT CAST(value AS TEXT) AS headers FROM ItemTable WHERE key = ?
             ),
             headers AS (
                 SELECT CASE WHEN c.type = 'object' THEN c.value END AS h
                 FROM blob, json_each(blob.headers, '$.allComposers') AS c
             )
             SELECT json_extract(h, '$.composerId') AS id,
                    CAST(json_extract(h, '$.lastUpdatedAt') AS INTEGER) AS updated,
                    COALESCE(json_extract(h, '$.isArchived'), 0) AS archived,
                    COALESCE(json_extract(h, '$.isSubagent'), 0) AS subagent,
                    h AS v
             FROM headers",
            true,
        )
    };
    let query = format!(
        "SELECT id, updated, archived, subagent, v IS NOT NULL,
                json_extract(v, '$.name'),
                COALESCE(json_extract(v, '$.isDraft'), 0),
                json_extract(v, '$.workspaceIdentifier.uri.fsPath'),
                json_extract(v, '$.workspaceIdentifier.uri.scheme'),
                json_extract(v, '$.workspaceIdentifier.configPath.fsPath'),
                json_extract(v, '$.workspaceIdentifier.configPath.scheme')
         FROM ({source})"
    );
    let mut query = sqlx::query(&query);
    if blob {
        query = query.bind(HEADERS_KEY);
    }
    let rows = query.fetch_all(&mut *connection).await?;
    Ok(Ok(rows.iter().map(header).collect()))
}

/// A header from its row; a field of another type than the reader knows
/// reads as missing.
fn header(row: &SqliteRow) -> Header {
    let text = |index: usize| row.try_get::<Option<String>, _>(index).ok().flatten();
    let flag = |index: usize| {
        row.try_get::<i64, _>(index)
            .ok()
            .filter(|value| matches!(value, 0 | 1))
            .map(|value| value == 1)
    };
    let path = |index: usize| text(index).map(|path| (path, text(index + 1)));
    Header {
        id: text(0),
        updated_at: row.try_get::<Option<i64>, _>(1).ok().flatten(),
        archived: flag(2),
        subagent: flag(3),
        readable: flag(4) == Some(true),
        name: text(5),
        draft: flag(6),
        folder: path(7),
        workspace: path(9),
    }
}

/// The only part of a `.code-workspace` file the reader keeps (N3).
#[derive(Deserialize)]
struct WorkspaceFile {
    folders: Option<Vec<Value>>,
}

/// The folders of a `.code-workspace` file in its order, as the IDE opens
/// them: a `path` relative to the file's folder or absolute, a `file` URI;
/// none when the file is gone or not a workspace. Only the list of folders
/// is kept of the file (N3).
fn workspace_folders(file: &Path) -> Vec<PathBuf> {
    let Some(text) = read_bounded(file) else {
        return Vec::new();
    };
    let Ok(WorkspaceFile {
        folders: Some(folders),
    }) = jsonc_parser::parse_to_serde_value::<WorkspaceFile>(
        text.trim_start_matches('\u{feff}'),
        &jsonc_parser::ParseOptions::default(),
    )
    else {
        return Vec::new();
    };
    let base = file.parent().unwrap_or(Path::new(""));
    let mut seen = HashSet::new();
    folders
        .iter()
        .filter_map(|folder| {
            if let Some(path) = folder.get("path").and_then(Value::as_str) {
                return (!path.is_empty()).then(|| base.join(path));
            }
            let uri = url::Url::parse(folder.get("uri")?.as_str()?).ok()?;
            (uri.scheme() == "file")
                .then(|| uri.to_file_path().ok())
                .flatten()
        })
        .filter(|folder| seen.insert(folder.clone()))
        .take(WORKSPACE_FOLDERS)
        .collect()
}

fn read_bounded(file: &Path) -> Option<String> {
    let mut text = String::new();
    fs::File::open(file)
        .ok()?
        .take(WORKSPACE_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= WORKSPACE_BYTES).then_some(text)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::Connection;
    use sqlx::sqlite::SqliteConnectOptions;

    /// The tables of the store that hold the chats' data and conversations,
    /// as views that fail when they are read: a read that touched them
    /// would fail the source.
    const CONVERSATIONS: &str = "
        CREATE VIEW cursorDiskKV AS SELECT 'composerData:c1' AS key, json('{') AS value;
        CREATE VIEW composerData AS SELECT json('{') AS value;
    ";

    pub(crate) const HEADERS_TABLE: &str = "
        CREATE TABLE composerHeaders (
            composerId TEXT PRIMARY KEY,
            workspaceId TEXT,
            createdAt INTEGER,
            lastUpdatedAt INTEGER,
            isArchived INTEGER,
            isSubagent INTEGER,
            recency INTEGER,
            checkpointAt INTEGER,
            hasBlockingPendingActions INTEGER,
            value TEXT
        );
    ";

    const ITEM_TABLE: &str =
        "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);";

    /// A store of the IDE under the app data folder `root` with this SQL.
    pub(crate) fn store(root: &Path, sql: &str) {
        let db = root.join("User/globalStorage/state.vscdb");
        fs::create_dir_all(db.parent().unwrap()).unwrap();
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(&db)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
            sqlx::raw_sql(&format!("{CONVERSATIONS}{sql}"))
                .execute(&mut connection)
                .await
                .unwrap();
            connection.close().await.unwrap();
        });
    }

    /// A row of `composerHeaders`: its flags and JSON value.
    pub(crate) fn row(id: &str, updated: Option<i64>, flags: (i64, i64), value: &Value) -> String {
        let updated = updated.map_or("NULL".to_string(), |updated| updated.to_string());
        format!(
            "INSERT INTO composerHeaders (composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value)
             VALUES ('{id}', 1800000000000, {updated}, {}, {}, '{}');",
            flags.0,
            flags.1,
            value.to_string().replace('\'', "''")
        )
    }

    /// The header value of a chat in a one-folder workspace.
    pub(crate) fn in_folder(name: &str, folder: &Path) -> Value {
        json!({
            "name": name,
            "isDraft": false,
            "workspaceIdentifier": {
                "id": "w",
                "uri": { "$mid": 1, "fsPath": folder, "external": "file:///", "path": "/", "scheme": "file" }
            }
        })
    }

    /// The header value of a chat in the multi-root workspace of `file`.
    pub(crate) fn in_workspace(name: &str, file: &Path) -> Value {
        json!({
            "name": name,
            "workspaceIdentifier": {
                "id": "m",
                "configPath": { "$mid": 1, "fsPath": file, "scheme": "file" }
            }
        })
    }

    fn with(mut value: Value, field: &str, field_value: Value) -> Value {
        value[field] = field_value;
        value
    }

    fn ids(list: &NativeList) -> Vec<&str> {
        list.sessions
            .iter()
            .map(|entry| entry.listed.key.session_id.as_str())
            .collect()
    }

    #[test]
    fn the_catalogue_lists_the_ide_chats_that_are_no_draft_archive_or_subagent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Cursor");
        let folder = temp.path().join("w");
        let chat = in_folder("  Fix the build  ", &folder);
        store(
            &root,
            &[
                HEADERS_TABLE.to_string(),
                row("listed", Some(1_800_000_100_000), (0, 0), &chat),
                row("older", Some(1_800_000_050_000), (0, 0), &chat),
                row("archived", Some(1_800_000_100_000), (1, 0), &chat),
                row("subagent", Some(1_800_000_100_000), (0, 1), &chat),
                row(
                    "draft",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &with(chat.clone(), "isDraft", json!(true)),
                ),
                row("no-time", None, (0, 0), &chat),
                row(
                    "no-folder",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &json!({ "name": "Empty window" }),
                ),
                row(
                    "remote",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &json!({ "workspaceIdentifier": { "uri": { "fsPath": "/w", "scheme": "vscode-remote" } } }),
                ),
                row(
                    "relative",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &in_folder("Relative", Path::new("w")),
                ),
            ]
            .concat(),
        );

        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(ids(&list), ["listed", "older"], "the newest first");
        assert_eq!(list.skipped, 0);
        let listed = &list.sessions[0];
        assert_eq!(listed.listed.key.agent, "cursor");
        assert_eq!(listed.listed.key.namespace, IdentityNamespace::Ide);
        assert_eq!(listed.listed.cwd, folder);
        assert_eq!(listed.listed.title.as_deref(), Some("Fix the build"));
        assert_eq!(
            listed.listed.updated_at.as_deref(),
            Some("2027-01-15T08:01:40Z")
        );
        let listing = listed.listing.as_ref().unwrap();
        assert!(!listing.opens_in_chat, "ACP does not load an IDE chat");
        assert!(!listing.continues_in_terminal, "no terminal continues it");
        assert!(listing.folders.is_empty());

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
    fn the_data_and_conversations_of_the_chats_are_never_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Cursor");
        let folder = temp.path().join("w");
        store(
            &root,
            &[
                HEADERS_TABLE.to_string(),
                row(
                    "listed",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &in_folder("A", &folder),
                ),
            ]
            .concat(),
        );
        let db = root.join("User/globalStorage/state.vscdb");
        for table in ["cursorDiskKV", "composerData"] {
            let read = read_only(&db, |connection| {
                Box::pin(async move {
                    sqlx::query(&format!("SELECT * FROM {table}"))
                        .fetch_all(&mut *connection)
                        .await
                })
            });
            assert!(read.is_err(), "a read of {table} fails the fixture");
        }
        assert_eq!(
            ids(&list(&root, &ListBounds::default()).unwrap()),
            ["listed"]
        );
    }

    #[test]
    fn without_the_table_the_earlier_blob_of_headers_lists_the_chats() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Cursor");
        let folder = temp.path().join("w");
        let header = |id: &str, extra: Value| {
            let mut header = in_folder(id, &folder);
            header["composerId"] = json!(id);
            header["lastUpdatedAt"] = json!(1_800_000_100_000_i64);
            for (field, value) in extra.as_object().unwrap() {
                header[field] = value.clone();
            }
            header
        };
        let blob = json!({
            "allComposers": [
                header("listed", json!({})),
                header("archived", json!({ "isArchived": true })),
                header("draft", json!({ "isDraft": true })),
                header("subagent", json!({ "isSubagent": true })),
                json!("not a header"),
            ],
            "selectedComposerIds": ["listed"]
        });
        store(
            &root,
            &format!(
                "{ITEM_TABLE}
                 INSERT INTO ItemTable VALUES ('{HEADERS_KEY}', '{blob}');
                 INSERT INTO ItemTable VALUES ('composerData:x', 'not json');
                 INSERT INTO ItemTable VALUES ('workbench.panel', '{{}}');"
            ),
        );

        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(ids(&list), ["listed"]);
        assert_eq!(list.skipped, 1, "the entry that is no header");
        assert_eq!(
            list.sessions[0].listed.key.namespace,
            IdentityNamespace::Ide
        );
        assert_eq!(list.sessions[0].listed.cwd, folder);
    }

    #[test]
    fn a_store_without_the_table_and_the_blob_of_headers_fails_the_source() {
        let cases = [
            ITEM_TABLE.to_string(),
            format!(
                "{ITEM_TABLE} INSERT INTO ItemTable VALUES ('{HEADERS_KEY}', '{{\"other\": []}}');"
            ),
            format!("{ITEM_TABLE} INSERT INTO ItemTable VALUES ('{HEADERS_KEY}', 'not json');"),
            "CREATE TABLE other (x);".to_string(),
            "CREATE TABLE composerHeaders (composerId TEXT, lastUpdatedAt INTEGER, value TEXT);"
                .to_string(),
        ];
        for sql in cases {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("Cursor");
            store(&root, &sql);
            let error = list(&root, &ListBounds::default()).unwrap_err();
            assert!(
                error.contains("not the format Svode reads"),
                "{sql}: {error}"
            );
        }
    }

    #[test]
    fn a_missing_store_fails_the_source_and_no_app_data_has_no_chats() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Cursor");
        let list_of = |root: &Path| list(root, &ListBounds::default());
        assert!(
            list_of(&root).unwrap().sessions.is_empty(),
            "the IDE is not installed"
        );
        fs::create_dir_all(&root).unwrap();
        assert!(list_of(&root).unwrap_err().contains("no chat store"));
    }

    #[test]
    fn a_header_of_unreadable_fields_is_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Cursor");
        let folder = temp.path().join("w");
        store(
            &root,
            &[
                HEADERS_TABLE.to_string(),
                row("listed", Some(1_800_000_100_000), (0, 0), &in_folder("A", &folder)),
                row("flag", Some(1_800_000_100_000), (7, 0), &in_folder("B", &folder)),
                "INSERT INTO composerHeaders (composerId, lastUpdatedAt, isArchived, isSubagent, value)
                 VALUES ('broken', 1800000100000, 0, 0, '{\"name\": ');"
                    .to_string(),
                "INSERT INTO composerHeaders (composerId, lastUpdatedAt, isArchived, isSubagent, value)
                 VALUES ('', 1800000100000, 0, 0, '{}');"
                    .to_string(),
            ]
            .concat(),
        );
        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(ids(&list), ["listed"]);
        assert_eq!(list.skipped, 3);
    }

    #[test]
    fn a_chat_of_a_multi_root_workspace_lists_the_folders_of_its_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Cursor");
        let files = temp.path().join("workspaces");
        fs::create_dir_all(&files).unwrap();
        let file = files.join("work.code-workspace");
        let absolute = temp.path().join("abs");
        fs::write(
            &file,
            format!(
                "// Folders of the work
                {{
                    \"folders\": [
                        {{ \"path\": \"../p\", \"name\": \"Project\" }},
                        {{ \"path\": {absolute} }},
                        {{ \"uri\": \"vscode-remote://ssh-remote+box/home\" }},
                        {{ \"path\": \"../p\" }},
                        {{ \"path\": \"\" }},
                    ],
                    \"settings\": {{ \"secret\": \"kept out\" }},
                }}",
                absolute = json!(absolute)
            ),
        )
        .unwrap();
        let uri_file = files.join("uri.code-workspace");
        let by_uri = temp.path().join("by uri");
        fs::write(
            &uri_file,
            json!({ "folders": [{ "uri": url::Url::from_file_path(&by_uri).unwrap().as_str() }] })
                .to_string(),
        )
        .unwrap();
        store(
            &root,
            &[
                HEADERS_TABLE.to_string(),
                row(
                    "multi",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &in_workspace("M", &file),
                ),
                row(
                    "same-file",
                    Some(1_800_000_090_000),
                    (0, 0),
                    &in_workspace("S", &file),
                ),
                row(
                    "by-uri",
                    Some(1_800_000_080_000),
                    (0, 0),
                    &in_workspace("U", &uri_file),
                ),
                row(
                    "deleted",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &in_workspace("D", &files.join("gone.code-workspace")),
                ),
                row(
                    "not-a-workspace",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &in_workspace("N", &temp.path().join("abs")),
                ),
            ]
            .concat(),
        );

        let list = list(&root, &ListBounds::default()).unwrap();
        assert_eq!(
            ids(&list),
            ["multi", "same-file", "by-uri"],
            "a chat of a deleted workspace file is not listed"
        );
        let multi = &list.sessions[0];
        assert_eq!(multi.listed.cwd, files.join("../p"), "relative to the file");
        assert_eq!(multi.listing.as_ref().unwrap().folders, [absolute]);
        assert_eq!(list.sessions[2].listed.cwd, by_uri);
    }

    #[test]
    fn the_app_data_of_the_ide_is_where_each_system_keeps_it() {
        let home = Path::new("/home/me");
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| OsString::from(value))
            }
        };
        let xdg: &[(&str, &str)] = &[("XDG_CONFIG_HOME", "/xdg"), ("APPDATA", "/roaming")];
        assert_eq!(
            app_data_dir_on(home, env(xdg), "macos"),
            PathBuf::from("/home/me/Library/Application Support/Cursor")
        );
        assert_eq!(
            app_data_dir_on(home, env(xdg), "linux"),
            PathBuf::from("/xdg/Cursor")
        );
        assert_eq!(
            app_data_dir_on(home, env(&[("XDG_CONFIG_HOME", "")]), "linux"),
            PathBuf::from("/home/me/.config/Cursor")
        );
        assert_eq!(
            app_data_dir_on(home, env(xdg), "windows"),
            PathBuf::from("/roaming/Cursor")
        );
        assert_eq!(
            app_data_dir_on(home, env(&[]), "windows"),
            home.join("AppData").join("Roaming").join("Cursor")
        );
    }
}
