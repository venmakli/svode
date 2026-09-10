use super::*;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    path::Path,
};

#[derive(Default)]
struct Secrets {
    values: RefCell<BTreeMap<String, String>>,
    reads: Cell<usize>,
    denied: Cell<bool>,
    fail_set: Cell<bool>,
    fail_remove: Cell<bool>,
}
impl SecretStore for Secrets {
    fn get(&self, name: &str) -> Result<Option<String>> {
        self.reads.set(self.reads.get() + 1);
        if self.denied.get() {
            return Err(Error::SecretStore);
        }
        Ok(self.values.borrow().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        if self.fail_set.get() {
            return Err(Error::SecretStore);
        }
        self.values.borrow_mut().insert(name.into(), value.into());
        Ok(())
    }
    fn remove(&self, name: &str) -> Result<()> {
        if self.fail_remove.get() {
            return Err(Error::SecretStore);
        }
        self.values.borrow_mut().remove(name);
        Ok(())
    }
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for path in [
        dir.path().to_path_buf(),
        dir.path().join("inline"),
        dir.path().join("repo"),
    ] {
        std::fs::create_dir_all(path.join(".svode")).unwrap();
        files::atomic_write(
            &path.join(".svode/config.json"),
            &json!({"name":"Test", "unrelated":{"retain":true}}),
        )
        .unwrap();
    }
    let mut config = files::read(&dir.path().join(".svode/config.json"), true).unwrap();
    config["spaces"] = json!([{"id":"inline", "path":"inline"}, {"id":"repo", "path":"repo"}]);
    files::atomic_write(&dir.path().join(".svode/config.json"), &config).unwrap();
    dir
}

fn context(root: &Path, child: Option<&str>) -> Context {
    Context::new(root, child, &root.join("library")).unwrap()
}
fn owner(root: &Path, child: Option<&str>) -> Owner {
    Owner::in_context(
        &context(root, child),
        &child
            .map(|id| SourceOwner::Space { id: id.into() })
            .unwrap_or(SourceOwner::Project),
    )
    .unwrap()
}
fn save(
    service: &Service<'_>,
    owner: &Owner,
    name: &str,
    mode: Mode,
    kind: Kind,
    value: Option<&str>,
) -> Result<Change> {
    let catalog = service.catalog(owner)?;
    let identity = catalog
        .entries
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.identity.clone());
    service.save(
        owner,
        Save {
            name: name.into(),
            mode,
            kind,
            value: value.map(str::to_string),
            revision: catalog.revision,
            identity,
            keep: None,
        },
    )
}
fn resolved(service: &Service<'_>, root: &Path, child: Option<&str>, name: &str) -> Result<String> {
    service
        .resolve(&context(root, child), &[name.into()], &BTreeMap::new())
        .map(|mut v| v.remove(name).unwrap().value)
}
fn raw(root: &Path, filename: &str) -> Value {
    files::read(&root.join(".svode").join(filename), false).unwrap()
}

