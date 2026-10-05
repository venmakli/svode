//! Downloads a catalog model file into the store. The network is used only
//! here, on the user's explicit action; the store checks the file before it
//! is put in place.

use std::time::{Duration, Instant};

use svode_speech::catalog::CatalogModel;
use svode_speech::client::Recognizer;
use svode_speech::models::{InstalledModel, ModelError, ModelStore};
use tokio::sync::watch;

use super::JobFailure;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, thiserror::Error)]
pub(super) enum DownloadError {
    #[error("cancelled")]
    Cancelled,
    #[error("network: {0}")]
    Network(String),
    #[error("{0}")]
    Model(#[from] ModelError),
}

impl DownloadError {
    pub(super) fn failure(&self) -> JobFailure {
        match self {
            DownloadError::Model(ModelError::Integrity) => JobFailure::Integrity,
            DownloadError::Model(_) => JobFailure::Disk,
            DownloadError::Network(_) | DownloadError::Cancelled => JobFailure::Network,
        }
    }
}

pub(super) fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // A stalled transfer fails instead of hanging the progress forever.
        .read_timeout(Duration::from_secs(60))
        .build()
        .expect("speech download client")
}

/// Downloads `model` from `url` into `store`, reporting the received bytes,
/// until `cancelled` turns true.
pub(super) async fn install(
    http: &reqwest::Client,
    store: &ModelStore,
    recognizer: &Recognizer,
    model: &CatalogModel,
    url: &str,
    cancelled: &mut watch::Receiver<bool>,
    mut progress: impl FnMut(u64),
) -> Result<InstalledModel, DownloadError> {
    let started = Instant::now();
    let mut install = store.begin_install(model)?;
    let transfer = async {
        let mut response = http
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(network)?;
        let mut reported = Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(network)? {
            install.write(&chunk).await?;
            if reported.elapsed() >= PROGRESS_INTERVAL {
                reported = Instant::now();
                progress(install.received());
            }
        }
        progress(install.received());
        Ok::<_, DownloadError>(())
    };
    tokio::select! {
        result = transfer => result?,
        _ = cancelled.wait_for(|cancelled| *cancelled) => return Err(DownloadError::Cancelled),
    }
    // An update replaces the directory the process may hold the old file
    // of open.
    recognizer.release(&store.model_dir(&model.id)).await;
    let installed = install.finish().await?;
    tracing::info!(
        model = %installed.id,
        bytes = installed.size,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "speech model installed"
    );
    Ok(installed)
}

