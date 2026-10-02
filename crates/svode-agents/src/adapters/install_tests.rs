use std::collections::HashMap;
use std::ffi::OsString;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;

use flate2::Compression;
use flate2::write::GzEncoder;

use super::*;
use crate::adapters::{AdapterError, adapter_pin};
use crate::registry::{
    AdapterTarget, RuntimeCommandOutput, RuntimeCommandRequest, RuntimeCommandRunner,
};

const REGISTRY: &str = "https://registry.npmjs.org/";

/// Tarballs by URL; `fail` makes one URL unreachable.
#[derive(Default)]
struct FixtureSource {
    tarballs: HashMap<String, Vec<u8>>,
    fail: Option<String>,
    fetched: StdMutex<Vec<String>>,
}

impl PackageSource for FixtureSource {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + 'a>> {
        Box::pin(async move {
            self.fetched.lock().unwrap().push(url.to_string());
            if self.fail.as_deref() == Some(url) {
                return Err("connection reset".into());
            }
            self.tarballs
                .get(url)
                .cloned()
                .ok_or_else(|| format!("{url} not found"))
        })
    }
}

struct Package {
    path: &'static str,
    files: Vec<(&'static str, &'static str, u32)>,
    optional: bool,
}

fn package(path: &'static str, files: &[(&'static str, &'static str)]) -> Package {
    Package {
        path,
        files: files
            .iter()
            .map(|(name, contents)| (*name, *contents, 0o644))
            .collect(),
        optional: false,
    }
}

