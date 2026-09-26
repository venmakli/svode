//! The manager on a temporary home with a real stable location, installed
//! by `svode-install` from a desktop bundle or a standalone archive whose
//! binaries are scripts.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use svode_install::{DesktopRuntime, Layout, take_desktop_ownership};
use tempfile::TempDir;

use crate::{Client, Machine, connect, disconnect, reconcile, status};

const PREVIOUS: &str = "svode-desktop-bridge-v1";

struct Home {
    _dir: TempDir,
    home: PathBuf,
    bundle: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let bundle = dir.path().join("Applications/Svode.app/Contents/MacOS");
        fs::create_dir_all(&home).unwrap();
        Self {
            _dir: dir,
            home,
            bundle,
        }
    }

    /// Home with the desktop app owning the stable location.
    fn with_desktop() -> Self {
        let home = Self::new();
        let payload = home.bundle.join("../Resources/plugins/svode");
        runtime_files(&home.bundle, &payload, "0.0.9");
        take_desktop_ownership(
            &Layout::at(home.home.join(".svode")),
            &DesktopRuntime {
                binaries: &home.bundle,
                payload: &payload,
                version: "0.0.9",
            },
        )
        .unwrap();
        home
    }

    fn machine(&self) -> Machine {
        self.machine_for(None)
    }

    fn machine_for(&self, project: Option<&Path>) -> Machine {
        Machine::at(self.home.clone())
            .with_project(project)
            .with_policies(
                vec![self.home.join("policy/managed-settings.json")],
                self.home.join("policy/requirements.toml"),
            )
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path(relative)).unwrap_or_default()
    }

    fn link(&self, relative: &str) -> Option<PathBuf> {
        fs::read_link(self.path(relative)).ok()
    }

    fn launcher(&self) -> PathBuf {
        self.path(".svode/bin/svode-mcp")
    }

    fn previous_entries(&self) {
        let bundle_mcp = self.bundle.join("svode-mcp");
        self.write(
            ".claude.json",
            &serde_json::to_string_pretty(&json!({
                "theme": "dark",
                "mcpServers": {
                    "other": { "type": "http", "url": "https://example.com" },
                    "svode": {
                        "type": "stdio",
                        "command": bundle_mcp,
                        "args": ["--app", "desktop"],
                        "env": { "SVODE_MCP_MANAGED": PREVIOUS },
                    },
                },
            }))
            .unwrap(),
        );
        self.write(
            ".codex/config.toml",
            &format!(
                "# keep me\nmodel = \"gpt-5.5\"\n\n[projects.\"/work\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.svode]\ncommand = \"{}\"\nargs = [\"--app\", \"desktop\"]\n\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED = \"{PREVIOUS}\"\n\n[mcp_servers.other]\ncommand = \"other\"\n",
                bundle_mcp.display()
            ),
        );
    }
}

