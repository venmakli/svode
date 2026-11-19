//! The `init` answer of the real sidecar names why this device cannot
//! transfer for a repository, with the stable code and next step of
//! `svode storage status`. No system password store is touched: the
//! unresolved Secret is not declared, so no value is read.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_svode-lfs");

fn init(repo: &Path) -> Value {
    let mut child = Command::new(BIN)
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"event":"init","operation":"download"}}"#).unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    writeln!(stdin, r#"{{"event":"terminate"}}"#).unwrap();
    drop(stdin);
    child.wait().unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn init_names_the_reason_code_and_next_step() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().canonicalize().unwrap();
    std::fs::create_dir_all(repo.join(".svode")).unwrap();
    std::fs::write(repo.join(".svode/config.json"), r#"{"name":"Project"}"#).unwrap();

    let message = init(&repo)["error"]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(message.starts_with("init failed: "), "{message}");
    assert!(message.contains("[S3_NOT_CONNECTED]"), "{message}");
    assert!(
        message.contains("svode storage s3 connect --access-key <NAME> --secret-key <NAME>"),
        "{message}"
    );

    let library = repo.join("library");
    std::fs::create_dir_all(&library).unwrap();
    std::fs::write(
        repo.join(".svode/lfs-s3-agent.json"),
        json!({
            "version": 2,
            "endpoint": "http://127.0.0.1:9",
            "bucket": "assets",
            "region": "us-east-1",
            "prefix": "project/root",
            "bindings": {
                "accessKey": { "owner": { "scope": "global" }, "name": "S3_ACCESS_KEY" },
                "secretKey": { "owner": { "scope": "global" }, "name": "S3_SECRET_KEY" }
            },
            "globalDirectory": library,
            "projectPath": repo,
            "spaceId": null
        })
        .to_string(),
    )
    .unwrap();
    let message = init(&repo)["error"]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(message.contains("[SECRET_NOT_FOUND]"), "{message}");
    assert!(
        message.contains("svode secret set S3_ACCESS_KEY"),
        "{message}"
    );
}