#[test]
fn four_modes_round_trip_preserve_sections_and_never_project_secret_values() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    let portable_before = raw(root.path(), "config.json");
    save(
        &service,
        &owner,
        "LOCAL",
        Mode::Local,
        Kind::Variable,
        Some(""),
    )
    .unwrap();
    assert_eq!(raw(root.path(), "config.json"), portable_before);
    save(
        &service,
        &owner,
        "LOCAL_SECRET",
        Mode::Local,
        Kind::Secret,
        Some("synthetic-private-one"),
    )
    .unwrap();
    save(
        &service,
        &owner,
        "GIT",
        Mode::Git,
        Kind::Variable,
        Some("portable-value"),
    )
    .unwrap();
    save(
        &service,
        &owner,
        "GIT_SECRET",
        Mode::Git,
        Kind::Secret,
        Some("synthetic-private-two"),
    )
    .unwrap();
    let portable = raw(root.path(), "config.json");
    let local = raw(root.path(), "local.json");
    assert!(portable["variables"]["entries"].get("LOCAL").is_none());
    assert!(local["variables"]["entries"].get("GIT").is_none());
    assert_eq!(portable["unrelated"]["retain"], true);
    assert_eq!(
        portable["variables"]["entries"]["GIT"]["value"],
        "portable-value"
    );
    assert_eq!(local["variables"]["entries"]["LOCAL"]["value"], "");
    assert!(
        portable["variables"]["entries"]["GIT_SECRET"]
            .get("value")
            .is_none()
    );
    let catalog = service.catalog(&owner).unwrap();
    assert_eq!(catalog.entries.len(), 4);
    for entry in &catalog.entries {
        assert!(entry.has_value);
        if entry.kind == Kind::Secret {
            assert!(entry.value.is_none());
        }
    }
    for source in [
        portable.to_string(),
        local.to_string(),
        serde_json::to_string(&catalog).unwrap(),
    ] {
        assert!(!source.contains("synthetic-private"));
    }
    assert_eq!(
        resolved(&service, root.path(), None, "LOCAL_SECRET").unwrap(),
        "synthetic-private-one"
    );
}

#[test]
fn all_mode_and_kind_transitions_keep_identity_and_require_explicit_declassification() {
    let modes = [
        (Mode::Local, Kind::Variable),
        (Mode::Git, Kind::Variable),
        (Mode::Local, Kind::Secret),
        (Mode::Git, Kind::Secret),
    ];
    for (from_mode, from_kind) in modes {
        for (to_mode, to_kind) in modes {
            let root = fixture();
            let secrets = Secrets::default();
            let service = Service::new(&secrets);
            let owner = owner(root.path(), None);
            save(
                &service,
                &owner,
                "TOKEN",
                from_mode,
                from_kind,
                Some("synthetic-original"),
            )
            .unwrap();
            let old = service.catalog(&owner).unwrap().entries[0].identity.clone();
            if from_kind == Kind::Secret && to_kind == Kind::Variable {
                assert_eq!(
                    save(&service, &owner, "TOKEN", to_mode, to_kind, None).unwrap_err(),
                    Error::InvalidValue
                );
                save(&service, &owner, "TOKEN", to_mode, to_kind, Some("")).unwrap();
            } else {
                save(&service, &owner, "TOKEN", to_mode, to_kind, None).unwrap();
            }
            let entry = service.catalog(&owner).unwrap().entries.remove(0);
            assert_eq!(entry.identity, old);
            assert_eq!(entry.mode, to_mode);
            assert_eq!(entry.kind, to_kind);
            let expected = if from_kind == Kind::Secret && to_kind == Kind::Variable {
                ""
            } else {
                "synthetic-original"
            };
            assert_eq!(
                resolved(&service, root.path(), None, "TOKEN").unwrap(),
                expected
            );
            let portable = raw(root.path(), "config.json");
            let local = raw(root.path(), "local.json");
            assert_eq!(
                portable["variables"]["entries"].get("TOKEN").is_some(),
                to_mode == Mode::Git
            );
            assert_eq!(
                local["variables"]["entries"].get("TOKEN").is_some(),
                to_mode == Mode::Local
            );
            if to_kind == Kind::Secret {
                assert!(!portable.to_string().contains("synthetic-original"));
                assert!(!local.to_string().contains("synthetic-original"));
            }
        }
    }
}

