//! Download through real Git LFS and the built sidecar after connecting this
//! device or repairing an old Windows registration.

mod common;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use common::s3::S3Stand;
use serde_json::json;
use svode_core::git::ops::ensure_svode_gitignore;
use svode_core::git::state::GitRuntime;
use svode_core::storage::config::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy};
use svode_core::storage::connection::{ConnectRequest, check_readiness, connect};
use svode_core::storage::lfs::LfsState;
use svode_core::storage::lfs_download::{DownloadPlan, download, missing_files, plan_download};
use svode_core::storage::s3::{CONFIG_REL, SecretBindings};

const PATH_KEY: &str = "lfs.customtransfer.svode-lfs.path";
const TEST_ROOT: &str = "SVODE_LFS_REGISTRATION_FIXTURE";
const ACCESS: &str = "fixture-access";

fn sidecar_name() -> String {
    format!("svode-lfs{}", env::consts::EXE_SUFFIX)
}

/// Re-enter the test from a temporary installation with its own Git settings
/// and synthetic credentials, without mutating the test process's environment.
fn isolated_install(test: &str) -> Option<PathBuf> {
    if let Some(root) = env::var_os(TEST_ROOT) {
        return Some(root.into());
    }
    // Tauri's check build can stage a placeholder at the normal output path.
    let source = env::var_os("SVODE_STORAGE_TEST_SIDECAR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(common::process::BIN).with_file_name(sidecar_name()));
    let tools = Command::new("git")
        .args(["lfs", "version"])
        .output()
        .is_ok_and(|out| out.status.success());
    if !tools || !source.is_file() {
        let message = "requires Git LFS and the sidecar (`cargo build -p svode-lfs`)";
        assert!(
            env::var_os("SVODE_STORAGE_REQUIRE_TOOLS").is_none(),
            "{message}"
        );
        eprintln!("skipped: {message}");
        return None;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let root = if cfg!(windows) {
        PathBuf::from(svode_core::system_path::user_facing_path(&root))
    } else {
        root
    };
    let install = root.join("Svode install");
    fs::create_dir(&install).unwrap();
    let harness = install.join(format!("fixture{}", env::consts::EXE_SUFFIX));
    fs::copy(env::current_exe().unwrap(), &harness).unwrap();
    fs::copy(source, install.join(sidecar_name())).unwrap();

    let config = root.join("fixture.gitconfig");
    fs::write(
        &config,
        "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[core]\n\tautocrlf = false\n",
    )
    .unwrap();
    let mut command = Command::new(harness);
    for (key, _) in env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("GIT_") || name.starts_with("SVODE_SECRET_") {
            command.env_remove(key);
        }
    }
    let output = command
        .args(["--exact", test, "--nocapture"])
        .current_dir(&root)
        .env(TEST_ROOT, &root)
        .env("GIT_CONFIG_GLOBAL", config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("NO_PROXY", "127.0.0.1")
        .env("no_proxy", "127.0.0.1")
        .env("SVODE_SECRET_DF384_ACCESS", ACCESS)
        .env("SVODE_SECRET_DF384_SECRET", "fixture-secret")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{test} failed in the isolated installation:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr),
    );
    None
}

