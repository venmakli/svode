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
use opendal::{Operator, services::S3};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
        Self::load_with(
            PathBuf::from("."),
            svode_core::variables::KeyringSecretStore,
        )
        .await
    }

    async fn load_with(
        repo: PathBuf,
        secrets: impl svode_core::variables::SecretStore + Send + 'static,
    ) -> Result<Self> {
        let (cfg, secrets) = tokio::task::spawn_blocking(move || {
            let cfg =
                svode_core::storage::s3::AgentConfig::read(&repo).map_err(anyhow::Error::msg)?;
            let secrets = cfg
                .resolve_with_store(&secrets)
                .map_err(anyhow::Error::msg)?;
            Ok::<_, anyhow::Error>((cfg, secrets))
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
        let state = AgentState::load_with(
            repo.path().into(),
            Store(|name| {
                assert!(name.starts_with("secret:"));
                Ok(Some("fixture-value".into()))
            }),
        )
        .await
        .unwrap();
        assert_eq!(state.object_key("abcdef"), "project/root/ab/cd/abcdef");
        let result = AgentState::load_with(
            repo.path().into(),
            Store(|name| {
                if name == "secret:01ARZ3NDEKTSV4RRFFQ69G5FAW" {
                    Err("denied".into())
                } else {
                    Ok(Some("access".into()))
                }
            }),
        )
        .await;
        assert!(result.err().unwrap().to_string().contains("Secret Key"));
        std::fs::write(repo.path().join(svode_core::storage::s3::CONFIG_REL), r#"{"endpoint":"https://s3.example.test","bucket":"assets","region":"us-east-1","keychainAccount":"old"}"#).unwrap();
        let result = AgentState::load_with(
            repo.path().into(),
            Store(|_| panic!("must not read old credentials")),
        )
        .await;
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("Configure S3 again")
        );
    }
}