#[test]
fn scopes_clones_and_moved_owner_have_independent_local_identity() {
    let root = fixture();
    let other = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    for (path, child, value) in [
        (root.path(), None, "root"),
        (root.path(), Some("inline"), "inline"),
        (root.path(), Some("repo"), "repo"),
        (other.path(), None, "other"),
    ] {
        save(
            &service,
            &owner(path, child),
            "TOKEN",
            Mode::Git,
            Kind::Secret,
            Some(value),
        )
        .unwrap();
        assert_eq!(resolved(&service, path, child, "TOKEN").unwrap(), value);
    }
    let clone = fixture();
    files::atomic_write(
        &clone.path().join(".svode/config.json"),
        &raw(root.path(), "config.json"),
    )
    .unwrap();
    assert_eq!(
        resolved(&service, clone.path(), None, "TOKEN").unwrap_err(),
        Error::Missing
    );
    save(
        &service,
        &owner(clone.path(), None),
        "TOKEN",
        Mode::Git,
        Kind::Secret,
        Some("clone"),
    )
    .unwrap();
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap(),
        "root"
    );
    let relocated = root.path().join("relocated");
    std::fs::rename(root.path().join("inline"), &relocated).unwrap();
    let mut config = raw(root.path(), "config.json");
    config["spaces"][0]["path"] = json!("relocated");
    files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
    assert_eq!(
        resolved(&service, root.path(), Some("inline"), "TOKEN").unwrap(),
        "inline"
    );
    assert_eq!(
        resolved(&service, &relocated, None, "TOKEN").unwrap(),
        "inline"
    );
    save(
        &service,
        &owner(root.path(), None),
        "PARENT",
        Mode::Git,
        Kind::Variable,
        Some("parent"),
    )
    .unwrap();
    assert_eq!(
        resolved(&service, &relocated, None, "PARENT").unwrap_err(),
        Error::Missing
    );
}

#[test]
fn nearest_declaration_blocks_fallback_and_explicit_sources_remain_pinned() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    save(
        &service,
        &owner(root.path(), None),
        "TOKEN",
        Mode::Local,
        Kind::Variable,
        Some("parent"),
    )
    .unwrap();
    assert_eq!(
        resolved(&service, root.path(), Some("inline"), "TOKEN").unwrap(),
        "parent"
    );
    save(
        &service,
        &owner(root.path(), Some("inline")),
        "TOKEN",
        Mode::Git,
        Kind::Secret,
        None,
    )
    .unwrap();
    assert_eq!(
        resolved(&service, root.path(), Some("inline"), "TOKEN").unwrap_err(),
        Error::Missing
    );
    let bindings = BTreeMap::from([(
        "TOKEN".into(),
        SourceReference {
            owner: SourceOwner::Project,
            name: "TOKEN".into(),
        },
    )]);
    assert_eq!(
        service
            .resolve(
                &context(root.path(), Some("inline")),
                &["TOKEN".into()],
                &bindings
            )
            .unwrap()
            .remove("TOKEN")
            .unwrap()
            .value,
        "parent"
    );
    let library = Owner::library(&root.path().join("library")).unwrap();
    save(
        &service,
        &library,
        "ONLY_LIBRARY",
        Mode::Local,
        Kind::Secret,
        Some("library-secret"),
    )
    .unwrap();
    assert_eq!(
        resolved(&service, root.path(), None, "ONLY_LIBRARY").unwrap_err(),
        Error::Missing
    );
    let library_binding = BTreeMap::from([(
        "TOKEN".into(),
        SourceReference {
            owner: SourceOwner::Library,
            name: "ONLY_LIBRARY".into(),
        },
    )]);
    assert_eq!(
        service
            .resolve(
                &context(root.path(), None),
                &["TOKEN".into()],
                &library_binding
            )
            .unwrap()
            .remove("TOKEN")
            .unwrap()
            .value,
        "library-secret"
    );
    assert!(
        Owner::in_context(
            &context(root.path(), Some("inline")),
            &SourceOwner::Space { id: "repo".into() }
        )
        .is_err()
    );
}

#[test]
fn missing_git_secret_can_be_declared_but_not_turned_local_without_value() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    assert_eq!(
        save(&service, &owner, "TOKEN", Mode::Local, Kind::Secret, None).unwrap_err(),
        Error::InvalidValue
    );
    save(&service, &owner, "TOKEN", Mode::Git, Kind::Secret, None).unwrap();
    assert!(!service.catalog(&owner).unwrap().entries[0].has_value);
    assert_eq!(
        save(&service, &owner, "TOKEN", Mode::Local, Kind::Secret, None).unwrap_err(),
        Error::InvalidValue
    );
    save(
        &service,
        &owner,
        "TOKEN",
        Mode::Git,
        Kind::Secret,
        Some("configured"),
    )
    .unwrap();
    save(&service, &owner, "TOKEN", Mode::Git, Kind::Secret, Some("")).unwrap();
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap(),
        "configured"
    );
}