fn runtime_files(binaries: &Path, payload: &Path, version: &str) {
    fs::create_dir_all(binaries).unwrap();
    for name in svode_install::RUNTIME_BINARIES {
        let path = binaries.join(name);
        fs::write(&path, format!("#!/bin/sh\necho \"{name} {version} $*\"\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::create_dir_all(payload.join(".claude-plugin")).unwrap();
    fs::create_dir_all(payload.join("skills/svode")).unwrap();
    fs::write(
        payload.join(".claude-plugin/plugin.json"),
        format!("{{\"name\":\"svode\",\"version\":\"{version}\"}}"),
    )
    .unwrap();
    fs::write(
        payload.join("skills/svode/SKILL.md"),
        "---\nname: svode\n---\n",
    )
    .unwrap();
}

fn client(status: &crate::Status, client: Client) -> crate::ClientStatus {
    status
        .clients
        .iter()
        .find(|candidate| candidate.id == client.as_str())
        .unwrap()
        .clone()
}

#[test]
fn connecting_claude_code_links_the_plugin_and_writes_no_mcp_entry() {
    let home = Home::with_desktop();
    home.write(".claude.json", "{\"theme\":\"dark\"}");

    assert!(connect(&home.machine(), Client::ClaudeCode).unwrap());

    assert_eq!(
        home.link(".claude/skills/svode").unwrap(),
        home.path(".svode/current/plugins/svode")
    );
    let config: Value = serde_json::from_str(&home.read(".claude.json")).unwrap();
    assert_eq!(config, json!({ "theme": "dark" }));
    let status = client(&status(&home.machine(), &[], None), Client::ClaudeCode);
    assert!(status.installed && status.complete, "{status:?}");
    assert_eq!(status.status, "installed");
    assert_eq!(status.version.as_deref(), Some("0.0.9"));
    // Connecting again changes nothing.
    assert!(!connect(&home.machine(), Client::ClaudeCode).unwrap());
}

#[test]
fn connecting_codex_links_the_shared_skill_and_starts_the_launcher_in_automatic_mode() {
    let home = Home::with_desktop();
    let original =
        "# mine\nmodel = \"gpt-5.5\"\n\n[projects.\"/work\"]\ntrust_level = \"trusted\"\n";
    home.write(".codex/config.toml", original);

    assert!(connect(&home.machine(), Client::Codex).unwrap());

    assert_eq!(
        home.link(".agents/skills/svode").unwrap(),
        home.path(".svode/current/plugins/svode/skills/svode")
    );
    let config = home.read(".codex/config.toml");
    assert!(config.starts_with(original.trim_end()), "{config}");
    let parsed: toml::Table = toml::from_str(&config).unwrap();
    let entry = &parsed["mcp_servers"]["svode"];
    assert_eq!(
        entry["command"].as_str().unwrap(),
        home.launcher().to_str().unwrap()
    );
    assert!(entry.get("args").is_none());
    assert_eq!(
        entry["env"]["SVODE_MCP_MANAGED"].as_str(),
        Some(crate::MARKER)
    );
    assert!(!config.contains("approval"));
    assert!(client(&status(&home.machine(), &[], None), Client::Codex).complete);
}

#[test]
fn a_previous_desktop_entry_becomes_a_full_connection_without_reenabling() {
    let home = Home::with_desktop();
    home.previous_entries();

    let (changed, errors) = reconcile(&home.machine());
    assert!(changed && errors.is_empty(), "{errors:?}");

    // Claude Code: the plugin brings MCP, the user entry is gone, the rest
    // of the config stays.
    assert!(home.link(".claude/skills/svode").is_some());
    let claude: Value = serde_json::from_str(&home.read(".claude.json")).unwrap();
    assert_eq!(claude["theme"], "dark");
    assert_eq!(claude["mcpServers"]["other"]["url"], "https://example.com");
    assert!(claude["mcpServers"].get("svode").is_none());
    // Codex: the managed entry starts the launcher, foreign content stays.
    assert!(home.link(".agents/skills/svode").is_some());
    let codex = home.read(".codex/config.toml");
    assert!(codex.contains("# keep me") && codex.contains("trust_level = \"trusted\""));
    assert!(codex.contains("[mcp_servers.other]"));
    assert!(codex.contains(home.launcher().to_str().unwrap()));
    // Nothing refers into the app bundle.
    for text in [home.read(".claude.json"), codex] {
        assert!(!text.contains("Svode.app"), "{text}");
    }
    let status = status(&home.machine(), &[], None);
    for client in &status.clients {
        assert_eq!(client.status, "installed", "{client:?}");
    }

    // A second reconcile writes nothing.
    let before = (home.read(".claude.json"), home.read(".codex/config.toml"));
    assert_eq!(reconcile(&home.machine()), (false, Vec::new()));
    assert_eq!(
        before,
        (home.read(".claude.json"), home.read(".codex/config.toml"))
    );
}

#[test]
fn reconcile_restores_a_missing_artifact_of_a_connected_client_only() {
    let home = Home::with_desktop();
    connect(&home.machine(), Client::Codex).unwrap();
    fs::remove_file(home.path(".agents/skills/svode")).unwrap();
    let status_before = client(&status(&home.machine(), &[], None), Client::Codex);
    assert_eq!(status_before.attention_code.as_deref(), Some("incomplete"));

    assert!(reconcile(&home.machine()).0);
    assert!(home.link(".agents/skills/svode").is_some());

    // A client without any Svode artifact is not connected and stays so.
    assert!(home.link(".claude/skills/svode").is_none());
    let claude = client(&status(&home.machine(), &[], None), Client::ClaudeCode);
    assert!(!claude.installed);
}

#[test]
fn conflicts_refuse_a_connection_before_any_write() {
    let home = Home::with_desktop();
    let custom = "[mcp_servers.svode]\ncommand = \"my-wrapper\"\nargs = []\n";
    home.write(".codex/config.toml", custom);
    let error = connect(&home.machine(), Client::Codex).unwrap_err();
    assert_eq!(error.code, "CUSTOM_CONFIG_CONFLICT");
    assert!(home.link(".agents/skills/svode").is_none());
    assert_eq!(home.read(".codex/config.toml"), custom);
    let codex = client(&status(&home.machine(), &[], None), Client::Codex);
    assert_eq!(codex.attention_code.as_deref(), Some("custom_conflict"));
    // Disconnecting leaves the custom entry.
    assert!(!disconnect(&home.machine(), Client::Codex).unwrap());
    assert_eq!(home.read(".codex/config.toml"), custom);

    home.write(".claude/skills/svode/SKILL.md", "my own skill");
    let error = connect(&home.machine(), Client::ClaudeCode).unwrap_err();
    assert_eq!(error.code, "SKILL_CONFLICT");
    assert_eq!(home.read(".claude/skills/svode/SKILL.md"), "my own skill");
    let claude = client(&status(&home.machine(), &[], None), Client::ClaudeCode);
    assert_eq!(claude.attention_code.as_deref(), Some("skill_conflict"));
}

#[test]
fn a_project_entry_that_overrides_the_user_one_is_a_conflict() {
    let home = Home::with_desktop();
    let project = home.path("work/notes");
    home.write(
        "work/notes/.mcp.json",
        r#"{"mcpServers":{"svode":{"command":"custom"}}}"#,
    );
    let machine = home.machine_for(Some(&project));
    assert_eq!(
        connect(&machine, Client::ClaudeCode).unwrap_err().code,
        "HIGHER_PRECEDENCE_CONFLICT"
    );
    assert!(home.link(".claude/skills/svode").is_none());
    assert_eq!(
        client(&status(&machine, &[], None), Client::ClaudeCode)
            .attention_code
            .as_deref(),
        Some("higher_precedence_conflict")
    );
}

#[test]
fn disconnect_removes_only_marked_artifacts_and_the_shared_skill_with_codex() {
    let home = Home::with_desktop();
    connect(&home.machine(), Client::ClaudeCode).unwrap();
    connect(&home.machine(), Client::Codex).unwrap();
    home.write(".agents/skills/other/SKILL.md", "other");

    assert!(disconnect(&home.machine(), Client::Codex).unwrap());
    assert!(home.link(".agents/skills/svode").is_none());
    assert_eq!(home.read(".agents/skills/other/SKILL.md"), "other");
    let codex: toml::Table = toml::from_str(&home.read(".codex/config.toml")).unwrap();
    assert!(
        codex
            .get("mcp_servers")
            .is_none_or(|servers| servers.get("svode").is_none())
    );
    // Claude Code stays connected.
    assert!(home.link(".claude/skills/svode").is_some());

    assert!(disconnect(&home.machine(), Client::ClaudeCode).unwrap());
    assert!(home.link(".claude/skills/svode").is_none());
    assert!(!disconnect(&home.machine(), Client::ClaudeCode).unwrap());
}

#[test]
fn without_a_runtime_nothing_is_connected_or_rewritten() {
    let home = Home::new();
    home.previous_entries();
    let before = (home.read(".claude.json"), home.read(".codex/config.toml"));

    assert_eq!(
        connect(&home.machine(), Client::Codex).unwrap_err().code,
        "RUNTIME_UNAVAILABLE"
    );
    let (changed, errors) = reconcile(&home.machine());
    assert!(!changed);
    assert_eq!(errors.len(), 2);
    assert_eq!(
        before,
        (home.read(".claude.json"), home.read(".codex/config.toml"))
    );
    let status = status(&home.machine(), &errors, None);
    assert_eq!(status.server.status, "not_found");
    for client in &status.clients {
        assert!(client.installed);
        assert_eq!(
            client.attention_code.as_deref(),
            Some("runtime_unavailable")
        );
    }
}

#[test]
fn client_policies_and_the_claude_needs_auth_cache_are_reported() {
    let home = Home::with_desktop();
    connect(&home.machine(), Client::ClaudeCode).unwrap();
    home.write(
        "policy/managed-settings.json",
        r#"{"strictKnownMarketplaces":[{"source":"github","repo":"acme/plugins"}]}"#,
    );
    home.write(
        "policy/requirements.toml",
        "[mcp_servers.docs.identity]\ncommand = \"docs-mcp\"\n",
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    home.write(
        ".claude/mcp-needs-auth-cache.json",
        &json!({ "plugin:svode:svode": { "timestamp": now, "id": "x" } }).to_string(),
    );

    let status = status(&home.machine(), &[], None);
    let claude = client(&status, Client::ClaudeCode);
    let codes = claude
        .issues
        .iter()
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    assert_eq!(codes, ["client_policy_blocked", "mcp_start_failed"]);
    let codex = client(&status, Client::Codex);
    assert_eq!(
        codex.attention_code.as_deref(),
        Some("client_policy_blocked")
    );
    assert!(!status.doctor.ok);
    assert!(
        status
            .doctor
            .errors
            .iter()
            .any(|line| line.contains("does not allow the svode MCP server"))
    );

    // The allowlist that names the launcher lets the connection through.
    home.write(
        "policy/requirements.toml",
        &format!(
            "[mcp_servers.svode.identity]\ncommand = \"{}\"\n",
            home.launcher().display()
        ),
    );
    home.write(".claude/mcp-needs-auth-cache.json", "{}");
    home.write(
        "policy/managed-settings.json",
        r#"{"strictKnownMarketplaces":[{"source":"skills-dir"}]}"#,
    );
    let status = crate::status(&home.machine(), &[], None);
    assert!(client(&status, Client::ClaudeCode).issues.is_empty());
    assert!(client(&status, Client::Codex).issues.is_empty());
}

#[test]
fn the_manual_config_starts_the_stable_launcher_and_carries_no_marker() {
    let home = Home::with_desktop();
    let manual = crate::manual_config(&home.machine());
    assert_eq!(manual.command, home.launcher().display().to_string());
    assert!(manual.args.is_empty() && manual.env.is_empty());
    let codex = crate::manual_config_text(&home.machine(), Client::Codex);
    assert!(!codex.contains(crate::MARKER_ENV));
    let claude = crate::manual_config_text(&home.machine(), Client::ClaudeCode);
    assert!(claude.ends_with(&format!("-- '{}'", home.launcher().display())));
}

#[test]
fn the_doctor_reports_whether_the_runtime_speaks_the_bridge_protocol() {
    let home = Home::with_desktop();
    let probe = |protocol: &str| crate::BridgeProbe {
        protocol: protocol.into(),
        discovery_file: None,
        discovery_present: false,
        desktop_reachable: false,
    };
    // The script binaries of the runtime answer `--bridge-protocol` with this line.
    let spoken = "svode-mcp 0.0.9 --bridge-protocol";
    let machine = home.machine();

    assert_eq!(crate::doctor(&machine, None).bridge_compatible, None);
    let same = crate::doctor(&machine, Some(&probe(spoken)));
    assert_eq!(same.bridge_compatible, Some(true));
    assert!(same.ok);
    let other = crate::doctor(&machine, Some(&probe("svode-desktop-bridge-v2")));
    assert_eq!(other.bridge_compatible, Some(false));
    assert!(!other.ok);
    assert_eq!(
        crate::doctor(&Home::new().machine(), Some(&probe(spoken))).bridge_compatible,
        None
    );
}
