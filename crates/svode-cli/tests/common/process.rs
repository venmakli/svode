//! Helpers to run the real `svode` binary in a test process.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

pub const BIN: &str = env!("CARGO_BIN_EXE_svode");

/// Device-local settings of test processes, apart from the user's own.
pub const TEST_IDENTIFIER: &str = "app.svode.desktop.test";

/// Caller token a Routine launch of the desktop app passes to its processes;
/// test processes start without it unless a test sets it.
pub const ROUTINE_CALLER_TOKEN: &str = "SVODE_MCP_ROUTINE_CALLER_TOKEN";

pub fn svode(cwd: &Path, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .env_remove(ROUTINE_CALLER_TOKEN)
        .output()
        .unwrap()
}

/// Runs a JSON command, optionally with stdin, and returns (exit code, the
/// single stdout object).
pub fn json(cwd: &Path, args: &[&str], stdin: Option<&str>) -> (i32, Value) {
    json_with(cwd, args, stdin, &[])
}

/// [`json`] with extra environment variables.
pub fn json_with(
    cwd: &Path,
    args: &[&str],
    stdin: Option<&str>,
    env: &[(&str, &str)],
) -> (i32, Value) {
    let mut child = Command::new(BIN)
        .args(args)
        .arg("--json")
        .current_dir(cwd)
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .env_remove(ROUTINE_CALLER_TOKEN)
        .envs(env.iter().copied())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(stdin) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        stdout.lines().count(),
        1,
        "{args:?}: one JSON line: {stdout}"
    );
    (
        output.status.code().unwrap(),
        serde_json::from_str(&stdout).unwrap(),
    )
}

pub fn code(value: &Value) -> &str {
    assert_eq!(value["ok"], false, "{value}");
    value["error"]["code"].as_str().unwrap()
}

pub fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let key = path.strip_prefix(root).unwrap().to_path_buf();
            if path.is_dir() {
                files.insert(key, Vec::new());
                walk(&path, root, files);
            } else {
                files.insert(key, fs::read(&path).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

pub fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