#[test]
fn external_delete_kind_change_and_replacement_do_not_resurrect_orphans() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    save(
        &service,
        &owner,
        "TOKEN",
        Mode::Git,
        Kind::Secret,
        Some("old-value"),
    )
    .unwrap();
    let mut config = raw(root.path(), "config.json");
    config["variables"]["entries"]["TOKEN"]["id"] = json!(ulid::Ulid::new().to_string());
    files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap_err(),
        Error::Missing
    );
    config["variables"]["entries"]["TOKEN"]["kind"] = json!("variable");
    config["variables"]["entries"]["TOKEN"]["value"] = json!("ordinary");
    files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap(),
        "ordinary"
    );
    config["variables"]["entries"] = json!({});
    files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
    save(&service, &owner, "TOKEN", Mode::Git, Kind::Secret, None).unwrap();
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap_err(),
        Error::Missing
    );
}

#[test]
fn collision_requires_explicit_choice_and_never_silently_overwrites() {
    for keep in [Mode::Git, Mode::Local] {
        let root = fixture();
        let secrets = Secrets::default();
        let service = Service::new(&secrets);
        let owner = owner(root.path(), None);
        save(
            &service,
            &owner,
            "TOKEN",
            Mode::Local,
            Kind::Variable,
            Some("local"),
        )
        .unwrap();
        let mut config = raw(root.path(), "config.json");
        config["variables"] = json!({"version":1,"entries":{"TOKEN":{"id":ulid::Ulid::new().to_string(),"kind":"variable","value":"git"}}});
        files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
        assert_eq!(
            resolved(&service, root.path(), None, "TOKEN").unwrap_err(),
            Error::Collision
        );
        let catalog = service.catalog(&owner).unwrap();
        assert_eq!(catalog.collisions, vec!["TOKEN"]);
        let chosen = catalog.entries.iter().find(|e| e.mode == keep).unwrap();
        service
            .save(
                &owner,
                Save {
                    name: "TOKEN".into(),
                    mode: keep,
                    kind: Kind::Variable,
                    value: None,
                    revision: catalog.revision,
                    identity: Some(chosen.identity.clone()),
                    keep: Some(keep),
                },
            )
            .unwrap();
        assert_eq!(
            resolved(&service, root.path(), None, "TOKEN").unwrap(),
            if keep == Mode::Git { "git" } else { "local" }
        );
        assert_eq!(service.catalog(&owner).unwrap().entries.len(), 1);
    }
}

#[test]
fn stale_revision_and_corrupt_configs_fail_closed_without_discarding_draft_or_file() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    let old = service.catalog(&owner).unwrap();
    let mut config = raw(root.path(), "config.json");
    config["name"] = json!("changed by another settings writer");
    files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
    assert_eq!(
        service
            .save(
                &owner,
                Save {
                    name: "TOKEN".into(),
                    mode: Mode::Local,
                    kind: Kind::Variable,
                    value: Some("draft".into()),
                    revision: old.revision,
                    identity: None,
                    keep: None
                }
            )
            .unwrap_err(),
        Error::StaleRevision
    );
    for content in [
        "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch",
        "null",
        "{",
        r#"{"variables":{"version":99}}"#,
    ] {
        std::fs::write(root.path().join(".svode/config.json"), content).unwrap();
        assert!(service.catalog(&owner).is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join(".svode/config.json")).unwrap(),
            content
        );
    }
}

