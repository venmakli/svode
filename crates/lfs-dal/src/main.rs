//! Git LFS Custom Transfer Agent for Svode.
//!
//! Implements the line-delimited JSON protocol described in
//! <https://github.com/git-lfs/git-lfs/blob/main/docs/custom-transfers.md>
//! and ships LFS blobs to/from an S3-compatible bucket via OpenDAL.
//!
//! Configuration is read from `<cwd>/.svode/lfs-s3-agent.json` — git-lfs runs
//! the agent with cwd = repo root, so this resolves naturally. Secrets
//! (access/secret keys) live in the OS keychain under service
//! `app.svode.desktop.lfs-s3` and the account name recorded in the config
//! file. The Tauri host writes both pieces atomically when the user picks the
//! `lfs-s3` strategy.

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use opendal::{Operator, services::S3};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const KEYCHAIN_SERVICE: &str = "app.svode.desktop.lfs-s3";
const AGENT_CONFIG_PATH: &str = ".svode/lfs-s3-agent.json";

/// On-disk config written by the Tauri host. Secrets live in the OS keychain
/// — only the *lookup key* (`keychain_account`) is recorded here, so this
/// file is safe to drop alongside the workspace if/when we ever loosen the
/// .gitignore (we currently keep it untracked).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfig {
    endpoint: String,
    bucket: String,
    region: String,
    keychain_account: String,
    /// Optional prefix inside the bucket — defaults to "lfs". Useful when one
    /// bucket is shared across multiple workspaces.
    #[serde(default)]
    prefix: Option<String>,
}

/// Secret blob stored in the keychain. Two fields, JSON-encoded.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSecrets {
    access_key: String,
    secret_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum Request {
    Init {
        #[allow(dead_code)]
        operation: String,
        #[allow(dead_code)]
        #[serde(default)]
        remote: Option<String>,
        #[allow(dead_code)]
        #[serde(default)]
        concurrent: Option<bool>,
        #[allow(dead_code)]
        #[serde(default)]
        concurrenttransfers: Option<u32>,
    },
    Upload {
        oid: String,
        size: u64,
        path: String,
    },
    Download {
        oid: String,
        size: u64,
    },
    Terminate,
}

#[derive(Debug, Serialize)]
struct LfsError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize, Default)]
struct InitResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<LfsError>,
}

#[derive(Debug, Serialize)]
struct CompleteResponse {
    event: &'static str,
    oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<LfsError>,
}

fn main() -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run())
}

async fn run() -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    // Lazily-initialised once `init` succeeds. Built only after we've actually
    // received a real request, so a bare `terminate` doesn't trip on missing
    // config.
    let mut state: Option<AgentState> = None;

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                write_line(
                    &mut stdout,
                    &serde_json::json!({
                        "error": {
                            "code": 1,
                            "message": format!("invalid request: {e}")
                        }
                    }),
                )
                .await?;
                continue;
            }
        };

        match req {
            Request::Init { .. } => {
                match AgentState::load().await {
                    Ok(s) => {
                        state = Some(s);
                        write_line(&mut stdout, &InitResponse::default()).await?;
                    }
                    Err(e) => {
                        write_line(
                            &mut stdout,
                            &InitResponse {
                                error: Some(LfsError {
                                    code: 2,
                                    message: format!("init failed: {e:#}"),
                                }),
                            },
                        )
                        .await?;
                    }
                }
            }
            Request::Upload { oid, size, path } => {
                let resp = match state.as_ref() {
                    Some(s) => s.handle_upload(&oid, size, &path).await,
                    None => Err(anyhow!("upload received before successful init")),
                };
                write_line(&mut stdout, &complete_for(&oid, None, resp)).await?;
            }
            Request::Download { oid, size } => {
                let resp = match state.as_ref() {
                    Some(s) => s.handle_download(&oid, size).await,
                    None => Err(anyhow!("download received before successful init")),
                };
                match resp {
                    Ok(local_path) => {
                        write_line(
                            &mut stdout,
                            &CompleteResponse {
                                event: "complete",
                                oid: oid.clone(),
                                path: Some(local_path),
                                error: None,
                            },
                        )
                        .await?;
                    }
                    Err(e) => {
                        write_line(
                            &mut stdout,
                            &CompleteResponse {
                                event: "complete",
                                oid: oid.clone(),
                                path: None,
                                error: Some(LfsError {
                                    code: 3,
                                    message: format!("{e:#}"),
                                }),
                            },
                        )
                        .await?;
                    }
                }
            }
            Request::Terminate => break,
        }
    }

    Ok(())
}

