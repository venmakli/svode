//! The `svode` MCP entry in the user configs of Claude Code
//! (`~/.claude.json`) and Codex (`~/.codex/config.toml`): which kind it is,
//! and writes that keep every other byte the client or the user put there.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::ConnectError;
use crate::machine::{Client, Machine};

/// Environment variable whose value marks an entry the manager owns.
pub const MARKER_ENV: &str = "SVODE_MCP_MANAGED";
/// Marker of an entry written by this manager.
pub const MARKER: &str = "svode-connection-v1";
/// Marker of the MCP-only entry a previous desktop app wrote.
const PREVIOUS_MARKER: &str = "svode-desktop-bridge-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Entry {
    Absent,
    /// Written by this manager; `None` when its launch cannot be read.
    Managed(Option<Launch>),
    /// The MCP-only entry of a previous desktop app: marked with the bridge
    /// identity, or its exact unmarked `svode-mcp --app desktop` launch.
    Previous,
    /// Somebody else's entry named `svode`; never written or removed.
    Custom,
    Unreadable(String),
}

impl Entry {
    /// An entry with a Svode marker, which makes its client connected.
    pub fn is_svode(&self) -> bool {
        matches!(self, Self::Managed(_) | Self::Previous)
    }
}

pub(crate) fn read(machine: &Machine, client: Client) -> Entry {
    let content = match read_text(&machine.mcp_config(client)) {
        Ok(content) => content,
        Err(error) => return Entry::Unreadable(error.message),
    };
    match client {
        Client::ClaudeCode => claude_entry(&content),
        Client::Codex => codex_entry(&content),
    }
}

/// The only entry the manager writes: Codex starts the stable launcher in
/// automatic mode, without arguments and without approval settings.
pub(crate) fn is_canonical(entry: &Entry, launcher: &Path) -> bool {
    matches!(entry, Entry::Managed(Some(launch))
        if Path::new(&launch.command) == launcher && launch.args.is_empty())
}

pub(crate) fn write_codex(machine: &Machine, launcher: &Path) -> Result<(), ConnectError> {
    let path = machine.codex_config();
    let before = read_text(&path)?;
    let cleaned = remove_toml_block(&before);
    let block = codex_block(launcher, true);
    let after = if cleaned.trim().is_empty() {
        block
    } else {
        format!("{}\n\n{}", cleaned.trim_end(), block)
    };
    if !is_canonical(&codex_entry(&after), launcher) {
        return Err(unsupported_form(&path));
    }
    write_if_unchanged(&path, &before, &after)
}

pub(crate) fn remove(machine: &Machine, client: Client) -> Result<(), ConnectError> {
    let path = machine.mcp_config(client);
    let before = read_text(&path)?;
    let after = match client {
        Client::ClaudeCode => remove_claude_entry(&before)?,
        Client::Codex => remove_toml_block(&before),
    };
    let removed = match client {
        Client::ClaudeCode => claude_entry(&after),
        Client::Codex => codex_entry(&after),
    };
    if removed != Entry::Absent {
        return Err(unsupported_form(&path));
    }
    write_if_unchanged(&path, &before, &after)
}

fn unsupported_form(path: &Path) -> ConnectError {
    ConnectError::new(
        "CONFIG_UNSUPPORTED_FORM",
        format!(
            "the svode MCP entry in {} has a form Svode does not edit; nothing was written",
            path.display()
        ),
    )
}

/// Manual Codex config: the same launch, without the marker, so the
/// manager never takes over an entry the user added by hand.
pub(crate) fn codex_block(launcher: &Path, marked: bool) -> String {
    let mut block = format!(
        "[mcp_servers.svode]\ncommand = \"{}\"\n",
        toml_escape(&launcher.to_string_lossy())
    );
    if marked {
        block.push_str(&format!(
            "\n[mcp_servers.svode.env]\n{MARKER_ENV} = \"{MARKER}\"\n"
        ));
    }
    block
}

fn claude_entry(content: &str) -> Entry {
    if content.trim().is_empty() {
        return Entry::Absent;
    }
    let root: Value = match serde_json::from_str(content) {
        Ok(root) => root,
        Err(error) => return Entry::Unreadable(error.to_string()),
    };
    match root
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get("svode"))
    {
        None => Entry::Absent,
        Some(Value::Object(entry)) => classify_json(entry),
        Some(_) => Entry::Custom,
    }
}

fn classify_json(entry: &Map<String, Value>) -> Entry {
    let marker = entry
        .get("env")
        .and_then(Value::as_object)
        .and_then(|env| env.get(MARKER_ENV))
        .and_then(Value::as_str);
    let launch = json_launch(entry);
    let plain = entry
        .keys()
        .all(|key| matches!(key.as_str(), "type" | "command" | "args" | "env"))
        && entry
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(|kind| kind == "stdio")
        && entry
            .get("env")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty);
    classify(marker, launch, plain)
}