#[test]
fn secret_store_failure_preserves_last_confirmed_value_and_retry_is_safe() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    save(
        &service,
        &owner,
        "TOKEN",
        Mode::Git,
        Kind::Secret,
        Some("confirmed"),
    )
    .unwrap();
    secrets.fail_set.set(true);
    assert_eq!(
        save(
            &service,
            &owner,
            "TOKEN",
            Mode::Git,
            Kind::Secret,
            Some("replacement")
        )
        .unwrap_err(),
        Error::SecretStore
    );
    secrets.fail_set.set(false);
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap(),
        "confirmed"
    );
    save(
        &service,
        &owner,
        "TOKEN",
        Mode::Git,
        Kind::Secret,
        Some("replacement"),
    )
    .unwrap();
    secrets.denied.set(true);
    assert_eq!(
        resolved(&service, root.path(), None, "TOKEN").unwrap_err(),
        Error::SecretStore
    );
}

#[test]
fn interrupted_transitions_have_no_successful_mixed_snapshot_and_recover_once() {
    for interruption in [1, 2] {
        let root = fixture();
        let secrets = Secrets::default();
        let service = Service::new(&secrets);
        let owner = owner(root.path(), None);
        save(
            &service,
            &owner,
            "TOKEN",
            Mode::Local,
            Kind::Variable,
            Some("synthetic-before-secret"),
        )
        .unwrap();
        service.interrupt.set(interruption);
        assert_eq!(
            save(&service, &owner, "TOKEN", Mode::Git, Kind::Secret, None).unwrap_err(),
            Error::PendingRecovery
        );
        assert_eq!(
            resolved(&service, root.path(), None, "TOKEN").unwrap_err(),
            Error::PendingRecovery
        );
        let journal = raw(root.path(), files::PENDING_FILE).to_string();
        assert!(!journal.contains("synthetic-before-secret"));
        let reopened = Service::new(&secrets);
        assert!(reopened.recover(&owner).unwrap().is_some());
        assert!(reopened.recover(&owner).unwrap().is_none());
        assert_eq!(
            resolved(&reopened, root.path(), None, "TOKEN").unwrap(),
            "synthetic-before-secret"
        );
        assert!(
            !raw(root.path(), "config.json")
                .to_string()
                .contains("synthetic-before-secret")
        );
        assert!(
            !raw(root.path(), "local.json")
                .to_string()
                .contains("synthetic-before-secret")
        );
    }
}

#[test]
fn failed_cleanup_and_external_change_during_recovery_stay_explicit() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    save(
        &service,
        &owner,
        "TOKEN",
        Mode::Local,
        Kind::Secret,
        Some("previous"),
    )
    .unwrap();
    secrets.fail_remove.set(true);
    assert_eq!(
        save(
            &service,
            &owner,
            "TOKEN",
            Mode::Git,
            Kind::Secret,
            Some("replacement")
        )
        .unwrap_err(),
        Error::SecretStore
    );
    assert_eq!(service.catalog(&owner).unwrap_err(), Error::PendingRecovery);
    secrets.fail_remove.set(false);
    service.recover(&owner).unwrap();
    service.interrupt.set(1);
    assert!(save(&service, &owner, "TOKEN", Mode::Local, Kind::Secret, None).is_err());
    let mut config = raw(root.path(), "config.json");
    config["name"] = json!("external");
    files::atomic_write(&root.path().join(".svode/config.json"), &config).unwrap();
    assert_eq!(
        Service::new(&secrets).recover(&owner).unwrap_err(),
        Error::StaleRevision
    );
    assert_eq!(raw(root.path(), "config.json")["name"], "external");
}

