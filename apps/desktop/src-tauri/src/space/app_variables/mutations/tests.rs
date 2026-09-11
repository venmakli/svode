use super::*;
use crate::space::{
    app_variables::storage_error, config::write_git_user_policy, types::GitUserPolicy,
};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    fs,
};
use svode_core::variables::{
    self as core, Context, Kind, Mode, Save, SaveOperation, SecretStore, Service, SourceOwner,
};

#[derive(Default)]
struct Secrets {
    values: RefCell<BTreeMap<String, String>>,
    fail_remove: Cell<bool>,
}
impl SecretStore for Secrets {
    fn get(&self, key: &str) -> core::Result<Option<String>> {
        Ok(self.values.borrow().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> core::Result<()> {
        self.values.borrow_mut().insert(key.into(), value.into());
        Ok(())
    }
    fn remove(&self, key: &str) -> core::Result<()> {
        if self.fail_remove.get() {
            return Err(core::Error::SecretStore);
        }
        self.values.borrow_mut().remove(key);
        Ok(())
    }
}
struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    path: PathBuf,
    repo: PathBuf,
    owner: Owner,
    git: GitState,
    secrets: Secrets,
    events: RefCell<Vec<(PathBuf, PathBuf, bool)>>,
    submodule: bool,
}
async fn git(cli: &crate::git::cli::GitCli, path: &Path, args: &[&str]) -> String {
    let out = cli.exec(path, args).await.unwrap();
    assert_eq!(out.exit_code, 0, "{args:?}: {}", out.stderr);
    out.stdout
}
async fn init(cli: &crate::git::cli::GitCli, path: &Path) {
    fs::create_dir_all(path.join(".svode")).unwrap();
    git(cli, path, &["init"]).await;
    git(cli, path, &["config", "user.name", "Variables Test"]).await;
    git(
        cli,
        path,
        &["config", "user.email", "variables@example.test"],
    )
    .await;
    git(cli, path, &["config", "commit.gpgsign", "false"]).await;
    fs::write(
        path.join(".gitignore"),
        "**/.svode/local.json\n**/.svode/lfs-s3-agent.json\n**/.svode/variables.*\nglobal/\n",
    )
    .unwrap();
    core::files::atomic_write(&path.join(".svode/config.json"), &json!({"name":"Test"})).unwrap();
    fs::write(path.join("other.txt"), "base\n").unwrap();
}
impl Fixture {
    async fn new(
        kind: &str,
        system: bool,
        structural: bool,
        child_structural: bool,
        root_system: bool,
    ) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let state = GitState::new();
        let cli = state
            .cli
            .as_ref()
            .expect("Git is required for this acceptance");
        init(cli, &root).await;
        let path = if kind == "root" {
            root.clone()
        } else {
            root.join("child")
        };
        if kind != "root" {
            fs::create_dir_all(path.join(".svode")).unwrap();
            core::files::atomic_write(&path.join(".svode/config.json"), &json!({"name":"Child"}))
                .unwrap();
            let mut config = core::files::read(&root.join(".svode/config.json"), true).unwrap();
            config["spaces"] = json!([{"id":"child","path":"child"}]);
            core::files::atomic_write(&root.join(".svode/config.json"), &config).unwrap();
        }
        let separate = matches!(kind, "independent" | "submodule");
        if separate {
            init(cli, &path).await;
            git(cli, &path, &["add", "."]).await;
            git(cli, &path, &["commit", "-m", "Child baseline"]).await;
        }
        if kind == "independent" {
            use std::io::Write;
            writeln!(
                fs::OpenOptions::new()
                    .append(true)
                    .open(root.join(".gitignore"))
                    .unwrap(),
                "child/"
            )
            .unwrap();
        }
        if kind == "submodule" {
            fs::write(
                root.join(".gitmodules"),
                "[submodule \"child\"]\n\tpath = child\n\turl = ./child\n",
            )
            .unwrap();
        }
        git(cli, &root, &["add", "."]).await;
        git(cli, &root, &["commit", "-m", "Root baseline"]).await;
        let repo = if separate { path.clone() } else { root.clone() };
        let owner = Owner::in_context(
            &Context::new(
                &root,
                (kind != "root").then_some("child"),
                &root.join("global"),
            )
            .unwrap(),
            &if kind == "root" {
                SourceOwner::Project
            } else {
                SourceOwner::Space { id: "child".into() }
            },
        )
        .unwrap();
        write_git_user_policy(
            &root,
            &GitUserPolicy {
                auto_sync: true,
                auto_commit_system: if separate { root_system } else { system },
                auto_commit_structural: structural,
            },
        )
        .unwrap();
        if separate {
            write_git_user_policy(
                &path,
                &GitUserPolicy {
                    auto_sync: true,
                    auto_commit_system: system,
                    auto_commit_structural: child_structural,
                },
            )
            .unwrap();
        }
        Self {
            _tmp: tmp,
            root,
            path,
            repo,
            owner,
            git: state,
            secrets: Secrets::default(),
            events: RefCell::new(vec![]),
            submodule: kind == "submodule",
        }
    }
    fn cli(&self) -> &crate::git::cli::GitCli {
        self.git.cli.as_ref().unwrap()
    }
    fn save_raw(
        &self,
        name: &str,
        mode: Mode,
        kind: Kind,
        value: Option<&str>,
    ) -> Result<Option<Change>, AppError> {
        let service = Service::new(&self.secrets);
        let catalog = service.catalog(&self.owner).map_err(storage_error)?;
        let operation = if catalog.entries.iter().any(|e| e.name == name) {
            SaveOperation::Edit
        } else {
            SaveOperation::Create
        };
        service
            .save(
                &self.owner,
                Save {
                    name: name.into(),
                    mode,
                    kind,
                    value: value.map(str::to_string),
                    revision: catalog.revision,
                    operation,
                    keep: None,
                },
            )
            .map(Some)
            .map_err(storage_error)
    }
    async fn apply(
        &self,
        write: impl Future<Output = Result<Option<Change>, AppError>>,
    ) -> Result<Mutation, AppError> {
        apply(
            &self.owner,
            Some(&self.root),
            &self.git,
            write,
            |_, space, repo| {
                autocommit::dispatch_exact_path_commit(
                    space,
                    repo,
                    |space, repo| {
                        self.events
                            .borrow_mut()
                            .push((space.into(), repo.into(), false))
                    },
                    |_| self.events.borrow_mut().last_mut().unwrap().2 = true,
                );
            },
        )
        .await
    }
    async fn save(&self, name: &str, mode: Mode, kind: Kind, value: Option<&str>) -> Mutation {
        self.apply(async { self.save_raw(name, mode, kind, value) })
            .await
            .unwrap()
    }
    async fn recover(&self) -> Result<Mutation, AppError> {
        self.apply(async {
            Service::new(&self.secrets)
                .recover(&self.owner)
                .map_err(storage_error)
        })
        .await
    }
    async fn count(&self, path: &Path) -> usize {
        git(self.cli(), path, &["rev-list", "--count", "HEAD"])
            .await
            .trim()
            .parse()
            .unwrap()
    }
    async fn manual(&self) {
        let path = self.path.join(".svode/config.json");
        ops::commit_exact_path(
            self.cli(),
            &self.repo,
            path.strip_prefix(&self.repo).unwrap().to_str().unwrap(),
            "Manual variables",
        )
        .await
        .unwrap();
        if self.submodule {
            ops::commit_exact_path(self.cli(), &self.root, "child", "Manual pointer")
                .await
                .unwrap();
        }
    }
    async fn assert_effect(
        &self,
        before: (usize, usize, usize),
        mutation: &Mutation,
        portable: bool,
        system: bool,
        structural: bool,
    ) {
        let config_commit = portable && system;
        let pointer_commit = config_commit && structural && self.submodule;
        assert_eq!(
            self.count(&self.repo).await - before.0,
            usize::from(config_commit)
        );
        if self.repo != self.root {
            assert_eq!(
                self.count(&self.root).await - before.1,
                usize::from(pointer_commit)
            );
        }
        assert_eq!(
            self.events.borrow().len() - before.2,
            usize::from(config_commit) + usize::from(pointer_commit)
        );
        if !portable {
            assert!(mutation.effect.is_none());
            return;
        }
        let effect = mutation.effect.as_ref().unwrap();
        assert_eq!(effect.owner_path, self.path);
        assert_eq!(
            effect.config,
            if system {
                ExactPathPersistenceOutcome::Committed
            } else {
                ExactPathPersistenceOutcome::Pending {
                    reason: ExactPathPendingReason::PolicyOff,
                }
            }
        );
        if config_commit {
            let paths = git(
                self.cli(),
                &self.repo,
                &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
            )
            .await;
            assert_eq!(
                paths.trim(),
                self.path
                    .join(".svode/config.json")
                    .strip_prefix(&self.repo)
                    .unwrap()
                    .to_str()
                    .unwrap()
            );
            let blob = git(
                self.cli(),
                &self.repo,
                &["show", &format!("HEAD:{}", paths.trim())],
            )
            .await;
            assert!(!blob.contains("secretRef"));
            assert!(!blob.contains("synthetic-secret"));
        }
        if pointer_commit {
            assert_eq!(
                git(
                    self.cli(),
                    &self.root,
                    &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]
                )
                .await
                .trim(),
                "child"
            );
        }
    }
    async fn before(&self) -> (usize, usize, usize) {
        (
            self.count(&self.repo).await,
            self.count(&self.root).await,
            self.events.borrow().len(),
        )
    }
}

