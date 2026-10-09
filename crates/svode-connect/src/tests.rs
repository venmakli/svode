//! The manager on a temporary home with a real stable location, installed
//! by `svode-install` from a desktop bundle or a standalone archive whose
//! binaries are scripts.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use svode_install::{DesktopRuntime, Layout, take_desktop_ownership};
use tempfile::TempDir;

use svode_core::agent_adapters::AgentAdapterKind;

use crate::{Client, Machine, connect, disconnect, reconcile, remove_shared_skill, status};

const PREVIOUS: &str = "svode-desktop-bridge-v1";

mod agents;

pub(super) struct Home {
    _dir: TempDir,
    home: PathBuf,
    bundle: PathBuf,
}

impl Home {
    pub(super) fn new() -> Self {
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
    pub(super) fn with_desktop() -> Self {
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

    pub(super) fn machine(&self) -> Machine {
        self.machine_for(None)
    }

    pub(super) fn machine_for(&self, project: Option<&Path>) -> Machine {
        Machine::at(self.home.clone())
            .with_project(project)
            .with_policies(
                vec![self.home.join("policy/managed-settings.json")],
                self.home.join("policy/requirements.toml"),
                self.home.join("policy/qwen-settings.json"),
            )
    }

    pub(super) fn path(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }

    pub(super) fn write(&self, relative: &str, content: &str) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    pub(super) fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path(relative)).unwrap_or_default()
    }

    pub(super) fn link(&self, relative: &str) -> Option<PathBuf> {
        fs::read_link(self.path(relative)).ok()
    }