#[test]
fn library_keeps_existing_entries_accounts_usage_and_never_imports_values() {
    let root = fixture();
    let secrets = Secrets::default();
    let library_path = root.path().join("library");
    std::fs::create_dir(&library_path).unwrap();
    let previous = json!({"appearance":{"theme":"dark"},"variables":{"entries":{"TOKEN":{"kind":"secret"}},"apps":{"/gone":{"ownerDirectory":"/gone","references":["TOKEN"],"bindings":{}}}}});
    files::atomic_write(&library_path.join("settings.json"), &previous).unwrap();
    secrets.set("TOKEN", "existing-secret").unwrap();
    let service = Service::new(&secrets);
    let library = Owner::library(&library_path).unwrap();
    assert!(service.catalog(&library).unwrap().entries[0].has_value);
    assert_eq!(
        files::read(&library_path.join("settings.json"), true).unwrap(),
        previous
    );
    save(
        &service,
        &library,
        "TOKEN",
        Mode::Local,
        Kind::Secret,
        Some("new-value"),
    )
    .unwrap();
    assert_eq!(secrets.get("TOKEN").unwrap().unwrap(), "new-value");
    let saved = files::read(&library_path.join("settings.json"), true).unwrap();
    assert_eq!(saved["variables"]["apps"], previous["variables"]["apps"]);
    assert_eq!(saved["appearance"], previous["appearance"]);
    assert!(raw(root.path(), "config.json").get("variables").is_none());
    assert!(
        save(
            &service,
            &library,
            "NEW",
            Mode::Git,
            Kind::Variable,
            Some("value")
        )
        .is_err()
    );
}

#[test]
fn compatibility_is_versioned_idempotent_snapshot_only_and_deletion_stays_deleted() {
    let old = json!({"apps":{"/missing/app":{"ownerDirectory":"/missing/app","references":["TOKEN","MISSING"],"bindings":{"TOKEN":"LIBRARY"}}}});
    let mut normalized = normalize_app_bindings(&old, None).unwrap();
    assert_eq!(normalized.owners["/missing/app"]["TOKEN"].name, "LIBRARY");
    assert_eq!(
        normalized.owners["/missing/app"]["MISSING"].owner,
        SourceOwner::Library
    );
    normalized
        .owners
        .get_mut("/missing/app")
        .unwrap()
        .remove("TOKEN");
    let normalized = normalize_app_bindings(&old, Some(normalized)).unwrap();
    assert!(!normalized.owners["/missing/app"].contains_key("TOKEN"));
    assert!(!normalized.owners.contains_key("/new-clone/app"));
    let v1 = json!({"version":1,"endpoint":"https://s3.test","bucket":"bucket","region":"region","prefix":null,"catalogPath":"/config/settings.json","bindings":{"accessKey":"ACCESS","secretKey":"SECRET"}});
    let normalized = normalize_s3_v1(&v1).unwrap();
    assert_eq!(normalized.bindings.access_key.owner, SourceOwner::Library);
    for invalid in [
        json!({"keychainAccount":"legacy"}),
        json!({"version":2}),
        json!({"version":1}),
    ] {
        assert!(normalize_s3_v1(&invalid).is_err());
    }
}

#[test]
fn common_secret_pair_uses_scoped_and_library_sources_and_new_sessions_observe_rotation() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let project = owner(root.path(), None);
    let library = Owner::library(&root.path().join("library")).unwrap();
    save(
        &service,
        &project,
        "ACCESS",
        Mode::Git,
        Kind::Secret,
        Some("access"),
    )
    .unwrap();
    save(
        &service,
        &library,
        "SECRET",
        Mode::Local,
        Kind::Secret,
        Some("secret"),
    )
    .unwrap();
    let pair = SecretPair {
        access_key: SourceReference {
            owner: SourceOwner::Project,
            name: "ACCESS".into(),
        },
        secret_key: SourceReference {
            owner: SourceOwner::Library,
            name: "SECRET".into(),
        },
    };
    let before = service
        .resolve_secret_pair(&context(root.path(), None), &pair)
        .unwrap();
    save(
        &service,
        &project,
        "ACCESS",
        Mode::Git,
        Kind::Secret,
        Some("rotated"),
    )
    .unwrap();
    let after = service
        .resolve_secret_pair(&context(root.path(), None), &pair)
        .unwrap();
    assert_eq!(before.access_key, "access");
    assert_eq!(after.access_key, "rotated");
    save(
        &service,
        &project,
        "ACCESS",
        Mode::Git,
        Kind::Variable,
        Some("ordinary"),
    )
    .unwrap();
    assert!(matches!(
        service.resolve_secret_pair(&context(root.path(), None), &pair),
        Err(Error::WrongKind)
    ));
    secrets.denied.set(true);
    assert!(matches!(
        service.resolve_secret_pair(&context(root.path(), None), &pair),
        Err(Error::WrongKind)
    ));
    secrets.denied.set(false);
    secrets.reads.set(0);
    let shared = SecretPair {
        access_key: pair.secret_key.clone(),
        secret_key: pair.secret_key,
    };
    let shared_values = service
        .resolve_secret_pair(&context(root.path(), None), &shared)
        .unwrap();
    assert_eq!(shared_values.access_key, shared_values.secret_key);
    assert_eq!(secrets.reads.get(), 1);
}