fn tarball(files: &[(&str, &str, u32)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for (name, contents, mode) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(*mode);
        header.set_cksum();
        builder
            .append_data(&mut header, format!("package/{name}"), contents.as_bytes())
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn integrity(bytes: &[u8]) -> String {
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    )
}

fn url(path: &str, version: &str) -> String {
    format!("{REGISTRY}{}-{version}.tgz", path.replace('/', "_"))
}

/// A pin of a fixture adapter `fixture-acp` at `version` with its tree,
/// and the source that serves it.
fn fixture(version: &'static str, packages: Vec<Package>) -> (AdapterPin, FixtureSource) {
    let mut source = FixtureSource::default();
    let mut entries = Vec::new();
    for package in packages {
        let bytes = tarball(&package.files);
        let url = url(package.path, version);
        entries.push(serde_json::json!({
            "path": package.path,
            "version": version,
            "resolved": url,
            "integrity": integrity(&bytes),
            "optional": package.optional,
        }));
        source.tarballs.insert(url, bytes);
    }
    let manifest = serde_json::json!({ "packages": entries }).to_string();
    let pin = AdapterPin {
        agent: AgentAdapterKind::Codex,
        package: "fixture-acp",
        version,
        entry: "dist/index.js",
        node_major: 20,
        manifest: Box::leak(manifest.into_boxed_str()),
    };
    (pin, source)
}

fn adapter_tree() -> Vec<Package> {
    vec![
        package(
            "node_modules/fixture-acp",
            &[
                (
                    "package.json",
                    r#"{"name":"fixture-acp","scripts":{"postinstall":"touch ../../../postinstall-ran"}}"#,
                ),
                ("dist/index.js", "console.log('acp')"),
            ],
        ),
        package("node_modules/dep", &[("index.js", "module.exports = 1")]),
        package(
            "node_modules/fixture-acp/node_modules/nested",
            &[("index.js", "module.exports = 2")],
        ),
        Package {
            optional: true,
            ..package(
                "node_modules/@vendor/agent-darwin-arm64",
                &[("bin/agent", "native binary")],
            )
        },
    ]
}

fn names(dir: &Path) -> Vec<String> {
    let mut names = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[tokio::test]
async fn installs_the_pinned_tree_without_optional_platform_packages() {
    let root = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let (pin, source) = fixture("1.0.0", adapter_tree());
    assert_eq!(store.state(&pin), AdapterInstallState::NotInstalled);
    assert_eq!(store.installed(&pin), None);

    let installed = store.install(&pin, &source).await.unwrap();

    let dir = root.path().join("codex/1.0.0");
    assert_eq!(installed.dir, dir);
    assert_eq!(
        installed.entry,
        dir.join("node_modules/fixture-acp/dist/index.js")
    );
    assert!(installed.entry.is_file());
    assert!(dir.join("node_modules/dep/index.js").is_file());
    assert!(
        dir.join("node_modules/fixture-acp/node_modules/nested/index.js")
            .is_file()
    );
    // The agent's platform binary is neither downloaded nor installed.
    assert!(!dir.join("node_modules/@vendor").exists());
    assert!(
        !source
            .fetched
            .lock()
            .unwrap()
            .iter()
            .any(|url| url.contains("agent-darwin-arm64"))
    );
    assert_eq!(
        store.state(&pin),
        AdapterInstallState::Installed {
            version: "1.0.0".into()
        }
    );
    assert_eq!(store.installed(&pin), Some(installed));
    assert_eq!(names(&root.path().join("codex")), ["1.0.0"]);
}

#[tokio::test]
async fn package_scripts_never_run() {
    let root = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().join("adapters"));
    let (pin, source) = fixture("1.0.0", adapter_tree());

    store.install(&pin, &source).await.unwrap();

    let package_json = root
        .path()
        .join("adapters/codex/1.0.0/node_modules/fixture-acp/package.json");
    assert!(
        fs::read_to_string(package_json)
            .unwrap()
            .contains("postinstall")
    );
    assert!(!root.path().join("postinstall-ran").exists());
    assert!(!root.path().join("adapters/postinstall-ran").exists());
    assert!(!root.path().join("adapters/codex/postinstall-ran").exists());
}

#[tokio::test]
async fn an_integrity_mismatch_or_failed_download_leaves_the_previous_state() {
    let root = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let (old_pin, old_source) = fixture("1.0.0", adapter_tree());
    let installed = store.install(&old_pin, &old_source).await.unwrap();

    let (pin, mut source) = fixture("2.0.0", adapter_tree());
    let dep = url("node_modules/dep", "2.0.0");
    source
        .tarballs
        .insert(dep.clone(), tarball(&[("index.js", "tampered", 0o644)]));
    assert_eq!(
        store.install(&pin, &source).await,
        Err(AdapterError::Integrity {
            package: "dep".into()
        })
    );
    assert_eq!(names(&root.path().join("codex")), ["1.0.0"]);
    assert_eq!(store.installed(&old_pin), Some(installed.clone()));

    let (pin, mut source) = fixture("2.0.0", adapter_tree());
    source.fail = Some(url("node_modules/fixture-acp/node_modules/nested", "2.0.0"));
    assert_eq!(
        store.install(&pin, &source).await,
        Err(AdapterError::Download {
            package: "nested".into(),
            message: "connection reset".into()
        })
    );
    assert_eq!(names(&root.path().join("codex")), ["1.0.0"]);
    assert_eq!(store.installed(&old_pin), Some(installed));
    assert_eq!(
        store.state(&pin),
        AdapterInstallState::NeedsUpdate {
            installed_version: "1.0.0".into()
        }
    );
}

#[tokio::test]
async fn another_pin_needs_an_update_that_removes_the_previous_version_after_the_switch() {
    let root = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let (old_pin, old_source) = fixture("1.0.0", adapter_tree());
    store.install(&old_pin, &old_source).await.unwrap();

    let (pin, source) = fixture("2.0.0", adapter_tree());
    assert_eq!(
        store.state(&pin),
        AdapterInstallState::NeedsUpdate {
            installed_version: "1.0.0".into()
        }
    );
    assert_eq!(store.installed(&pin), None);

    let installed = store.install(&pin, &source).await.unwrap();

    assert!(installed.entry.is_file());
    assert_eq!(names(&root.path().join("codex")), ["2.0.0"]);
    assert_eq!(
        store.state(&pin),
        AdapterInstallState::Installed {
            version: "2.0.0".into()
        }
    );
}

#[tokio::test]
async fn reinstalling_the_same_version_replaces_it() {
    let root = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let (pin, source) = fixture("1.0.0", adapter_tree());
    store.install(&pin, &source).await.unwrap();
    let stray = root.path().join("codex/1.0.0/node_modules/dep/stray.js");
    fs::write(&stray, "left behind").unwrap();

    store.install(&pin, &source).await.unwrap();

    assert!(!stray.exists());
    assert_eq!(names(&root.path().join("codex")), ["1.0.0"]);
}

#[tokio::test]
async fn an_incomplete_version_directory_is_not_an_installation() {
    let root = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let (pin, _) = fixture("1.0.0", adapter_tree());
    fs::create_dir_all(
        root.path()
            .join("codex/1.0.0/node_modules/fixture-acp/dist"),
    )
    .unwrap();
    fs::create_dir_all(root.path().join("codex/.staging-01")).unwrap();

    assert_eq!(store.state(&pin), AdapterInstallState::NotInstalled);
}

#[tokio::test]
async fn removal_touches_only_the_agents_svode_directory() {
    let root = tempfile::tempdir().unwrap();
    let adapters = root.path().join("adapters");
    let store = AdapterStore::new(adapters.clone());
    let (pin, source) = fixture("1.0.0", adapter_tree());
    store.install(&pin, &source).await.unwrap();
    fs::create_dir_all(adapters.join("claude-code/0.1.0")).unwrap();
    fs::write(adapters.join("claude-code/0.1.0/keep"), "other agent").unwrap();
    fs::write(root.path().join("native-config.toml"), "user config").unwrap();

    assert_eq!(store.uninstall(AgentAdapterKind::Codex).await, Ok(true));

    assert_eq!(names(&adapters), ["claude-code"]);
    assert!(adapters.join("claude-code/0.1.0/keep").is_file());
    assert!(root.path().join("native-config.toml").is_file());
    assert_eq!(store.state(&pin), AdapterInstallState::NotInstalled);
    assert_eq!(store.uninstall(AgentAdapterKind::Codex).await, Ok(false));
}

#[tokio::test]
async fn unsafe_tarball_paths_are_refused_and_links_skipped() {
    let mut header = tar::Header::new_old();
    let name = b"package/../escaped.js";
    header.as_old_mut().name[..name.len()].copy_from_slice(name);
    header.set_size(1);
    header.set_mode(0o644);
    header.set_cksum();
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    builder.append(&header, &b"x"[..]).unwrap();
    let escaping = builder.into_inner().unwrap().finish().unwrap();
    let target = tempfile::tempdir().unwrap();
    assert!(unpack(&escaping, &target.path().join("pkg")).is_err());
    assert!(!target.path().join("escaped.js").exists());

    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    let mut link = tar::Header::new_gnu();
    link.set_entry_type(tar::EntryType::Symlink);
    link.set_size(0);
    builder
        .append_link(&mut link, "package/link", "/etc/passwd")
        .unwrap();
    let linking = builder.into_inner().unwrap().finish().unwrap();
    unpack(&linking, &target.path().join("pkg")).unwrap();
    assert!(target.path().join("pkg/link").symlink_metadata().is_err());
}

struct NodeRunner(&'static str);

impl RuntimeCommandRunner for NodeRunner {
    fn run<'a>(
        &'a self,
        _request: &'a RuntimeCommandRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RuntimeCommandOutput, String>> + Send + 'a>> {
        Box::pin(async move {
            Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: self.0.to_string(),
                stderr: String::new(),
            })
        })
    }
}