#[tokio::test]
async fn owners_flags_crud_and_transitions_real_git_matrix() {
    for kind in ["root", "inline", "independent", "submodule"] {
        for system in [false, true] {
            for structural in [false, true] {
                let f = Fixture::new(kind, system, structural, !structural, !system).await;
                for (mode, kind, value, portable) in [
                    (Mode::Local, Kind::Variable, Some("local"), false),
                    (Mode::Git, Kind::Variable, Some("first"), true),
                    (Mode::Git, Kind::Variable, Some("second"), true),
                    (Mode::Git, Kind::Variable, Some("second"), false),
                    (Mode::Git, Kind::Secret, Some("synthetic-secret-one"), true),
                    (Mode::Git, Kind::Secret, Some("synthetic-secret-two"), false),
                    (Mode::Git, Kind::Secret, None, false),
                    (Mode::Local, Kind::Secret, None, true),
                    (Mode::Git, Kind::Secret, None, true),
                    (Mode::Git, Kind::Variable, Some("public"), true),
                    (Mode::Local, Kind::Variable, Some("device"), true),
                    (
                        Mode::Local,
                        Kind::Secret,
                        Some("synthetic-secret-three"),
                        false,
                    ),
                    (Mode::Local, Kind::Variable, Some("local"), false),
                    (Mode::Git, Kind::Secret, None, true),
                ] {
                    let before = f.before().await;
                    let result = f.save("VALUE", mode, kind, value).await;
                    f.assert_effect(before, &result, portable, system, structural)
                        .await;
                    f.manual().await;
                }
                let before = f.before().await;
                let removed = f
                    .apply(async {
                        let service = Service::new(&f.secrets);
                        let revision = service.catalog(&f.owner).unwrap().revision;
                        service
                            .remove(&f.owner, "VALUE", &revision)
                            .map(Some)
                            .map_err(storage_error)
                    })
                    .await
                    .unwrap();
                f.assert_effect(before, &removed, true, system, structural)
                    .await;
                let count = f.before().await;
                assert!(f.recover().await.unwrap().effect.is_none());
                assert_eq!(count, f.before().await);
                for (space, repo, sync) in f.events.borrow().iter() {
                    assert_eq!(space, &f.path);
                    assert!(repo == &f.repo || repo == &f.root);
                    assert!(*sync);
                }
            }
        }
    }
}