#[test]
fn filesystem_publication_failure_retains_recovery_and_can_be_retried() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    save(
        &service,
        &owner,
        "TOKEN",
        Mode::Local,
        Kind::Secret,
        Some("confirmed"),
    )
    .unwrap();
    service.interrupt.set(1);
    assert!(save(&service, &owner, "TOKEN", Mode::Git, Kind::Secret, None).is_err());
    let local_path = root.path().join(".svode/local.json");
    let local_bytes = std::fs::read(&local_path).unwrap();
    std::fs::remove_file(&local_path).unwrap();
    std::fs::create_dir(&local_path).unwrap();
    let reopened = Service::new(&secrets);
    assert_eq!(reopened.recover(&owner).unwrap_err(), Error::Unavailable);
    assert_eq!(
        reopened.catalog(&owner).unwrap_err(),
        Error::PendingRecovery
    );
    std::fs::remove_dir(&local_path).unwrap();
    std::fs::write(local_path, local_bytes).unwrap();
    reopened.recover(&owner).unwrap();
    assert_eq!(
        resolved(&reopened, root.path(), None, "TOKEN").unwrap(),
        "confirmed"
    );
}

#[test]
fn corrupted_recovery_cannot_publish_secret_plaintext_or_delete_another_namespace() {
    let root = fixture();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let owner = owner(root.path(), None);
    service.interrupt.set(1);
    assert!(
        save(
            &service,
            &owner,
            "TOKEN",
            Mode::Git,
            Kind::Secret,
            Some("synthetic-secret")
        )
        .is_err()
    );
    let path = root.path().join(".svode").join(files::PENDING_FILE);
    let original = files::read(&path, true).unwrap();
    let mut corrupt = original.clone();
    corrupt["portable"]["variables"]["entries"]["TOKEN"]["value"] =
        json!("must-never-be-published");
    files::atomic_write(&path, &corrupt).unwrap();
    let reopened = Service::new(&secrets);
    assert_eq!(reopened.recover(&owner).unwrap_err(), Error::InvalidConfig);
    assert!(
        !raw(root.path(), "config.json")
            .to_string()
            .contains("must-never-be-published")
    );
    corrupt = original.clone();
    corrupt["cleanup"] = json!(["LIBRARY_ACCOUNT"]);
    files::atomic_write(&path, &corrupt).unwrap();
    assert_eq!(reopened.recover(&owner).unwrap_err(), Error::InvalidConfig);
    files::atomic_write(&path, &original).unwrap();
    reopened.recover(&owner).unwrap();
    assert_eq!(
        resolved(&reopened, root.path(), None, "TOKEN").unwrap(),
        "synthetic-secret"
    );
}

