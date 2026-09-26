//! `svode-mcp install | remove | print-config | doctor` as entrypoints of the
//! shared connection manager, through the real binary in a temporary home.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::Value;
use svode_install::{DesktopRuntime, Layout, take_desktop_ownership};

const BIN: &str = env!("CARGO_BIN_EXE_svode-mcp");

fn run(home: &Path, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .current_dir(home)
        .env("HOME", home)
        .env("SVODE_MCP_DISCOVERY", home.join("absent-discovery.json"))
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

/// ~/.svode owned by a desktop app whose `svode-mcp` answers the bridge
/// protocol like the real one.
fn install_runtime(home: &Path) {
    let binaries = home.join("Applications/Svode.app/Contents/MacOS");
    let payload = binaries.join("../Resources/plugins/svode");
    fs::create_dir_all(&binaries).unwrap();
    for name in svode_install::RUNTIME_BINARIES {
        let path = binaries.join(name);
        fs::write(&path, "#!/bin/sh\necho svode-desktop-bridge-v1\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::create_dir_all(payload.join(".claude-plugin")).unwrap();
    fs::create_dir_all(payload.join("skills/svode")).unwrap();
    fs::write(
        payload.join(".claude-plugin/plugin.json"),
        "{\"name\":\"svode\",\"version\":\"0.0.9\"}",
    )
    .unwrap();
    take_desktop_ownership(
        &Layout::at(home.join(".svode")),
        &DesktopRuntime {
            binaries: &binaries,
            payload: &payload,
            version: "0.0.9",
        },
    )
    .unwrap();
}

#[test]
fn install_and_remove_connect_and_disconnect_the_whole_client() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();

    let refused = run(&home, &["install", "--client", "codex"]);
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("RUNTIME_UNAVAILABLE"));

    install_runtime(&home);
    let output = run(&home, &["install", "--client", "codex"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["changed"], true);
    assert_eq!(result["status"]["complete"], true);
    assert!(home.join(".agents/skills/svode").is_symlink());
    let config = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(config.contains(home.join(".svode/bin/svode-mcp").to_str().unwrap()));

    let output = run(&home, &["remove", "--client", "codex"]);
    assert!(output.status.success());
    assert!(!home.join(".agents/skills/svode").exists());
    assert!(
        !fs::read_to_string(home.join(".codex/config.toml"))
            .unwrap()
            .contains("svode")
    );
}

#[test]
fn print_config_and_doctor_use_the_stable_launcher() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();
    let doctor = run(&home, &["doctor"]);
    assert!(doctor.status.success());
    let report: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(report["ok"], false);

    install_runtime(&home);
    let launcher = home.join(".svode/bin/svode-mcp");
    let printed = run(&home, &["print-config", "--client", "codex"]);
    let printed = String::from_utf8(printed.stdout).unwrap();
    assert!(printed.contains(launcher.to_str().unwrap()), "{printed}");
    assert!(!printed.contains("SVODE_MCP_MANAGED") && !printed.contains("--app"));
    let printed = run(&home, &["print-config", "--client", "claude-code"]);
    let printed = String::from_utf8(printed.stdout).unwrap();
    assert!(printed.starts_with("claude mcp add"), "{printed}");

    let doctor = run(&home, &["doctor"]);
    let report: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(report["ok"], true, "{report}");
    assert_eq!(report["command"], launcher.to_str().unwrap());
    assert_eq!(report["version"], "0.0.9");
    assert_eq!(report["bridgeProtocol"], "svode-desktop-bridge-v1");
    assert!(
        report["binaryPath"]
            .as_str()
            .unwrap()
            .starts_with(home.join(".svode/runtimes").to_str().unwrap())
    );
}
