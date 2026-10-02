use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Where pinned package tarballs come from. Installation and update are the
/// only network use of an adapter; its launch downloads nothing.
pub trait PackageSource: Send + Sync {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>>;
}

const REGISTRY: &str = "https://registry.npmjs.org/";
const MAX_TARBALL_BYTES: usize = 64 * 1024 * 1024;

/// The public npm registry the pinned tarball URLs point to.
pub struct RegistryPackageSource {
    client: reqwest::Client,
}

impl RegistryPackageSource {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent("Svode-Adapter-Install/1")
            .build()
            .expect("failed to build adapter download client");
        Self { client }
    }
}

impl Default for RegistryPackageSource {
    fn default() -> Self {
        Self::new()
    }
}

impl PackageSource for RegistryPackageSource {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>> {
        Box::pin(async move {
            if !url.starts_with(REGISTRY) {
                return Err(format!("{url} is not on the npm registry"));
            }
            let mut response = self
                .client
                .get(url)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                if bytes.len() + chunk.len() > MAX_TARBALL_BYTES {
                    return Err("tarball exceeds the size limit".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
    }
}