#[tokio::test]
async fn independent_child_structural_and_root_system_flags_never_grant_pointer_or_config() {
    for system in [false, true] {
        for structural in [false, true] {
            for child_structural in [false, true] {
                for root_system in [false, true] {
                    let f = Fixture::new(
                        "submodule",
                        system,
                        structural,
                        child_structural,
                        root_system,
                    )
                    .await;
                    let before = f.before().await;
                    let result = f
                        .save("FLAG", Mode::Git, Kind::Variable, Some("value"))
                        .await;
                    f.assert_effect(before, &result, true, system, structural)
                        .await;
                }
            }
        }
    }
}

#[tokio::test]
async fn safety_skips_preserve_target_and_staged_bytes() {
    for reason in ["target", "index", "race", "staged-race", "head-race"] {
        let f = Fixture::new("inline", true, true, true, true).await;
        if reason == "target" {
            let mut config = core::files::read(&f.path.join(".svode/config.json"), true).unwrap();
            config["description"] = json!("user work");
            core::files::atomic_write(&f.path.join(".svode/config.json"), &config).unwrap();
        }
        if reason == "index" {
            fs::write(f.root.join("other.txt"), "staged work").unwrap();
            git(f.cli(), &f.root, &["add", "other.txt"]).await;
            fs::write(f.root.join("other.txt"), "working copy").unwrap();
        }
        let index_before = fs::read(f.root.join(".git/index")).unwrap();
        let count = f.before().await;
        let result = f
            .apply(async {
                let change = f.save_raw("SAFE", Mode::Git, Kind::Variable, Some("value"))?;
                if reason == "race" {
                    fs::write(f.path.join(".svode/config.json"), "{\"name\":\"external\"}")
                        .unwrap();
                }
                if reason == "staged-race" {
                    fs::write(f.root.join("other.txt"), "new staged work").unwrap();
                    git(f.cli(), &f.root, &["add", "other.txt"]).await;
                }
                if reason == "head-race" {
                    git(
                        f.cli(),
                        &f.root,
                        &["commit", "--allow-empty", "-m", "Foreign"],
                    )
                    .await;
                }
                Ok(change)
            })
            .await
            .unwrap();
        assert!(matches!(
            result.effect.unwrap().config,
            ExactPathPersistenceOutcome::Pending { .. }
        ));
        assert_eq!(f.events.borrow().len(), 0);
        assert_eq!(
            f.count(&f.repo).await - count.0,
            usize::from(reason == "head-race")
        );
        if reason == "index" {
            assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index_before);
            assert_eq!(
                git(f.cli(), &f.root, &["show", ":other.txt"]).await,
                "staged work"
            );
        }
    }
}