fn json_launch(entry: &Map<String, Value>) -> Option<Launch> {
    let command = entry.get("command")?.as_str()?.to_string();
    let args = match entry.get("args") {
        None => Vec::new(),
        Some(args) => args
            .as_array()?
            .iter()
            .map(|arg| arg.as_str().map(str::to_string))
            .collect::<Option<_>>()?,
    };
    Some(Launch { command, args })
}

fn codex_entry(content: &str) -> Entry {
    if content.trim().is_empty() {
        return Entry::Absent;
    }
    let root: toml::Table = match toml::from_str(content) {
        Ok(root) => root,
        Err(error) => return Entry::Unreadable(error.to_string()),
    };
    match root
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .and_then(|servers| servers.get("svode"))
    {
        None => Entry::Absent,
        Some(toml::Value::Table(entry)) => classify_toml(entry),
        Some(_) => Entry::Custom,
    }
}

fn classify_toml(entry: &toml::Table) -> Entry {
    let marker = entry
        .get("env")
        .and_then(toml::Value::as_table)
        .and_then(|env| env.get(MARKER_ENV))
        .and_then(toml::Value::as_str);
    let launch = toml_launch(entry);
    let plain = entry
        .keys()
        .all(|key| matches!(key.as_str(), "command" | "args" | "env"))
        && entry
            .get("env")
            .and_then(toml::Value::as_table)
            .is_none_or(toml::Table::is_empty);
    classify(marker, launch, plain)
}

fn toml_launch(entry: &toml::Table) -> Option<Launch> {
    let command = entry.get("command")?.as_str()?.to_string();
    let args = match entry.get("args") {
        None => Vec::new(),
        Some(args) => args
            .as_array()?
            .iter()
            .map(|arg| arg.as_str().map(str::to_string))
            .collect::<Option<_>>()?,
    };
    Some(Launch { command, args })
}

fn classify(marker: Option<&str>, launch: Option<Launch>, plain: bool) -> Entry {
    match marker {
        Some(MARKER) => Entry::Managed(launch),
        Some(PREVIOUS_MARKER) => Entry::Previous,
        Some(_) => Entry::Custom,
        None if plain && launch.as_ref().is_some_and(is_previous_launch) => Entry::Previous,
        None => Entry::Custom,
    }
}

/// `svode-mcp --app desktop`, as the first desktop apps wrote it unmarked.
fn is_previous_launch(launch: &Launch) -> bool {
    launch.args == ["--app", "desktop"]
        && Path::new(&launch.command)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                let stem = name.strip_suffix(".exe").unwrap_or(name);
                stem.eq_ignore_ascii_case("svode-mcp")
            })
}

/// Whether a project or local entry of `project` overrides the user entry.
pub(crate) fn higher_precedence(
    machine: &Machine,
    client: Client,
) -> Result<Option<PathBuf>, ConnectError> {
    let Some(project) = machine.project.as_deref() else {
        return Ok(None);
    };
    match client {
        Client::ClaudeCode => {
            let shared = project.join(".mcp.json");
            if json_root(&shared)?
                .get("mcpServers")
                .and_then(Value::as_object)
                .is_some_and(|servers| servers.contains_key("svode"))
            {
                return Ok(Some(shared));
            }
            let user = machine.claude_config();
            let local = json_root(&user)?
                .get("projects")
                .and_then(Value::as_object)
                .and_then(|projects| projects.get(project.to_string_lossy().as_ref()))
                .and_then(|project| project.get("mcpServers"))
                .and_then(Value::as_object)
                .is_some_and(|servers| servers.contains_key("svode"));
            Ok(local.then_some(user))
        }
        Client::Codex => {
            let path = project.join(".codex").join("config.toml");
            let content = read_text(&path)?;
            if content.trim().is_empty() {
                return Ok(None);
            }
            let root: toml::Table = toml::from_str(&content)
                .map_err(|error| ConnectError::new("CONFIG_UNREADABLE", error.to_string()))?;
            let found = root
                .get("mcp_servers")
                .and_then(toml::Value::as_table)
                .is_some_and(|servers| servers.contains_key("svode"));
            Ok(found.then_some(path))
        }
    }
}

fn json_root(path: &Path) -> Result<Value, ConnectError> {
    let content = read_text(path)?;
    if content.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&content).map_err(|error| {
        ConnectError::new("CONFIG_UNREADABLE", format!("{}: {error}", path.display()))
    })
}

fn remove_claude_entry(content: &str) -> Result<String, ConnectError> {
    if content.trim().is_empty() {
        return Ok(content.to_string());
    }
    let mut root: Value = serde_json::from_str(content)
        .map_err(|error| ConnectError::new("CONFIG_UNREADABLE", error.to_string()))?;
    if let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
        servers.remove("svode");
    }
    let text = serde_json::to_string_pretty(&root)
        .map_err(|error| ConnectError::new("CONFIG_UNREADABLE", error.to_string()))?;
    Ok(format!("{text}\n"))
}