    pub(super) fn launcher(&self) -> PathBuf {
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
        svode_testkit::write_executable(
            &path,
            format!("#!/bin/sh\necho \"{name} {version} $*\"\n"),
        )
        .unwrap();
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

fn claude_client() -> Client {
    Client::of(AgentAdapterKind::ClaudeCode)
}

fn codex_client() -> Client {
    Client::of(AgentAdapterKind::Codex)
}

pub(super) fn client(status: &crate::Status, client: Client) -> crate::ClientStatus {
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

    assert!(connect(&home.machine(), claude_client()).unwrap());

    assert_eq!(
        home.link(".claude/skills/svode").unwrap(),
        home.path(".svode/current/plugins/svode")
    );
    let config: Value = serde_json::from_str(&home.read(".claude.json")).unwrap();
    assert_eq!(config, json!({ "theme": "dark" }));
    let status = client(&status(&home.machine(), &[], None), claude_client());
    assert!(status.installed && status.complete, "{status:?}");
    assert_eq!(status.status, "installed");
    assert_eq!(status.version.as_deref(), Some("0.0.9"));
    // Connecting again changes nothing.
    assert!(!connect(&home.machine(), claude_client()).unwrap());
}

#[test]
fn connecting_codex_links_the_shared_skill_and_starts_the_launcher_in_automatic_mode() {
    let home = Home::with_desktop();
    let original =
        "# mine\nmodel = \"gpt-5.5\"\n\n[projects.\"/work\"]\ntrust_level = \"trusted\"\n";
    home.write(".codex/config.toml", original);

    assert!(connect(&home.machine(), codex_client()).unwrap());

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
        entry["env_vars"].as_array().unwrap(),
        &[toml::Value::from("SVODE_MCP_ROUTINE_CALLER_TOKEN")]
    );
    assert_eq!(
        entry["env"]["SVODE_MCP_MANAGED"].as_str(),
        Some(crate::MARKER)
    );
    assert!(!config.contains("approval"));
    assert!(client(&status(&home.machine(), &[], None), codex_client()).complete);
}

#[test]
fn reconcile_makes_a_managed_codex_entry_forward_the_routine_caller_token() {
    let home = Home::with_desktop();
    connect(&home.machine(), codex_client()).unwrap();
    // The managed entry as earlier versions wrote it, without `env_vars`.
    let earlier = format!(
        "model = \"gpt-5.5\"\n\n[mcp_servers.svode]\ncommand = \"{}\"\n\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED = \"{}\"\n",
        home.launcher().display(),
        crate::MARKER
    );
    home.write(".codex/config.toml", &earlier);
    let before = client(&status(&home.machine(), &[], None), codex_client());
    assert_eq!(before.attention_code.as_deref(), Some("incomplete"));

    assert_eq!(reconcile(&home.machine()), (true, Vec::new()));
    let config: toml::Table = toml::from_str(&home.read(".codex/config.toml")).unwrap();
    assert_eq!(config["model"].as_str(), Some("gpt-5.5"));
    assert_eq!(
        config["mcp_servers"]["svode"]["env_vars"]
            .as_array()
            .unwrap(),
        &[toml::Value::from("SVODE_MCP_ROUTINE_CALLER_TOKEN")]
    );
    assert!(client(&status(&home.machine(), &[], None), codex_client()).complete);
    assert_eq!(reconcile(&home.machine()), (false, Vec::new()));
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
    for client in [claude_client(), codex_client()].map(|one| client(&status, one)) {
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
    connect(&home.machine(), codex_client()).unwrap();
    fs::remove_file(home.path(".agents/skills/svode")).unwrap();
    let status_before = client(&status(&home.machine(), &[], None), codex_client());
    assert_eq!(status_before.attention_code.as_deref(), Some("incomplete"));

    assert!(reconcile(&home.machine()).0);
    assert!(home.link(".agents/skills/svode").is_some());

    // A client without any Svode artifact is not connected and stays so.
    assert!(home.link(".claude/skills/svode").is_none());
    let claude = client(&status(&home.machine(), &[], None), claude_client());
    assert!(!claude.installed);
}

#[test]
fn conflicts_refuse_a_connection_before_any_write() {
    let home = Home::with_desktop();
    let custom = "[mcp_servers.svode]\ncommand = \"my-wrapper\"\nargs = []\n";
    home.write(".codex/config.toml", custom);
    let error = connect(&home.machine(), codex_client()).unwrap_err();
    assert_eq!(error.code, "CUSTOM_CONFIG_CONFLICT");
    assert!(home.link(".agents/skills/svode").is_none());
    assert_eq!(home.read(".codex/config.toml"), custom);
    let codex = client(&status(&home.machine(), &[], None), codex_client());
    assert_eq!(codex.attention_code.as_deref(), Some("custom_conflict"));
    // Disconnecting leaves the custom entry.
    assert!(!disconnect(&home.machine(), codex_client()).unwrap());
    assert_eq!(home.read(".codex/config.toml"), custom);

    home.write(".claude/skills/svode/SKILL.md", "my own skill");
    let error = connect(&home.machine(), claude_client()).unwrap_err();
    assert_eq!(error.code, "SKILL_CONFLICT");
    assert_eq!(home.read(".claude/skills/svode/SKILL.md"), "my own skill");
    let claude = client(&status(&home.machine(), &[], None), claude_client());
    assert_eq!(claude.attention_code.as_deref(), Some("skill_conflict"));
}

fn artifacts(status: &crate::ClientStatus) -> Vec<(&str, &str)> {
    status
        .artifacts
        .iter()
        .map(|artifact| (artifact.kind.as_str(), artifact.state.as_str()))
        .collect()
}

#[test]
fn artifacts_follow_the_way_each_client_is_connected() {
    let home = Home::with_desktop();
    let machine = home.machine();

    // Not connected: the plugin of Claude Code is missing and it has no entry.
    let claude = client(&status(&machine, &[], None), claude_client());
    assert_eq!(artifacts(&claude), [("plugin", "absent")]);
    assert_eq!(
        claude.artifacts[0].path,
        home.path(".claude/skills/svode").display().to_string()
    );

    // Connected: the plugin only.
    connect(&machine, claude_client()).unwrap();
    let claude = client(&status(&machine, &[], None), claude_client());
    assert_eq!(artifacts(&claude), [("plugin", "managed")]);
    assert!(claude.issues.is_empty(), "{claude:?}");

    // A user entry is listed while it exists, with its own attention.
    home.previous_entries();
    fs::remove_file(home.path(".claude/skills/svode")).unwrap();
    let claude = client(&status(&machine, &[], None), claude_client());
    assert_eq!(
        artifacts(&claude),
        [("plugin", "absent"), ("mcp-entry", "previous")]
    );
    assert_eq!(
        claude.artifacts[1].path,
        home.path(".claude.json").display().to_string()
    );
    assert_eq!(claude.attention_code.as_deref(), Some("incomplete"));

    connect(&machine, claude_client()).unwrap();
    home.write(
        ".claude.json",
        r#"{"mcpServers":{"svode":{"command":"my-wrapper"}}}"#,
    );
    let claude = client(&status(&machine, &[], None), claude_client());
    assert_eq!(
        artifacts(&claude),
        [("plugin", "managed"), ("mcp-entry", "custom")]
    );
    assert_eq!(claude.attention_code.as_deref(), Some("custom_conflict"));

    home.write(".claude.json", "{ not json");
    let claude = client(&status(&machine, &[], None), claude_client());
    assert_eq!(
        artifacts(&claude),
        [("plugin", "managed"), ("mcp-entry", "unreadable")]
    );
    assert_eq!(claude.attention_code.as_deref(), Some("config_unreadable"));

    // Codex: the shared skill and the managed entry.
    home.write(".codex/config.toml", "");
    connect(&machine, codex_client()).unwrap();
    let codex = client(&status(&machine, &[], None), codex_client());
    assert_eq!(
        artifacts(&codex),
        [("skill", "managed"), ("mcp-entry", "managed")]
    );
    assert_eq!(
        codex.artifacts[1].path,
        home.path(".codex/config.toml").display().to_string()
    );
    let own_part = codex.own_part.as_ref().unwrap();
    assert_eq!(
        (own_part.kind.as_str(), own_part.state.as_str()),
        ("mcp-entry", "managed")
    );
    // Without its entry Codex only reads the shared skill: not connected.
    home.write(".codex/config.toml", "");
    let codex = client(&status(&machine, &[], None), codex_client());
    assert_eq!(
        artifacts(&codex),
        [("skill", "managed"), ("mcp-entry", "absent")]
    );
    assert!(!codex.installed && codex.issues.is_empty(), "{codex:?}");
    assert_eq!(codex.status, "mcp_not_installed");
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
        connect(&machine, claude_client()).unwrap_err().code,
        "HIGHER_PRECEDENCE_CONFLICT"
    );
    assert!(home.link(".claude/skills/svode").is_none());
    assert_eq!(
        client(&status(&machine, &[], None), claude_client())
            .attention_code
            .as_deref(),
        Some("higher_precedence_conflict")
    );
}

#[test]
fn disconnect_removes_only_the_own_part_and_keeps_the_shared_skill() {
    let home = Home::with_desktop();
    connect(&home.machine(), claude_client()).unwrap();
    connect(&home.machine(), codex_client()).unwrap();
    home.write(".agents/skills/other/SKILL.md", "other");

    assert!(disconnect(&home.machine(), codex_client()).unwrap());
    let codex: toml::Table = toml::from_str(&home.read(".codex/config.toml")).unwrap();
    assert!(
        codex
            .get("mcp_servers")
            .is_none_or(|servers| servers.get("svode").is_none())
    );
    assert!(home.link(".agents/skills/svode").is_some());
    assert_eq!(home.read(".agents/skills/other/SKILL.md"), "other");
    // Codex is left with the skill only, and nothing writes its entry back.
    assert_eq!(reconcile(&home.machine()), (false, Vec::new()));
    assert!(!client(&status(&home.machine(), &[], None), codex_client()).installed);
    assert!(!disconnect(&home.machine(), codex_client()).unwrap());
    // Claude Code stays connected.
    assert!(home.link(".claude/skills/svode").is_some());

    assert!(disconnect(&home.machine(), claude_client()).unwrap());
    assert!(home.link(".claude/skills/svode").is_none());
    assert!(!disconnect(&home.machine(), claude_client()).unwrap());
    assert!(home.link(".agents/skills/svode").is_some());
}

#[test]
fn a_shared_skill_without_a_codex_entry_connects_nobody() {
    let home = Home::with_desktop();
    connect(&home.machine(), codex_client()).unwrap();
    home.write(".codex/config.toml", "model = \"gpt-5.5\"\n");
    let before = home.read(".codex/config.toml");

    assert_eq!(reconcile(&home.machine()), (false, Vec::new()));
    assert_eq!(home.read(".codex/config.toml"), before);
    let status = status(&home.machine(), &[], None);
    assert!(!client(&status, codex_client()).installed);
    assert_eq!(status.shared_skill.state, "managed");
    assert!(status.shared_skill.required_by.is_empty());
}

#[test]
fn the_shared_skill_goes_only_by_its_explicit_removal_once_no_own_part_needs_it() {
    let home = Home::with_desktop();
    connect(&home.machine(), codex_client()).unwrap();
    let shared = status(&home.machine(), &[], None).shared_skill;
    assert_eq!(
        shared.path,
        home.path(".agents/skills/svode").display().to_string()
    );
    assert_eq!(shared.required_by, ["codex"]);

    // The entry of Codex needs it: refused, nothing removed.
    let error = remove_shared_skill(&home.machine()).unwrap_err();
    assert_eq!(error.code, "SHARED_SKILL_REQUIRED");
    assert!(error.message.contains("Codex"), "{error}");
    assert!(home.link(".agents/skills/svode").is_some());

    disconnect(&home.machine(), codex_client()).unwrap();
    assert!(remove_shared_skill(&home.machine()).unwrap());
    assert!(home.link(".agents/skills/svode").is_none());
    assert_eq!(
        status(&home.machine(), &[], None).shared_skill.state,
        "absent"
    );
    assert!(!remove_shared_skill(&home.machine()).unwrap());

    // A skill that is not Svode's link stays.
    home.write(".agents/skills/svode/SKILL.md", "my own skill");
    assert!(!remove_shared_skill(&home.machine()).unwrap());
    assert_eq!(home.read(".agents/skills/svode/SKILL.md"), "my own skill");
    assert_eq!(
        status(&home.machine(), &[], None).shared_skill.state,
        "foreign"
    );
}

#[test]
fn the_readers_of_the_shared_skill_are_the_found_agents_that_read_it() {
    let home = Home::with_desktop();
    let bin = home.path("login-bin");
    for executable in ["codex", "claude"] {
        home.write(&format!("login-bin/{executable}"), "#!/bin/sh\n");
        fs::set_permissions(bin.join(executable), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let machine = home.machine().with_search_path(Some(bin.as_os_str()));

    let status = status(&machine, &[], None);
    // Claude Code reads its own plugin, not the shared skill; Codex is a
    // reader without being connected.
    assert_eq!(status.shared_skill.readers, ["codex"]);
    assert!(status.shared_skill.required_by.is_empty());
    let codex = client(&status, codex_client());
    assert!(codex.found && !codex.installed);
    assert_eq!(
        codex.path.as_deref(),
        Some(bin.join("codex").to_str().unwrap())
    );
}

#[test]
fn the_status_keeps_its_json_fields_and_adds_the_parts() {
    let home = Home::with_desktop();
    connect(&home.machine(), codex_client()).unwrap();
    let json = serde_json::to_value(status(&home.machine(), &[], None)).unwrap();
    for field in ["server", "clients", "manualConfig", "doctor", "sharedSkill"] {
        assert!(json.get(field).is_some(), "{field}");
    }
    let codex = json["clients"]
        .as_array()
        .unwrap()
        .iter()
        .find(|client| client["id"] == "codex")
        .unwrap();
    for field in [
        "id",
        "name",
        "found",
        "installed",
        "managed",
        "status",
        "attentionCode",
        "path",
        "configPath",
        "message",
        "complete",
        "version",
        "issues",
        "artifacts",
        "ownPart",
        "limitation",
    ] {
        assert!(codex.get(field).is_some(), "{field}");
    }
    assert_eq!(
        json["sharedSkill"],
        json!({
            "path": home.path(".agents/skills/svode").display().to_string(),
            "state": "managed",
            "readers": json["sharedSkill"]["readers"],
            "requiredBy": ["codex"],
        })
    );
}

#[test]
fn without_a_runtime_nothing_is_connected_or_rewritten() {
    let home = Home::new();
    home.previous_entries();
    let before = (home.read(".claude.json"), home.read(".codex/config.toml"));

    assert_eq!(
        connect(&home.machine(), codex_client()).unwrap_err().code,
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
    for client in [claude_client(), codex_client()].map(|one| client(&status, one)) {
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
    connect(&home.machine(), claude_client()).unwrap();
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
    let claude = client(&status, claude_client());
    let codes = claude
        .issues
        .iter()
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    assert_eq!(codes, ["client_policy_blocked", "mcp_start_failed"]);
    let codex = client(&status, codex_client());
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
    assert!(client(&status, claude_client()).issues.is_empty());
    assert!(client(&status, codex_client()).issues.is_empty());
}

#[test]
fn the_manual_config_starts_the_stable_launcher_and_carries_no_marker() {
    let home = Home::with_desktop();
    let manual = crate::manual_config(&home.machine());
    assert_eq!(manual.command, home.launcher().display().to_string());
    assert!(manual.args.is_empty() && manual.env.is_empty());
    let codex = crate::manual_config_text(&home.machine(), codex_client());
    assert!(!codex.contains(crate::MARKER_ENV));
    let claude = crate::manual_config_text(&home.machine(), claude_client());
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
