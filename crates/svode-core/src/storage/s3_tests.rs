use super::s3::*;
use crate::variables::{
    self as v, Kind, Mode, Owner, Save, SecretStore, Service, SourceOwner, SourceReference,
};
use serde_json::json;
use std::{cell::RefCell, collections::BTreeMap, path::Path};

#[derive(Default)]
struct Secrets(RefCell<BTreeMap<String, String>>);
impl SecretStore for Secrets {
    fn get(&self, account: &str) -> v::Result<Option<String>> {
        Ok(self.0.borrow().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> v::Result<()> {
        self.0.borrow_mut().insert(account.into(), value.into());
        Ok(())
    }
    fn remove(&self, account: &str) -> v::Result<()> {
        self.0.borrow_mut().remove(account);
        Ok(())
    }
}
fn source(owner: SourceOwner, name: &str) -> SourceReference {
    SourceReference {
        owner,
        name: name.into(),
    }
}
fn fixture() -> (tempfile::TempDir, AgentConfig, Secrets) {
    let dir = tempfile::tempdir().unwrap();
    for folder in ["", "child"] {
        std::fs::create_dir_all(dir.path().join(folder).join(".svode")).unwrap();
        std::fs::write(
            dir.path().join(folder).join(".svode/config.json"),
            json!({"spaces":[{"id":"child", "path":"child"}]}).to_string(),
        )
        .unwrap();
    }
    let config = AgentConfig {
        version: 2,
        endpoint: "https://s3.test".into(),
        bucket: "bucket".into(),
        region: "region".into(),
        prefix: Some("original/objects".into()),
        library_directory: dir.path().join("library"),
        project_path: Some(dir.path().canonicalize().unwrap()),
        space_id: Some("child".into()),
        bindings: SecretBindings {
            access_key: source(SourceOwner::Project, "KEY"),
            secret_key: source(SourceOwner::Space { id: "child".into() }, "KEY"),
        },
    };
    (dir, config, Secrets::default())
}
fn save(
    config: &AgentConfig,
    secrets: &Secrets,
    source: &SourceReference,
    mode: Mode,
    kind: Kind,
    value: Option<&str>,
) {
    let owner = Owner::in_context(&config.context().unwrap(), &source.owner).unwrap();
    let service = Service::new(secrets);
    let catalog = service.catalog(&owner).unwrap();
    service
        .save(
            &owner,
            Save {
                name: source.name.clone(),
                mode,
                kind,
                value: value.map(str::to_string),
                revision: catalog.revision,
                identity: catalog
                    .entries
                    .iter()
                    .find(|e| e.name == source.name)
                    .map(|e| e.identity.clone()),
                keep: None,
            },
        )
        .unwrap();
}
#[test]
fn scoped_pair_pins_sources_and_refreshes_only_new_sessions() {
    let (_dir, mut config, secrets) = fixture();
    save(
        &config,
        &secrets,
        &config.bindings.access_key,
        Mode::Local,
        Kind::Secret,
        Some("project"),
    );
    save(
        &config,
        &secrets,
        &config.bindings.secret_key,
        Mode::Git,
        Kind::Secret,
        None,
    );
    assert!(config.resolve_with_store(&secrets).is_err());
    save(
        &config,
        &secrets,
        &config.bindings.secret_key,
        Mode::Git,
        Kind::Secret,
        Some("space"),
    );
    let old = config.resolve_with_store(&secrets).unwrap();
    assert_eq!(old.access_key, "project");
    assert_eq!(old.secret_key, "space");
    save(
        &config,
        &secrets,
        &config.bindings.secret_key,
        Mode::Local,
        Kind::Secret,
        Some("rotated"),
    );
    assert_eq!(
        config.resolve_with_store(&secrets).unwrap().secret_key,
        "rotated"
    );
    assert_eq!(old.secret_key, "space");
    config.bindings.secret_key = source(SourceOwner::Library, "KEY");
    save(
        &config,
        &secrets,
        &config.bindings.secret_key,
        Mode::Local,
        Kind::Secret,
        Some("library"),
    );
    assert_eq!(
        config.resolve_with_store(&secrets).unwrap().secret_key,
        "library"
    );
    config.space_id = None;
    assert_eq!(
        config.resolve_with_store(&secrets).unwrap().access_key,
        "project"
    );
    config.bindings.secret_key = source(SourceOwner::Space { id: "child".into() }, "KEY");
    assert!(config.resolve_with_store(&secrets).is_err());
}
#[test]
fn v1_normalizes_without_project_or_desktop_and_writer_only_emits_v2() {
    let (dir, config, secrets) = fixture();
    let reference = source(SourceOwner::Library, "KEY");
    save(
        &config,
        &secrets,
        &reference,
        Mode::Local,
        Kind::Secret,
        Some("private"),
    );
    let old = json!({"version":1,"endpoint":config.endpoint,"bucket":config.bucket,"region":config.region,"prefix":config.prefix,
        "catalogPath":config.library_directory.join("settings.json"),"bindings":{"accessKey":"KEY","secretKey":"KEY"}});
    std::fs::write(dir.path().join(CONFIG_REL), old.to_string()).unwrap();
    let decoded = AgentConfig::read(dir.path()).unwrap();
    assert_eq!(decoded.project_path, None);
    assert_eq!(decoded.bindings.access_key, reference);
    assert_eq!(
        decoded.resolve_with_store(&secrets).unwrap().access_key,
        "private"
    );
    decoded.write(dir.path()).unwrap();
    let written = std::fs::read_to_string(dir.path().join(CONFIG_REL)).unwrap();
    assert!(!written.contains("private") && !written.contains("catalogPath"));
    assert_eq!(AgentConfig::read(dir.path()).unwrap(), decoded);
    for kind in [Kind::Variable, Kind::Secret] {
        save(
            &config,
            &secrets,
            &reference,
            Mode::Local,
            kind,
            Some("new"),
        );
        assert_eq!(
            decoded.resolve_with_store(&secrets).is_ok(),
            kind == Kind::Secret
        );
    }
    std::fs::write(config.library_directory.join("settings.json"), "{}").unwrap();
    assert!(decoded.resolve_with_store(&secrets).is_err());
}
#[test]
fn failure_collision_and_clone_never_fall_back_or_publish_values() {
    let (dir, config, secrets) = fixture();
    for (_, source) in config.bindings.roles() {
        save(
            &config,
            &secrets,
            source,
            Mode::Git,
            Kind::Secret,
            Some("private"),
        );
    }
    config.write(dir.path()).unwrap();
    let mut invalid = config.clone();
    invalid.version = 1;
    assert!(invalid.write(dir.path()).is_err());
    assert_eq!(AgentConfig::read(dir.path()).unwrap(), config);
    secrets.0.borrow_mut().clear();
    assert!(config.resolve_with_store(&secrets).is_err());
    for (_, source) in config.bindings.roles() {
        save(
            &config,
            &secrets,
            source,
            Mode::Git,
            Kind::Secret,
            Some("private"),
        );
    }
    let path = dir.path().join("child/.svode/local.json");
    let mut local: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let portable: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("child/.svode/config.json")).unwrap(),
    )
    .unwrap();
    local["variables"]["entries"]["KEY"] = portable["variables"]["entries"]["KEY"].clone();
    std::fs::write(&path, local.to_string()).unwrap();
    assert!(
        config
            .resolve_with_store(&secrets)
            .err()
            .unwrap()
            .contains("conflict")
    );
    let clone = tempfile::tempdir().unwrap();
    for folder in ["", "child"] {
        std::fs::create_dir_all(clone.path().join(folder).join(".svode")).unwrap();
        std::fs::copy(
            dir.path().join(folder).join(".svode/config.json"),
            clone.path().join(folder).join(".svode/config.json"),
        )
        .unwrap();
    }
    let mut cloned = config;
    cloned.project_path = Some(clone.path().into());
    assert!(cloned.resolve_with_store(&secrets).is_err());
    assert!(AgentConfig::read(clone.path()).is_err());
}
#[test]
fn corrupt_and_unknown_versions_fail_closed() {
    let (dir, _, _) = fixture();
    for input in ["{", r#"{"version":3}"#, r#"{"keychainAccount":"old"}"#] {
        std::fs::write(dir.path().join(CONFIG_REL), input).unwrap();
        assert_eq!(AgentConfig::read(dir.path()).unwrap_err(), SETUP_REQUIRED);
    }
}
#[test]
fn standalone_process_reads_scoped_sources_without_desktop() {
    const ENV: &str = "SVODE_DF107_PROCESS_FIXTURE";
    if let Ok(root) = std::env::var(ENV) {
        let path = Path::new(&root);
        let secrets = Secrets(RefCell::new(
            serde_json::from_slice(&std::fs::read(path.join("test-secrets.json")).unwrap())
                .unwrap(),
        ));
        let config = AgentConfig::read(path).unwrap();
        let result = config.resolve_with_store(&secrets).unwrap();
        assert_eq!(result.access_key, "project");
        assert_eq!(result.secret_key, "child");
        return;
    }
    let (dir, config, secrets) = fixture();
    save(
        &config,
        &secrets,
        &config.bindings.access_key,
        Mode::Local,
        Kind::Secret,
        Some("project"),
    );
    save(
        &config,
        &secrets,
        &config.bindings.secret_key,
        Mode::Git,
        Kind::Secret,
        Some("child"),
    );
    config.write(dir.path()).unwrap();
    // Test-only provider fixture, never used by shipped code.
    save(
        &config,
        &secrets,
        &source(SourceOwner::Library, "ACCESS"),
        Mode::Local,
        Kind::Secret,
        Some("project"),
    );
    save(
        &config,
        &secrets,
        &source(SourceOwner::Library, "SECRET"),
        Mode::Local,
        Kind::Secret,
        Some("child"),
    );
    std::fs::write(
        dir.path().join("test-secrets.json"),
        serde_json::to_vec(&*secrets.0.borrow()).unwrap(),
    )
    .unwrap();
    for version in [2, 1] {
        if version == 1 {
            let old = json!({"version":1,"endpoint":config.endpoint,"bucket":config.bucket,"region":config.region,"prefix":config.prefix,
            "catalogPath":config.library_directory.join("settings.json"),"bindings":{"accessKey":"ACCESS","secretKey":"SECRET"}});
            std::fs::write(dir.path().join(CONFIG_REL), old.to_string()).unwrap();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "storage::s3_tests::standalone_process_reads_scoped_sources_without_desktop",
            ])
            .env(ENV, dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