struct Fixture {
    repo: PathBuf,
    sidecar: PathBuf,
    git: GitRuntime,
    assets: AssetsSpaceConfig,
    stand: S3Stand,
    files: [(&'static str, Vec<u8>); 2],
}

impl Fixture {
    async fn connected(root: &Path) -> Self {
        let stand = S3Stand::start(ACCESS);
        let assets = AssetsSpaceConfig {
            strategy: AssetsStrategy::LfsS3,
            s3: Some(AssetsS3Config {
                endpoint: stand.endpoint.clone(),
                bucket: "assets".into(),
                region: "us-east-1".into(),
                prefix: "download-fixture".into(),
                extensions: Default::default(),
            }),
            ..Default::default()
        };
        let repo = root.join("Project with spaces");
        fs::create_dir_all(repo.join(".svode")).unwrap();
        fs::write(
            repo.join(".svode/config.json"),
            json!({"name": "Fixture", "assets": assets}).to_string(),
        )
        .unwrap();
        fs::write(
            repo.join(".gitattributes"),
            "*.png filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        fs::write(
            repo.join(".lfsconfig"),
            "[lfs]\n\turl = https://lfs-s3.svode.invalid/\n",
        )
        .unwrap();
        let fixture = Self {
            repo,
            sidecar: root.join("Svode install").join(sidecar_name()),
            git: GitRuntime::new(),
            assets,
            stand,
            files: [
                ("trees.png", b"trees".repeat(19_031)),
                ("cover.png", b"cover".repeat(136_031)),
            ],
        };
        fixture.git(&["init", "-q"]).await;
        fixture
            .git(&[
                "remote",
                "add",
                "origin",
                "https://fixture.invalid/repo.git",
            ])
            .await;
        fixture
            .git(&["config", "--local", "lfs.concurrenttransfers", "2"])
            .await;
        ensure_svode_gitignore(&fixture.repo).unwrap();

        let blob = root.join("blob.png");
        for (name, data) in &fixture.files {
            fs::write(&blob, data).unwrap();
            let pointer = fixture
                .git(&["lfs", "pointer", "--file", blob.to_str().unwrap()])
                .await;
            let oid = pointer
                .lines()
                .find_map(|line| line.strip_prefix("oid sha256:"))
                .unwrap();
            fixture.stand.put(
                &format!(
                    "/assets/download-fixture/{}/{}/{oid}",
                    &oid[..2],
                    &oid[2..4]
                ),
                data,
            );
            fs::write(fixture.repo.join(name), format!("{pointer}\n")).unwrap();
        }
        // Commit the pointers before installing the LFS filter: only the
        // isolated S3 stand has the objects at the start of the download.
        fixture.git(&["add", "--all"]).await;
        fixture.git(&["commit", "-qm", "LFS pointers"]).await;

        let catalog = root.join("catalog");
        fs::create_dir(&catalog).unwrap();
        fs::write(
            catalog.join("settings.json"),
            json!({"variables": {
                "DF384_ACCESS": {"kind": "secret", "secretRef": "secret:01ARZ3NDEKTSV4RRFFQ69G5FAV"},
                "DF384_SECRET": {"kind": "secret", "secretRef": "secret:01ARZ3NDEKTSV4RRFFQ69G5FAW"}
            }})
            .to_string(),
        )
        .unwrap();
        let bindings: SecretBindings = serde_json::from_value(json!({
            "accessKey": {"owner": {"scope": "global"}, "name": "DF384_ACCESS"},
            "secretKey": {"owner": {"scope": "global"}, "name": "DF384_SECRET"},
        }))
        .unwrap();
        connect(
            &fixture.git,
            ConnectRequest {
                catalog_dir: &catalog,
                project_path: &fixture.repo,
                space_id: None,
                repo_dir: &fixture.repo,
                config: &fixture.assets,
                bindings,
            },
        )
        .await
        .unwrap();
        assert!(!fixture.repo.join(".git/lfs/objects").exists());
        fixture
    }

    async fn git(&self, args: &[&str]) -> String {
        let out = self
            .git
            .cli()
            .unwrap()
            .exec(&self.repo, args)
            .await
            .unwrap();
        assert_eq!(out.exit_code, 0, "git {args:?}: {}", out.stderr);
        out.stdout.trim().to_owned()
    }

    async fn assert_working_path(&self) {
        let saved = self.git(&["config", "--local", "--get", PATH_KEY]).await;
        let binary = self.sidecar.canonicalize().unwrap();
        if cfg!(windows) {
            assert!(!saved.starts_with(r"\\?\"), "registered {saved}");
            assert_eq!(Path::new(&saved).canonicalize().unwrap(), binary);
        } else {
            assert_eq!(Path::new(&saved), binary);
        }
        assert!(Path::new(&saved).is_absolute());
        assert!(saved.contains("Svode install"));
    }

    /// Mark the saved config so a byte-identical rewrite is visible as well.
    fn mark_config_mtime(&self) -> (Vec<u8>, std::time::SystemTime) {
        let config = self.repo.join(".git/config");
        fs::File::options()
            .write(true)
            .open(&config)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000))
            .unwrap();
        self.config_stamp()
    }

    fn config_stamp(&self) -> (Vec<u8>, std::time::SystemTime) {
        let config = self.repo.join(".git/config");
        (
            fs::read(&config).unwrap(),
            fs::metadata(config).unwrap().modified().unwrap(),
        )
    }

    async fn assert_downloads_both_objects(&self) {
        let head = self.git(&["rev-parse", "HEAD"]).await;
        let agent = fs::read(self.repo.join(CONFIG_REL)).unwrap();
        let requests_before = self.stand.requests().len();
        let plan = plan_download(&self.git, &self.repo, &self.assets)
            .await
            .unwrap();
        let DownloadPlan::Download(missing) = plan else {
            panic!("expected a download, got {plan:?}");
        };
        assert_eq!(missing.files().len(), self.files.len());
        let cli = self.git.cli().unwrap();
        let outcome = download(&self.git, cli, &self.repo, &missing).await;
        assert!(outcome.stop.is_none(), "{outcome:?}");
        assert!(outcome.missing.is_empty(), "{outcome:?}");
        assert!(missing_files(cli, &self.repo).await.unwrap().is_empty());
        for (name, data) in &self.files {
            assert_eq!(&fs::read(self.repo.join(name)).unwrap(), data);
        }
        assert_eq!(self.git(&["rev-parse", "HEAD"]).await, head);
        assert_eq!(self.git(&["status", "--porcelain"]).await, "");
        assert_eq!(fs::read(self.repo.join(CONFIG_REL)).unwrap(), agent);
        assert_eq!(
            self.git(&["config", "--local", "--get", "lfs.concurrenttransfers"])
                .await,
            "2",
        );
        let transfers = self.stand.requests();
        assert!(transfers.len() > requests_before);
        assert!(transfers[requests_before..].iter().all(|request| {
            request.starts_with("GET /assets/download-fixture/")
                || request.starts_with("HEAD /assets/download-fixture/")
        }));
    }
}

#[tokio::test]
async fn download_uses_the_new_registration_without_rewriting_it() {
    let Some(root) = isolated_install("download_uses_the_new_registration_without_rewriting_it")
    else {
        return;
    };
    let fixture = Fixture::connected(&root).await;
    fixture.assert_working_path().await;
    let config = fixture.mark_config_mtime();
    fixture.assert_downloads_both_objects().await;
    assert_eq!(fixture.config_stamp(), config);
    assert_eq!(
        check_readiness(&fixture.git, &fixture.repo, &fixture.assets, true).await,
        Ok(LfsState::Ready),
    );
    assert_eq!(fixture.config_stamp(), config);
}

#[tokio::test]
async fn download_repairs_a_stale_registration_and_can_retry_after_refusal() {
    use svode_core::storage::connection::LfsNotReady;

    let Some(root) =
        isolated_install("download_repairs_a_stale_registration_and_can_retry_after_refusal")
    else {
        return;
    };
    let fixture = Fixture::connected(&root).await;
    let old = if cfg!(windows) {
        let verbatim = fixture.sidecar.canonicalize().unwrap();
        assert!(verbatim.to_str().unwrap().starts_with(r"\\?\") && verbatim.is_file());
        verbatim
    } else {
        root.join("Previous installation").join(sidecar_name())
    };
    fixture
        .git(&["config", "--local", PATH_KEY, old.to_str().unwrap()])
        .await;
    let config = fixture.mark_config_mtime();
    assert!(matches!(
        check_readiness(&fixture.git, &fixture.repo, &fixture.assets, false).await,
        Err(LfsNotReady::S3NotConnected { .. }),
    ));
    assert_eq!(fixture.config_stamp(), config);

    // Git refuses the first attempt to fix the registration. Planning must
    // keep both files on the retry list and send nothing to the S3 stand.
    let lock = fixture.repo.join(".git/config.lock");
    fs::write(&lock, b"held by another Git process").unwrap();
    let requests = fixture.stand.requests();
    let waiting = missing_files(fixture.git.cli().unwrap(), &fixture.repo)
        .await
        .unwrap();
    assert_eq!(waiting.files().len(), 2);
    assert_eq!(
        plan_download(&fixture.git, &fixture.repo, &fixture.assets)
            .await
            .unwrap(),
        DownloadPlan::NotReady {
            state: LfsState::MissingCreds,
            missing: waiting
        },
    );
    assert_eq!(fixture.stand.requests(), requests);
    assert_eq!(fixture.config_stamp(), config);
    fs::remove_file(&lock).unwrap();

    fixture.assert_downloads_both_objects().await;
    fixture.assert_working_path().await;
    let repaired = fixture.mark_config_mtime();
    assert_eq!(
        check_readiness(&fixture.git, &fixture.repo, &fixture.assets, true).await,
        Ok(LfsState::Ready),
    );
    assert_eq!(fixture.config_stamp(), repaired);
}