fn network(error: reqwest::Error) -> DownloadError {
    // The URL names only the public model file.
    DownloadError::Network(error.without_url().to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use sha2::{Digest, Sha256};
    use svode_speech::catalog::{Language, License, Source};
    use svode_speech::client::RecognizerConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const BODY: &[u8] = b"a small model file served over HTTP";

    fn entry(content: &[u8]) -> CatalogModel {
        CatalogModel {
            id: "tiny".into(),
            name: "tiny".into(),
            family: "whisper".into(),
            mark: None,
            file: "tiny-Q8_0.gguf".into(),
            quant: "Q8_0".into(),
            source: Source {
                repo: "handy-computer/tiny-gguf".into(),
                revision: "0".repeat(40),
            },
            sha256: Sha256::digest(content)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            size: content.len() as u64,
            languages: BTreeMap::from([(Language::En, "en".to_string())]),
            detects_language: true,
            license: License {
                name: "MIT".into(),
                link: None,
            },
            upstream: "upstream/tiny".into(),
        }
    }

    enum Serve {
        Body(&'static [u8]),
        /// Sends the first bytes, then closes the connection.
        Broken(usize),
        /// Sends the first bytes, then stalls.
        Stalled(usize),
        NotFound,
    }

    async fn server(serve: Serve) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/tiny-Q8_0.gguf", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let _ = socket.read(&mut request).await;
            let header = |status: &str, length: usize| {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                )
            };
            match serve {
                Serve::Body(body) => {
                    let _ = socket
                        .write_all(header("200 OK", body.len()).as_bytes())
                        .await;
                    let _ = socket.write_all(body).await;
                }
                Serve::Broken(sent) => {
                    let _ = socket
                        .write_all(header("200 OK", BODY.len()).as_bytes())
                        .await;
                    let _ = socket.write_all(&BODY[..sent]).await;
                }
                Serve::Stalled(sent) => {
                    let _ = socket
                        .write_all(header("200 OK", BODY.len()).as_bytes())
                        .await;
                    let _ = socket.write_all(&BODY[..sent]).await;
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                }
                Serve::NotFound => {
                    let _ = socket
                        .write_all(header("404 Not Found", 0).as_bytes())
                        .await;
                }
            }
        });
        url
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        store: ModelStore,
        recognizer: Recognizer,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::open(dir.path().join("speech"));
        let recognizer = Recognizer::new(RecognizerConfig::new(
            PathBuf::from("svode-speech-not-started"),
            dir.path().join("speech/engine.json"),
            "0.0.9",
        ));
        Fixture {
            _dir: dir,
            store,
            recognizer,
        }
    }

    async fn download(
        fixture: &Fixture,
        model: &CatalogModel,
        url: &str,
        cancelled: &mut watch::Receiver<bool>,
    ) -> (Result<InstalledModel, DownloadError>, Vec<u64>) {
        let mut reported = Vec::new();
        let result = install(
            &client(),
            &fixture.store,
            &fixture.recognizer,
            model,
            url,
            cancelled,
            |received| reported.push(received),
        )
        .await;
        (result, reported)
    }

    #[tokio::test]
    async fn downloads_reports_progress_and_installs_the_checked_file() {
        let fixture = fixture();
        let url = server(Serve::Body(BODY)).await;
        let (_cancel, mut cancelled) = watch::channel(false);

        let (result, reported) = download(&fixture, &entry(BODY), &url, &mut cancelled).await;

        let installed = result.unwrap();
        assert_eq!(reported.last(), Some(&(BODY.len() as u64)));
        assert_eq!(
            std::fs::read(fixture.store.model_path(&installed)).unwrap(),
            BODY
        );
        assert_eq!(
            fixture.store.settings().active_model.as_deref(),
            Some("tiny")
        );
    }

    #[tokio::test]
    async fn a_broken_connection_or_a_missing_file_fails_without_a_model() {
        for serve in [Serve::Broken(10), Serve::NotFound] {
            let fixture = fixture();
            let url = server(serve).await;
            let (_cancel, mut cancelled) = watch::channel(false);

            let (result, _) = download(&fixture, &entry(BODY), &url, &mut cancelled).await;

            let error = result.unwrap_err();
            assert_eq!(error.failure(), JobFailure::Network, "{error}");
            assert!(fixture.store.installed().is_empty());
            assert!(!fixture.store.model_dir(".staging-tiny").exists());
        }
    }

    #[tokio::test]
    async fn a_file_unlike_the_catalog_is_an_integrity_failure() {
        let fixture = fixture();
        let url = server(Serve::Body(b"a small model file served over HTTPS")).await;
        let (_cancel, mut cancelled) = watch::channel(false);

        let (result, _) = download(&fixture, &entry(BODY), &url, &mut cancelled).await;

        assert_eq!(result.unwrap_err().failure(), JobFailure::Integrity);
        assert!(fixture.store.installed().is_empty());
    }

    #[tokio::test]
    async fn a_cancel_stops_the_download_and_keeps_the_previous_state() {
        let fixture = fixture();
        let url = server(Serve::Stalled(10)).await;
        let (cancel, mut cancelled) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = cancel.send(true);
        });

        let (result, _) = download(&fixture, &entry(BODY), &url, &mut cancelled).await;

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert!(fixture.store.installed().is_empty());
        assert!(!fixture.store.model_dir(".staging-tiny").exists());
        // The cancel released the claim: the model can be downloaded again.
        assert!(fixture.store.begin_install(&entry(BODY)).is_ok());
    }
}