#[tokio::test]
async fn git_failure_and_missing_git_leave_successful_crud_without_secret_diagnostics() {
    for missing in [false, true] {
        let mut f = Fixture::new("root", true, true, true, true).await;
        let before = f.before().await;
        if missing {
            f.git.cli = None;
        } else {
            fail_commit(&f.root);
        }
        let result = f
            .save(
                "DECLARATION",
                Mode::Git,
                Kind::Secret,
                Some("synthetic-secret"),
            )
            .await;
        assert!(matches!(
            result.effect.as_ref().unwrap().config,
            ExactPathPersistenceOutcome::Failed { .. }
        ));
        assert!(
            !serde_json::to_string(&result.effect)
                .unwrap()
                .contains("synthetic-secret")
        );
        assert_eq!(
            Service::new(&f.secrets)
                .catalog(&f.owner)
                .unwrap()
                .entries
                .len(),
            1
        );
        assert_eq!(f.events.borrow().len(), before.2);
        let repeat = f.save("DECLARATION", Mode::Git, Kind::Secret, None).await;
        assert!(repeat.effect.is_none());
    }
}
fn fail_commit(repo: &Path) {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    let hook = repo.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\necho synthetic-secret >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn recovery_before_and_after_portable_write_never_retries_old_git_work() {
    for published in [false, true] {
        let f = Fixture::new("root", true, true, true, true).await;
        let portable = core::files::read(&f.path.join(".svode/config.json"), true).unwrap();
        let local = core::files::read(&f.path.join(".svode/local.json"), true).unwrap();
        let mut next = portable.clone();
        next["variables"] = json!({"RECOVERED":{"kind":"variable","value":"confirmed"}});
        let journal = json!({"version":2,"beforePortable":core::files::digest(&portable),"beforeLocal":core::files::digest(&local),"portable":next,"local":local,"names":["RECOVERED"],"cleanup":[]});
        core::files::atomic_write(&f.path.join(".svode/variables.pending.json"), &journal).unwrap();
        if published {
            core::files::atomic_write(&f.path.join(".svode/config.json"), &next).unwrap();
        }
        let before = f.before().await;
        let result = f.recover().await.unwrap();
        assert!(result.change.as_ref().unwrap().portable_changed);
        assert_eq!(f.count(&f.repo).await - before.0, usize::from(!published));
        assert_eq!(
            result.effect.unwrap().config,
            if published {
                ExactPathPersistenceOutcome::Pending {
                    reason: ExactPathPendingReason::TargetDirty,
                }
            } else {
                ExactPathPersistenceOutcome::Committed
            }
        );
        let before = f.before().await;
        assert!(f.recover().await.unwrap().change.is_none());
        assert_eq!(before, f.before().await);
    }
}

#[tokio::test]
async fn failed_metadata_cleanup_does_not_commit_and_recovery_retains_pending_config() {
    let f = Fixture::new("root", true, true, true, true).await;
    f.save("TOKEN", Mode::Git, Kind::Secret, Some("synthetic-secret"))
        .await;
    f.secrets.fail_remove.set(true);
    let before = f.before().await;
    assert!(
        f.apply(async { f.save_raw("TOKEN", Mode::Git, Kind::Variable, Some("public")) })
            .await
            .is_err()
    );
    assert_eq!(before, f.before().await);
    assert!(Service::new(&f.secrets).catalog(&f.owner).is_err());
    f.secrets.fail_remove.set(false);
    let recovered = f.recover().await.unwrap();
    assert_eq!(
        recovered.effect.unwrap().config,
        ExactPathPersistenceOutcome::Pending {
            reason: ExactPathPendingReason::TargetDirty
        }
    );
    assert_eq!(before, f.before().await);
}

#[tokio::test]
async fn root_pointer_failure_and_manual_retry_preserve_one_child_commit() {
    for reason in [
        "off",
        "dirty",
        "index",
        "failure",
        "foreign-child",
        "foreign-root",
    ] {
        let f = Fixture::new("submodule", true, reason != "off", false, false).await;
        if reason == "dirty" {
            git(
                f.cli(),
                &f.path,
                &["commit", "--allow-empty", "-m", "Earlier child work"],
            )
            .await;
        }
        if reason == "index" {
            fs::write(f.root.join("other.txt"), "staged").unwrap();
            git(f.cli(), &f.root, &["add", "other.txt"]).await;
        }
        if reason == "failure" {
            fail_commit(&f.root);
        }
        let before = f.before().await;
        let result = apply(
            &f.owner,
            Some(&f.root),
            &f.git,
            async { f.save_raw("POINTER", Mode::Git, Kind::Variable, Some("value")) },
            |_, space, repo| {
                f.events
                    .borrow_mut()
                    .push((space.into(), repo.into(), true));
                if repo == f.path && matches!(reason, "foreign-child" | "foreign-root") {
                    let path = if reason == "foreign-child" {
                        &f.path
                    } else {
                        &f.root
                    };
                    let status = std::process::Command::new(f.cli().git_path())
                        .args(["commit", "--allow-empty", "-m", "External commit"])
                        .current_dir(path)
                        .output()
                        .unwrap();
                    assert!(status.status.success());
                }
            },
        )
        .await
        .unwrap();
        let effect = result.effect.unwrap();
        assert_eq!(effect.config, ExactPathPersistenceOutcome::Committed);
        assert!(!matches!(
            effect.root_pointer,
            Some(ExactPathPersistenceOutcome::Committed)
        ));
        assert_eq!(
            f.count(&f.path).await - before.0,
            1 + usize::from(reason == "foreign-child")
        );
        let count = f.before().await;
        assert!(f.recover().await.unwrap().effect.is_none());
        assert!(
            f.save("POINTER", Mode::Git, Kind::Variable, Some("value"))
                .await
                .effect
                .is_none()
        );
        assert_eq!(count, f.before().await);
        if reason == "failure" {
            fs::remove_file(f.root.join(".git/hooks/pre-commit")).unwrap();
        }
        f.manual().await;
        assert_eq!(f.count(&f.path).await, count.0);
        assert!(
            !ops::exact_path_has_changes(f.cli(), &f.root, "child")
                .await
                .unwrap()
        );
        if reason == "index" {
            assert_eq!(
                git(f.cli(), &f.root, &["show", ":other.txt"]).await,
                "staged"
            );
        }
    }
}

#[tokio::test]
async fn global_and_local_crud_recovery_never_create_git_effects() {
    for system in [false, true] {
        for structural in [false, true] {
            let mut f = Fixture::new("root", system, structural, false, false).await;
            for global in [false, true] {
                if global {
                    f.owner = Owner::global(&f.root.join("global")).unwrap();
                }
                for kind in [Kind::Variable, Kind::Secret] {
                    let before = f.before().await;
                    for value in ["synthetic-local-one", "synthetic-local-two"] {
                        assert!(
                            f.save("LOCAL", Mode::Local, kind, Some(value))
                                .await
                                .effect
                                .is_none()
                        );
                    }
                    f.secrets.fail_remove.set(kind == Kind::Secret);
                    let removal = f
                        .apply(async {
                            let service = Service::new(&f.secrets);
                            service
                                .remove(
                                    &f.owner,
                                    "LOCAL",
                                    &service.catalog(&f.owner).unwrap().revision,
                                )
                                .map(Some)
                                .map_err(storage_error)
                        })
                        .await;
                    if kind == Kind::Secret {
                        assert!(removal.is_err());
                    } else {
                        assert!(removal.unwrap().effect.is_none());
                    }
                    f.secrets.fail_remove.set(false);
                    assert!(f.recover().await.unwrap().effect.is_none());
                    assert!(f.recover().await.unwrap().effect.is_none());
                    assert_eq!(before, f.before().await);
                }
            }
        }
    }
}

#[tokio::test]
async fn every_mode_kind_transition_obeys_portable_change_not_create_intent() {
    let states = [
        (Mode::Local, Kind::Variable),
        (Mode::Local, Kind::Secret),
        (Mode::Git, Kind::Variable),
        (Mode::Git, Kind::Secret),
    ];
    for system in [false, true] {
        for structural in [false, true] {
            let f = Fixture::new("root", system, structural, false, false).await;
            for (a, from) in states.iter().enumerate() {
                for (b, to) in states.iter().enumerate() {
                    let name = format!("V{a}_{b}");
                    f.save_raw(
                        &name,
                        from.0,
                        from.1,
                        Some(if from.1 == Kind::Secret {
                            "synthetic-secret-old"
                        } else {
                            "old"
                        }),
                    )
                    .unwrap();
                    f.manual().await;
                    let portable_before =
                        core::files::read(&f.path.join(".svode/config.json"), true).unwrap();
                    let before = f.before().await;
                    let result = f
                        .save(
                            &name,
                            to.0,
                            to.1,
                            Some(if to.1 == Kind::Secret {
                                "synthetic-secret-new"
                            } else {
                                "new"
                            }),
                        )
                        .await;
                    let changed = portable_before
                        != core::files::read(&f.path.join(".svode/config.json"), true).unwrap();
                    f.assert_effect(before, &result, changed, system, structural)
                        .await;
                    f.manual().await;
                }
            }
        }
    }
}

#[tokio::test]
async fn partial_multi_owner_recovery_preserves_completed_effects_and_stops() {
    let f = Fixture::new("inline", true, true, false, false).await;
    let root_owner = Owner::in_context(
        &Context::new(&f.root, None, &f.root.join("global")).unwrap(),
        &SourceOwner::Project,
    )
    .unwrap();
    for path in [&f.root, &f.path] {
        let portable = core::files::read(&path.join(".svode/config.json"), true).unwrap();
        let local = core::files::read(&path.join(".svode/local.json"), false).unwrap();
        let mut next = portable.clone();
        next["variables"] = json!({"RECOVERED":{"kind":"variable","value":"confirmed"}});
        let journal = json!({"version":2,"beforePortable":core::files::digest(&portable),"beforeLocal":core::files::digest(&local),"portable":next,"local":local,"names":["RECOVERED"],"cleanup":[]});
        core::files::atomic_write(&path.join(".svode/variables.pending.json"), &journal).unwrap();
    }
    // A changed child config blocks its journal but must not undo root recovery.
    core::files::atomic_write(
        &f.path.join(".svode/config.json"),
        &json!({"name":"External"}),
    )
    .unwrap();
    let calls = RefCell::new(vec![]);
    let result = recover_in_order(
        vec![
            SourceOwner::Project,
            SourceOwner::Space { id: "child".into() },
            SourceOwner::Global,
        ],
        |source| {
            let calls = &calls;
            let f = &f;
            let root_owner = &root_owner;
            async move {
                calls.borrow_mut().push(source.clone());
                let owner = if source == SourceOwner::Project {
                    root_owner
                } else {
                    &f.owner
                };
                apply(
                    owner,
                    Some(&f.root),
                    &f.git,
                    async {
                        Service::new(&f.secrets)
                            .recover(owner)
                            .map_err(storage_error)
                    },
                    |_, _, _| {},
                )
                .await
            }
        },
    )
    .await;
    assert!(result.recovery_error.is_some());
    assert_eq!(result.effects.len(), 1);
    assert_eq!(
        result.effects[0].config,
        ExactPathPersistenceOutcome::Committed
    );
    assert_eq!(calls.borrow().len(), 2);
    assert!(
        Service::new(&f.secrets)
            .recover(&root_owner)
            .unwrap()
            .is_none()
    );
    assert!(Service::new(&f.secrets).catalog(&f.owner).is_err());
}

#[tokio::test]
async fn clean_already_committed_partial_recovery_is_not_another_commit() {
    let f = Fixture::new("root", true, true, false, false).await;
    f.save("TOKEN", Mode::Git, Kind::Secret, Some("synthetic-secret"))
        .await;
    f.secrets.fail_remove.set(true);
    assert!(
        f.apply(async { f.save_raw("TOKEN", Mode::Git, Kind::Variable, Some("public")) })
            .await
            .is_err()
    );
    f.manual().await;
    let before = f.before().await;
    f.secrets.fail_remove.set(false);
    assert_eq!(
        f.recover().await.unwrap().effect.unwrap().config,
        ExactPathPersistenceOutcome::Clean
    );
    assert_eq!(f.before().await, before);
}

#[tokio::test]
async fn sync_dispatch_follows_real_commits_and_independent_repo_policy() {
    for system in [false, true] {
        for child_sync in [false, true] {
            for root_sync in [false, true] {
                let f = Fixture::new("submodule", system, true, false, false).await;
                write_git_user_policy(
                    &f.path,
                    &GitUserPolicy {
                        auto_sync: child_sync,
                        auto_commit_system: system,
                        auto_commit_structural: false,
                    },
                )
                .unwrap();
                write_git_user_policy(
                    &f.root,
                    &GitUserPolicy {
                        auto_sync: root_sync,
                        auto_commit_system: false,
                        auto_commit_structural: true,
                    },
                )
                .unwrap();
                f.save("SYNC", Mode::Git, Kind::Variable, Some("value"))
                    .await;
                let events = f.events.borrow();
                if system {
                    assert_eq!(
                        *events,
                        vec![
                            (f.path.clone(), f.path.clone(), child_sync),
                            (f.path.clone(), f.root.clone(), root_sync)
                        ]
                    );
                } else {
                    assert!(events.is_empty());
                }
            }
        }
    }
}

#[tokio::test]
async fn disabled_policy_with_missing_git_is_a_normal_save() {
    for kind in ["root", "inline", "independent", "submodule"] {
        let mut f = Fixture::new(kind, false, true, true, true).await;
        f.git.cli = None;
        let result = f
            .save("DISABLED", Mode::Git, Kind::Variable, Some("confirmed"))
            .await;
        assert_eq!(
            result.effect.unwrap().config,
            ExactPathPersistenceOutcome::Pending {
                reason: ExactPathPendingReason::PolicyOff
            }
        );
        assert!(f.events.borrow().is_empty());
    }
}

#[tokio::test]
async fn root_metadata_race_is_not_hidden_by_an_already_dirty_status() {
    let f = Fixture::new("submodule", true, true, false, false).await;
    let metadata = f.root.join(".gitmodules");
    fs::write(
        &metadata,
        "[submodule \"child\"]\n path = child\n url = ./first\n",
    )
    .unwrap();
    let result = apply(
        &f.owner,
        Some(&f.root),
        &f.git,
        async { f.save_raw("RACE", Mode::Git, Kind::Variable, Some("confirmed")) },
        |_, _, repo| {
            if repo == f.path {
                fs::write(
                    &metadata,
                    "[submodule \"child\"]\n path = child\n url = ./second\n",
                )
                .unwrap();
            }
        },
    )
    .await
    .unwrap();
    assert_eq!(result.effect.unwrap().root_pointer, Some(pending()));
    assert!(
        ops::exact_path_has_changes(f.cli(), &f.root, "child")
            .await
            .unwrap()
    );
}