fn complete_for(oid: &str, path: Option<String>, result: Result<()>) -> CompleteResponse {
    match result {
        Ok(()) => CompleteResponse {
            event: "complete",
            oid: oid.to_string(),
            path,
            error: None,
        },
        Err(e) => CompleteResponse {
            event: "complete",
            oid: oid.to_string(),
            path: None,
            error: Some(LfsError {
                code: 3,
                message: format!("{e:#}"),
            }),
        },
    }
}

async fn write_line<W, T>(out: &mut W, value: &T) -> Result<()>
where
    W: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let mut buf = serde_json::to_vec(value)?;
    buf.push(b'\n');
    out.write_all(&buf).await?;
    out.flush().await?;
    Ok(())
}

struct AgentState {
    op: Operator,
    prefix: String,
}

impl AgentState {
    async fn load() -> Result<Self> {
        let cfg_bytes = tokio::fs::read(AGENT_CONFIG_PATH)
            .await
            .with_context(|| format!("reading {AGENT_CONFIG_PATH}"))?;
        let cfg: AgentConfig =
            serde_json::from_slice(&cfg_bytes).context("parsing lfs-s3-agent.json")?;

        let secrets = tokio::task::spawn_blocking({
            let account = cfg.keychain_account.clone();
            move || -> Result<AgentSecrets> {
                let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account)
                    .context("opening keychain entry")?;
                let pw = entry
                    .get_password()
                    .context("reading keychain password")?;
                let s: AgentSecrets =
                    serde_json::from_str(&pw).context("parsing keychain payload")?;
                Ok(s)
            }
        })
        .await??;

        let builder = S3::default()
            .bucket(&cfg.bucket)
            .region(&cfg.region)
            .endpoint(&cfg.endpoint)
            .access_key_id(&secrets.access_key)
            .secret_access_key(&secrets.secret_key);

        let op = Operator::new(builder)?.finish();

        let prefix = cfg
            .prefix
            .as_deref()
            .unwrap_or("lfs")
            .trim_matches('/')
            .to_string();

        Ok(Self { op, prefix })
    }

    fn object_key(&self, oid: &str) -> String {
        // Mirror standard LFS sharding: lfs/<oid[0..2]>/<oid[2..4]>/<oid>
        // so blobs spread across many "directories" in the bucket.
        let a = oid.get(0..2).unwrap_or("00");
        let b = oid.get(2..4).unwrap_or("00");
        if self.prefix.is_empty() {
            format!("{a}/{b}/{oid}")
        } else {
            format!("{}/{a}/{b}/{oid}", self.prefix)
        }
    }

    async fn handle_upload(&self, oid: &str, _size: u64, path: &str) -> Result<()> {
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("reading staged blob {path}"))?;
        let key = self.object_key(oid);
        self.op
            .write(&key, bytes)
            .await
            .with_context(|| format!("S3 upload {key}"))?;
        Ok(())
    }

    async fn handle_download(&self, oid: &str, _size: u64) -> Result<String> {
        let key = self.object_key(oid);
        let buf = self
            .op
            .read(&key)
            .await
            .with_context(|| format!("S3 download {key}"))?;

        let tmp_dir = PathBuf::from(".git/lfs/tmp/lfs-dal");
        tokio::fs::create_dir_all(&tmp_dir)
            .await
            .with_context(|| format!("creating {}", tmp_dir.display()))?;
        let out_path = tmp_dir.join(oid);
        tokio::fs::write(&out_path, buf.to_vec())
            .await
            .with_context(|| format!("writing {}", out_path.display()))?;
        Ok(out_path
            .to_str()
            .ok_or_else(|| anyhow!("non-utf8 temp path"))?
            .to_string())
    }
}