fn git(directory: &Path, arguments: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(directory)
        .args(arguments)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Variables Test")
        .env("GIT_AUTHOR_EMAIL", "variables@example.test")
        .env("GIT_COMMITTER_NAME", "Variables Test")
        .env("GIT_COMMITTER_EMAIL", "variables@example.test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        arguments,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn real_git_clone_pull_checkout_preserve_portable_values_and_keep_secrets_local() {
    let root = fixture();
    let clones = tempfile::tempdir().unwrap();
    let secrets = Secrets::default();
    let service = Service::new(&secrets);
    let project = owner(root.path(), None);
    git(root.path(), &["init", "-b", "main"]);
    std::fs::write(root.path().join(".gitignore"), ".svode/local.json\n.svode/variables.*\n.svode/lfs-s3-agent.json\n**/.svode/local.json\n**/.svode/variables.*\n").unwrap();
    save(
        &service,
        &project,
        "PORTABLE",
        Mode::Git,
        Kind::Variable,
        Some("first"),
    )
    .unwrap();
    save(
        &service,
        &project,
        "PRIVATE",
        Mode::Local,
        Kind::Variable,
        Some("local-only"),
    )
    .unwrap();
    save(
        &service,
        &project,
        "SECRET",
        Mode::Git,
        Kind::Secret,
        Some("synthetic-private"),
    )
    .unwrap();
    save(
        &service,
        &owner(root.path(), Some("inline")),
        "CHILD",
        Mode::Git,
        Kind::Variable,
        Some("inline"),
    )
    .unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "Initial declarations"]);
    let initial = git(root.path(), &["rev-parse", "HEAD"]).trim().to_owned();
    let tree = git(root.path(), &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(!tree.contains("local.json") && !tree.contains("variables.lock"));
    git(
        clones.path(),
        &["clone", root.path().to_str().unwrap(), "copy"],
    );
    let copy = clones.path().join("copy");
    assert_eq!(
        resolved(&service, &copy, None, "PORTABLE").unwrap(),
        "first"
    );
    assert_eq!(
        resolved(&service, &copy, Some("inline"), "CHILD").unwrap(),
        "inline"
    );
    assert_eq!(
        resolved(&service, &copy, None, "SECRET").unwrap_err(),
        Error::Missing
    );
    assert_eq!(
        resolved(&service, &copy, None, "PRIVATE").unwrap_err(),
        Error::Missing
    );
    save(
        &service,
        &project,
        "PORTABLE",
        Mode::Git,
        Kind::Variable,
        Some("second"),
    )
    .unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "Change value"]);
    git(&copy, &["pull", "--ff-only"]);
    assert_eq!(
        resolved(&service, &copy, None, "PORTABLE").unwrap(),
        "second"
    );
    git(&copy, &["checkout", &initial]);
    assert_eq!(
        resolved(&service, &copy, None, "PORTABLE").unwrap(),
        "first"
    );
}

#[test]
fn config_lock_coordinates_processes_and_concurrent_saves_reject_stale_revision() {
    const CHILD: &str = "SVODE_VARIABLES_LOCK_TEST_DIRECTORY";
    if let Some(directory) = std::env::var_os(CHILD) {
        let directory = std::path::PathBuf::from(directory);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join(files::LOCK_FILE))
            .unwrap();
        assert!(matches!(
            file.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        return;
    }
    let root = fixture();
    let directory = root.path().join(".svode");
    let lock = files::lock(&directory).unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "variables::tests::config_lock_coordinates_processes_and_concurrent_saves_reject_stale_revision",
            "--nocapture",
        ])
        .env(CHILD, &directory)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed;"));
    drop(lock);
    let revision = Service::new(&Secrets::default())
        .catalog(&owner(root.path(), None))
        .unwrap()
        .revision;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads = ["FIRST", "SECOND"]
        .into_iter()
        .map(|name| {
            let path = root.path().to_path_buf();
            let revision = revision.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let secrets = Secrets::default();
                let service = Service::new(&secrets);
                let owner = owner(&path, None);
                barrier.wait();
                service.save(
                    &owner,
                    Save {
                        name: name.into(),
                        mode: Mode::Local,
                        kind: Kind::Variable,
                        value: Some(name.into()),
                        identity: None,
                        keep: None,
                        revision,
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .any(|r| matches!(r, Err(Error::StaleRevision)))
    );
}