fn target(path: &Path) -> AdapterTarget {
    AdapterTarget {
        cwd: path.to_path_buf(),
        search_path: Some(OsString::from(path)),
    }
}

#[tokio::test]
async fn without_node_of_the_required_version_nothing_is_downloaded() {
    let root = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let source = FixtureSource::default();

    assert_eq!(
        store
            .install_adapter(
                AgentAdapterKind::ClaudeCode,
                &target(bin.path()),
                &NodeRunner("v22.0.0"),
                &source,
            )
            .await,
        Err(AdapterError::NodeMissing { required: 22 })
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let node = bin.path().join("node");
        fs::write(&node, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            store
                .install_adapter(
                    AgentAdapterKind::ClaudeCode,
                    &target(bin.path()),
                    &NodeRunner("v20.19.0\n"),
                    &source,
                )
                .await,
            Err(AdapterError::NodeUnsupported {
                version: "v20.19.0".into(),
                required: 22
            })
        );
    }

    assert!(source.fetched.lock().unwrap().is_empty());
    assert!(names(root.path()).is_empty());
}

#[test]
fn release_pins_fix_a_verifiable_tree_without_agent_binaries() {
    for agent in AgentAdapterKind::ALL {
        let pin = adapter_pin(agent).unwrap();
        let manifest = parse_manifest(pin).unwrap();
        let root = format!("node_modules/{}", pin.package);
        assert!(
            manifest
                .packages
                .iter()
                .any(|package| package.path == root && !package.optional)
        );
        for package in &manifest.packages {
            assert!(package_dir(&package.path).is_some(), "{}", package.path);
            assert!(package.resolved.starts_with(REGISTRY), "{}", package.path);
            assert!(package.integrity.starts_with("sha512-"), "{}", package.path);
            let name = package_name(&package.path);
            let platform_binary = name.starts_with("@openai/codex-")
                || name.starts_with("@anthropic-ai/claude-agent-sdk-");
            assert_eq!(platform_binary, package.optional, "{name}");
        }
    }
}

#[tokio::test]
async fn enabling_installs_only_a_missing_adapter() {
    let root = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let store = AdapterStore::new(root.path().to_path_buf());
    let source = FixtureSource::default();
    let pin = adapter_pin(AgentAdapterKind::Codex).unwrap();

    assert_eq!(
        store
            .prepare_enable(
                AgentAdapterKind::Codex,
                &target(bin.path()),
                &NodeRunner("v22.0.0"),
                &source,
            )
            .await,
        Err(AdapterError::NodeMissing { required: 20 })
    );

    let stale = root.path().join("codex/0.0.1");
    fs::create_dir_all(&stale).unwrap();
    fs::write(
        stale.join(MARKER),
        format!(r#"{{"package":"{}","version":"0.0.1"}}"#, pin.package),
    )
    .unwrap();
    assert_eq!(
        store
            .prepare_enable(
                AgentAdapterKind::Codex,
                &target(bin.path()),
                &NodeRunner("v22.0.0"),
                &source,
            )
            .await,
        Ok(())
    );
    assert!(source.fetched.lock().unwrap().is_empty());
    assert_eq!(
        store.state(pin),
        AdapterInstallState::NeedsUpdate {
            installed_version: "0.0.1".into()
        }
    );
}
