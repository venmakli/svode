//! `svode integration` through real processes in a temporary home: the
//! connection manager with and without a Svode runtime in ~/.svode, a
//! managed MCP entry of a previous desktop app and disconnection.
#![cfg(unix)]

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use common::process::json_with;
use serde_json::Value;
use svode_install::{DesktopRuntime, Layout, take_desktop_ownership};

struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap().join("home");
        fs::create_dir_all(&home).unwrap();
        Self { _dir: dir, home }
    }

    /// A desktop app of `version` owns ~/.svode; its binaries are scripts.
    fn desktop(&self, version: &str) -> PathBuf {
        let binaries = self.home.join("Applications/Svode.app/Contents/MacOS");
        let payload = binaries.join("../Resources/plugins/svode");
        fs::create_dir_all(&binaries).unwrap();
        for name in svode_install::RUNTIME_BINARIES {
            let path = binaries.join(name);
            fs::write(&path, "#!/bin/sh\n").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::create_dir_all(payload.join(".claude-plugin")).unwrap();
        fs::create_dir_all(payload.join("skills/svode")).unwrap();
        fs::write(
            payload.join(".claude-plugin/plugin.json"),
            format!("{{\"name\":\"svode\",\"version\":\"{version}\"}}"),
        )
        .unwrap();
        take_desktop_ownership(
            &Layout::at(self.home.join(".svode")),
            &DesktopRuntime {
                binaries: &binaries,
                payload: &payload,
                version,
            },
        )
        .unwrap();
        binaries
    }

    fn integration(&self, args: &[&str]) -> (i32, Value) {
        let mut full = vec!["integration"];
        full.extend_from_slice(args);
        let home = self.home.to_str().unwrap();
        json_with(&self.home, &full, None, &[("HOME", home)])
    }

    fn client<'a>(result: &'a Value, id: &str) -> &'a Value {
        result["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|client| client["id"] == id)
            .unwrap()
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn without_a_runtime_status_answers_and_connect_is_refused() {
    let home = Home::new();
    let (code, status) = home.integration(&["status"]);
    assert_eq!(code, 0, "{status}");
    assert_eq!(status["runtime"]["status"], "not_found");

    let (code, failure) = home.integration(&["connect", "codex"]);
    assert_eq!(code, 1, "{failure}");
    assert_eq!(failure["error"]["code"], "RUNTIME_UNAVAILABLE");
    assert!(!home.path(".agents/skills/svode").exists());
    assert!(!home.path(".codex/config.toml").exists());
}

#[test]
fn sync_turns_a_previous_desktop_entry_into_a_full_connection_and_disconnect_removes_it() {
    let home = Home::new();
    let binaries = home.desktop("0.0.9");
    let config = home.path(".codex/config.toml");
    write(
        &config,
        &format!(
            "model = \"gpt-5.5\"\n\n[mcp_servers.svode]\ncommand = \"{}\"\nargs = [\"--app\", \"desktop\"]\n\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED = \"svode-desktop-bridge-v1\"\n",
            binaries.join("svode-mcp").display()
        ),
    );

    let (code, synced) = home.integration(&["sync"]);
    assert_eq!(code, 0, "{synced}");
    assert_eq!(synced["changed"], true);
    let codex = Home::client(&synced, "codex");
    assert_eq!(codex["installed"], true);
    assert_eq!(codex["complete"], true);
    assert_eq!(codex["version"], "0.0.9");
    let text = fs::read_to_string(&config).unwrap();
    assert!(text.starts_with("model = \"gpt-5.5\""), "{text}");
    assert!(text.contains(home.path(".svode/bin/svode-mcp").to_str().unwrap()));
    assert!(!text.contains("Svode.app"), "{text}");
    assert_eq!(
        fs::read_link(home.path(".agents/skills/svode")).unwrap(),
        home.path(".svode/current/plugins/svode/skills/svode")
    );
    let (_, again) = home.integration(&["sync"]);
    assert_eq!(again["changed"], false);

    let (code, connected) = home.integration(&["connect", "claude-code"]);
    assert_eq!(code, 0, "{connected}");
    assert_eq!(Home::client(&connected, "claude-code")["complete"], true);
    assert_eq!(
        fs::read_link(home.path(".claude/skills/svode")).unwrap(),
        home.path(".svode/current/plugins/svode")
    );

    let (code, disconnected) = home.integration(&["disconnect", "--all"]);
    assert_eq!(code, 0, "{disconnected}");
    assert_eq!(disconnected["changed"], true);
    for id in ["claude-code", "codex"] {
        assert_eq!(Home::client(&disconnected, id)["installed"], false);
    }
    assert!(!home.path(".claude/skills/svode").exists());
    assert!(!home.path(".agents/skills/svode").exists());
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "model = \"gpt-5.5\"\n"
    );
}

#[test]
fn a_custom_entry_is_a_conflict_that_nothing_overwrites() {
    let home = Home::new();
    home.desktop("0.0.9");
    let config = home.path(".codex/config.toml");
    let custom = "[mcp_servers.svode]\ncommand = \"my-wrapper\"\n";
    write(&config, custom);

    let (code, failure) = home.integration(&["connect", "codex"]);
    assert_eq!(code, 1, "{failure}");
    assert_eq!(failure["error"]["code"], "CUSTOM_CONFIG_CONFLICT");
    let (_, status) = home.integration(&["status"]);
    assert_eq!(
        Home::client(&status, "codex")["attentionCode"],
        "custom_conflict"
    );
    assert_eq!(fs::read_to_string(&config).unwrap(), custom);
}
