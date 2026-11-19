#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

//! Git LFS Custom Transfer Agent for Svode.
//!
//! Implements the line-delimited JSON protocol described in
//! <https://github.com/git-lfs/git-lfs/blob/main/docs/custom-transfers.md>
//! and ships LFS blobs to/from an S3-compatible bucket via OpenDAL.
//!
//! Configuration is read from the repository's ignored local agent config.
//! Each session resolves two Variables Secrets directly, without Desktop.

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use opendal::Operator;
use serde::{Deserialize, Serialize};
use svode_core::storage::connection::LfsNotReady;
use svode_core::storage::s3::{AgentConfig, Credentials};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

mod download;

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
            Request::Init { .. } => match AgentState::load().await {
                Ok(s) => {
                    state = Some(s);
                    write_line(&mut stdout, &InitResponse::default()).await?;
                }
                Err(reason) => {
                    write_line(
                        &mut stdout,
                        &InitResponse {
                            error: Some(LfsError {
                                code: 2,
                                message: init_failure(&reason),
                            }),
                        },
                    )
                    .await?;
                }
            },
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

/// `init` answer of a repository this device cannot transfer for: the stable
/// code, the reason and the next step, as `svode storage status` shows them.
fn init_failure(reason: &LfsNotReady) -> String {
    let mut message = format!("init failed: {reason}");
    if let Some(code) = reason.code() {
        message = format!("{message} [{code}]");
    }
    if let Some(hint) = reason.hint() {
        message.push_str(&format!("; next step: {hint}"));
    }
    message
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
    async fn load() -> std::result::Result<Self, LfsNotReady> {
        Self::load_with(PathBuf::from("."), |cfg| {
            cfg.resolve_or_refuse().map_err(LfsNotReady::Secret)
        })
        .await
    }

    async fn load_with(
        repo: PathBuf,
        resolve: impl FnOnce(&AgentConfig) -> std::result::Result<Credentials, LfsNotReady>
        + Send
        + 'static,
    ) -> std::result::Result<Self, LfsNotReady> {
        let (cfg, secrets) = tokio::task::spawn_blocking(move || {
            // Without the agent config of this device the repository is not
            // connected to its S3 storage.
            let cfg = AgentConfig::read(&repo)
                .map_err(|_| LfsNotReady::S3NotConnected { detail: None })?;
            let secrets = resolve(&cfg)?;
            Ok::<_, LfsNotReady>((cfg, secrets))
        })
        .await
        .map_err(|error| LfsNotReady::S3NotConnected {
            detail: Some(format!("the agent config was not read: {error}")),
        })??;

        let op =
            svode_core::storage::s3::operator(&cfg.endpoint, &cfg.bucket, &cfg.region, &secrets)
                .map_err(|detail| LfsNotReady::S3CheckFailed { detail })?;

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

        tokio::task::spawn_blocking(move || {
            download::stage(std::path::Path::new("."), buf.to_vec().as_slice())
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Store(fn(&str) -> Result<Option<String>, String>);
    impl svode_core::variables::SecretStore for Store {
        fn get(&self, name: &str) -> svode_core::variables::Result<Option<String>> {
            (self.0)(name).map_err(|_| svode_core::variables::Error::SecretStore)
        }
        fn set(&self, _: &str, _: &str) -> svode_core::variables::Result<()> {
            unreachable!()
        }
        fn remove(&self, _: &str) -> svode_core::variables::Result<()> {
            unreachable!()
        }
    }
    fn detail(detail: String) -> LfsNotReady {
        LfsNotReady::S3NotConnected {
            detail: Some(detail),
        }
    }
    #[tokio::test]
    async fn standalone_session_resolves_shared_secrets_and_preserves_object_keys() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".svode")).unwrap();
        std::fs::write(repo.path().join(".svode/config.json"), "{}").unwrap();
        let catalog_path = repo.path().join("settings.json");
        std::fs::write(
            &catalog_path,
            r#"{"variables":{"ACCESS":{"kind":"secret","secretRef":"secret:01ARZ3NDEKTSV4RRFFQ69G5FAV"},"SECRET":{"kind":"secret","secretRef":"secret:01ARZ3NDEKTSV4RRFFQ69G5FAW"}}}"#,
        )
        .unwrap();
        let config = svode_core::storage::s3::AgentConfig {
            version: 2,
            endpoint: "https://s3.example.test".into(),
            bucket: "assets".into(),
            region: "us-east-1".into(),
            prefix: Some("project/root".into()),
            global_directory: repo.path().into(),
            project_path: repo.path().into(),
            space_id: None,
            bindings: svode_core::storage::s3::SecretBindings {
                access_key: svode_core::variables::SourceReference {
                    owner: svode_core::variables::SourceOwner::Global,
                    name: "ACCESS".into(),
                },
                secret_key: svode_core::variables::SourceReference {
                    owner: svode_core::variables::SourceOwner::Global,
                    name: "SECRET".into(),
                },
            },
        };
        config.write(repo.path()).unwrap();
        let state = AgentState::load_with(repo.path().into(), |cfg| {
            cfg.resolve_with_store(&Store(|name| {
                assert!(name.starts_with("secret:"));
                Ok(Some("fixture-value".into()))
            }))
            .map_err(detail)
        })
        .await
        .unwrap();
        assert_eq!(state.object_key("abcdef"), "project/root/ab/cd/abcdef");
        let result = AgentState::load_with(repo.path().into(), |cfg| {
            cfg.resolve_with_store(&Store(|name| {
                if name == "secret:01ARZ3NDEKTSV4RRFFQ69G5FAW" {
                    Err("denied".into())
                } else {
                    Ok(Some("access".into()))
                }
            }))
            .map_err(detail)
        })
        .await;
        assert!(result.err().unwrap().to_string().contains("Secret Key"));
        std::fs::write(repo.path().join(svode_core::storage::s3::CONFIG_REL), r#"{"endpoint":"https://s3.example.test","bucket":"assets","region":"us-east-1","keychainAccount":"old"}"#).unwrap();
        let result = AgentState::load_with(repo.path().into(), |cfg| {
            cfg.resolve_with_store(&Store(|_| panic!("must not read old credentials")))
                .map_err(detail)
        })
        .await;
        let reason = result.err().unwrap();
        assert_eq!(reason, LfsNotReady::S3NotConnected { detail: None });
        let message = init_failure(&reason);
        assert!(message.contains("[S3_NOT_CONNECTED]"), "{message}");
        assert!(message.contains("svode storage s3 connect"), "{message}");
    }
    /// The agent Git starts reads the device store of the config directory
    /// the bindings were made in: with its secrets file active, the values
    /// come from that file and the system store is not consulted.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_production_agent_reads_values_from_the_active_secrets_file() {
        use svode_core::variables::{DeviceSecretStore, SecretStore, UseFile};
        let repo = tempfile::tempdir().unwrap();
        let library = repo.path().join("library");
        std::fs::create_dir_all(repo.path().join(".svode")).unwrap();
        std::fs::write(repo.path().join(".svode/config.json"), "{}").unwrap();
        let store = DeviceSecretStore::with_environment(&library, []);
        assert_eq!(store.use_file().unwrap(), UseFile::Created);
        std::fs::write(
            library.join("settings.json"),
            r#"{"variables":{"ACCESS":{"kind":"secret","secretRef":"secret:01ARZ3NDEKTSV4RRFFQ69G5FAV"},"SECRET":{"kind":"secret","secretRef":"secret:01ARZ3NDEKTSV4RRFFQ69G5FAW"}}}"#,
        )
        .unwrap();
        let config = svode_core::storage::s3::AgentConfig {
            version: 2,
            endpoint: "https://s3.example.test".into(),
            bucket: "assets".into(),
            region: "us-east-1".into(),
            prefix: None,
            global_directory: library.clone(),
            project_path: repo.path().into(),
            space_id: None,
            bindings: svode_core::storage::s3::SecretBindings {
                access_key: svode_core::variables::SourceReference {
                    owner: svode_core::variables::SourceOwner::Global,
                    name: "ACCESS".into(),
                },
                secret_key: svode_core::variables::SourceReference {
                    owner: svode_core::variables::SourceOwner::Global,
                    name: "SECRET".into(),
                },
            },
        };
        config.write(repo.path()).unwrap();
        let missing = AgentState::load_with(repo.path().into(), |cfg| {
            cfg.resolve_or_refuse().map_err(LfsNotReady::Secret)
        })
        .await;
        let message = init_failure(&missing.err().unwrap());
        assert!(message.contains("Variable value is missing"), "{message}");
        assert!(message.contains("[SECRET_NOT_FOUND]"), "{message}");
        assert!(message.contains("svode secret set ACCESS"), "{message}");
        store
            .set("secret:01ARZ3NDEKTSV4RRFFQ69G5FAV", "access")
            .unwrap();
        store
            .set("secret:01ARZ3NDEKTSV4RRFFQ69G5FAW", "secret")
            .unwrap();
        let state = AgentState::load_with(repo.path().into(), |cfg| {
            cfg.resolve_or_refuse().map_err(LfsNotReady::Secret)
        })
        .await
        .unwrap();
        assert_eq!(state.object_key("abcdef"), "lfs/ab/cd/abcdef");
    }
}