/// Drops the `[mcp_servers.svode]` table and its subtables, line by line,
/// keeping comments and formatting of everything else.
fn remove_toml_block(input: &str) -> String {
    let mut output = Vec::new();
    let mut skipping = false;
    for line in input.lines() {
        let trimmed = line.trim();
        if is_svode_table(trimmed) {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            output.push(line);
        }
    }
    // The blank lines that separated the block from the content before it
    // go with the block when it was last.
    let mut text = output.join("\n").trim_end_matches('\n').to_string();
    if input.ends_with('\n') && !text.is_empty() {
        text.push('\n');
    }
    text
}

fn is_svode_table(trimmed: &str) -> bool {
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return false;
    }
    let table = trimmed.trim_start_matches('[').trim_end_matches(']').trim();
    table == "mcp_servers.svode" || table.starts_with("mcp_servers.svode.")
}

pub(crate) fn read_text(path: &Path) -> Result<String, ConnectError> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(ConnectError::new(
            "CONFIG_UNREADABLE",
            format!("{}: {error}", path.display()),
        )),
    }
}

/// Writes `after` only if the file still holds `before`: an edit the client
/// or the user made meanwhile is never overwritten.
fn write_if_unchanged(path: &Path, before: &str, after: &str) -> Result<(), ConnectError> {
    if read_text(path)? != before {
        return Err(ConnectError::new(
            "CONFIG_CHANGED",
            format!(
                "{} changed while Svode was editing it; nothing was written, try again",
                path.display()
            ),
        ));
    }
    if before == after {
        return Ok(());
    }
    atomic_write(path, after.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ConnectError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|error| ConnectError::io(parent, error))?;
    let temp = parent.join(format!(".svode-connect-{}.tmp", unique()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(ConnectError::io(path, error));
    }
    Ok(())
}

fn unique() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos:x}{:x}", std::process::id())
}

fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAUNCHER: &str = "/home/u/.svode/bin/svode-mcp";

    #[test]
    fn previous_desktop_entries_are_recognized_marked_or_unmarked() {
        let marked = format!(
            "[mcp_servers.svode]\ncommand = \"/Applications/Svode.app/Contents/MacOS/svode-mcp\"\nargs = [\"--app\", \"desktop\"]\n\n[mcp_servers.svode.env]\n{MARKER_ENV} = \"{PREVIOUS_MARKER}\"\n"
        );
        assert_eq!(codex_entry(&marked), Entry::Previous);
        let unmarked =
            "[mcp_servers.svode]\ncommand = \"/opt/svode-mcp\"\nargs = [\"--app\", \"desktop\"]\n";
        assert_eq!(codex_entry(unmarked), Entry::Previous);
        let claude = r#"{"mcpServers":{"svode":{"type":"stdio","command":"/x/svode-mcp","args":["--app","desktop"],"env":{}}}}"#;
        assert_eq!(claude_entry(claude), Entry::Previous);
    }

    #[test]
    fn custom_entries_stay_custom() {
        for custom in [
            "[mcp_servers.svode]\ncommand = \"custom-wrapper\"\nargs = []\n",
            "[mcp_servers.svode]\ncommand = \"/x/svode-mcp\"\nargs = [\"--project\", \"/p\"]\n",
            "[mcp_servers.svode]\ncommand = \"/x/svode-mcp\"\nargs = [\"--app\", \"desktop\"]\ndefault_tools_approval_mode = \"approve\"\n",
            "[mcp_servers.svode]\ncommand = \"/x\"\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED = \"mine\"\n",
        ] {
            assert_eq!(codex_entry(custom), Entry::Custom, "{custom}");
        }
    }

    #[test]
    fn the_codex_block_is_canonical_and_carries_no_approval_setting() {
        let block = codex_block(Path::new(LAUNCHER), true);
        assert!(is_canonical(&codex_entry(&block), Path::new(LAUNCHER)));
        assert!(!block.contains("approval"));
        assert!(!block.contains("args"));
        let manual = codex_block(Path::new(LAUNCHER), false);
        assert!(!manual.contains(MARKER_ENV));
        assert_eq!(codex_entry(&manual), Entry::Custom);
    }

    #[test]
    fn removing_the_svode_tables_keeps_everything_else() {
        let input = "# top\n[x]\na=1\n[mcp_servers.svode]\ncommand=\"old\"\nargs=[]\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED=\"old\"\n[y]\nb=2\n";
        assert_eq!(remove_toml_block(input), "# top\n[x]\na=1\n[y]\nb=2\n");
    }

    #[test]
    fn paths_are_escaped_in_toml() {
        let block = codex_block(Path::new(r#"C:\Svode "A"\svode-mcp.exe"#), true);
        match codex_entry(&block) {
            Entry::Managed(Some(launch)) => {
                assert_eq!(launch.command, r#"C:\Svode "A"\svode-mcp.exe"#)
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_concurrent_external_edit_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.toml");
        fs::write(&path, "before").unwrap();
        let before = read_text(&path).unwrap();
        fs::write(&path, "external").unwrap();
        let error = write_if_unchanged(&path, &before, "svode").unwrap_err();
        assert_eq!(error.code, "CONFIG_CHANGED");
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }
}
