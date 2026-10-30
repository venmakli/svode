use std::fs;
use std::path::Path;

use serde_json::{Value, json};

use super::*;
use crate::routines::local::GitUserPolicy;
use crate::storage::config::BINARY_ROUTING_VERSION;

fn config_with_git() -> SpaceConfig {
    SpaceConfig {
        name: "Docs".to_string(),
        description: String::new(),
        icon: "folder".to_string(),
        spaces: None,
        agent: None,
        defaults: None,
        git: Some(GitSpaceConfig {
            auto_sync: Some(true),
            auto_commit_structural: Some(true),
            auto_commit_system: Some(true),
        }),
        assets: None,
        tree: None,
        extensions: UnknownKeys::new(),
    }
}

fn write_raw(space: &Path, value: &Value) {
    let dir = space.join(".svode");
    fs::create_dir_all(&dir).expect("svode dir");
    fs::write(
        dir.join("config.json"),
        serde_json::to_string_pretty(value).expect("json"),
    )
    .expect("config");
}

fn raw(space: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(space.join(".svode/config.json")).expect("config"))
        .expect("json")
}

/// A config written by a newer Svode version: an unknown key on every level
/// of the known structure, next to the Variables section and the legacy Git
/// policy.
fn future_config() -> Value {
    json!({
        "name": "Project",
        "description": "",
        "icon": "folder",
        "futureRoot": { "mode": "team" },
        "agent": { "clis": ["claude"], "futureAgent": true },
        "defaults": {
            "futureDefaults": "kept",
            "agent": { "maxTurns": 3, "futureDefaultsAgent": [1, 2] }
        },
        "assets": {
            "strategy": "lfs-s3",
            "futureAssets": "kept",
            "binaryRouting": {
                "version": 1,
                "lfsExtensions": ["psd"],
                "lfsThresholdBytes": 10,
                "futureRouting": "kept"
            },
            "s3": {
                "endpoint": "https://s3.example.test",
                "bucket": "bucket",
                "region": "eu",
                "prefix": "project",
                "futureS3": { "class": "cold" }
            }
        },
        "tree": { "exclude": ["node_modules"], "futureTree": 1 },
        "spaces": [
            { "id": "a", "path": "alpha", "repo": null, "futureSpace": "alpha" },
            { "id": "b", "path": "beta", "repo": null, "futureSpace": "beta" }
        ],
        "variables": { "GIT": { "value": "portable" } },
        "git": { "autoSync": true }
    })
}

fn assert_unknown_keys_kept(value: &Value) {
    assert_eq!(value["futureRoot"], json!({ "mode": "team" }));
    assert_eq!(value["agent"]["futureAgent"], true);
    assert_eq!(value["defaults"]["futureDefaults"], "kept");
    assert_eq!(
        value["defaults"]["agent"]["futureDefaultsAgent"],
        json!([1, 2])
    );
    assert_eq!(value["assets"]["futureAssets"], "kept");
    assert_eq!(value["assets"]["binaryRouting"]["futureRouting"], "kept");
    assert_eq!(
        value["assets"]["s3"]["futureS3"],
        json!({ "class": "cold" })
    );
    assert_eq!(value["tree"]["futureTree"], 1);
}

fn space_entry<'a>(value: &'a Value, id: &str) -> Option<&'a Value> {
    value["spaces"]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["id"] == id))
}

/// The config the frontend sends back: the known fields only.
fn known_fields_only(config: &SpaceConfig) -> SpaceConfig {
    let mut value = serde_json::to_value(config).expect("value");
    strip_unknown(&mut value);
    serde_json::from_value(value).expect("config")
}

fn strip_unknown(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.retain(|key, _| !key.starts_with("future"));
        for child in object.values_mut() {
            strip_unknown(child);
        }
    } else if let Some(items) = value.as_array_mut() {
        items.iter_mut().for_each(strip_unknown);
    }
}

#[test]
fn write_keeps_unknown_keys_of_the_file_on_every_level() {
    let temp = tempfile::tempdir().expect("temp dir");
    write_raw(temp.path(), &future_config());

    let mut config = known_fields_only(&read(temp.path()).expect("read"));
    config.name = "Renamed".into();
    write(temp.path(), &config).expect("write");

    let value = raw(temp.path());
    assert_eq!(value["name"], "Renamed");
    assert_unknown_keys_kept(&value);
    assert_eq!(space_entry(&value, "a").unwrap()["futureSpace"], "alpha");
    assert_eq!(space_entry(&value, "b").unwrap()["futureSpace"], "beta");
    assert_eq!(value["variables"]["GIT"]["value"], "portable");
    assert!(value.get("git").is_none());
}

#[test]
fn write_takes_unknown_keys_from_the_file_at_write_time() {
    let temp = tempfile::tempdir().expect("temp dir");
    write_raw(temp.path(), &future_config());
    let stale = read(temp.path()).expect("read");

    let mut synced = future_config();
    synced["futureSynced"] = json!("arrived");
    synced["spaces"][1]["futureSynced"] = json!("arrived");
    synced
        .as_object_mut()
        .unwrap()
        .remove("futureRoot")
        .expect("root key");
    write_raw(temp.path(), &synced);
    write(temp.path(), &stale).expect("write");

    let value = raw(temp.path());
    assert_eq!(value["futureSynced"], "arrived");
    assert_eq!(space_entry(&value, "b").unwrap()["futureSynced"], "arrived");
    assert!(value.get("futureRoot").is_none());
}

#[test]
fn removed_known_objects_and_space_entries_take_their_unknown_keys_along() {
    let temp = tempfile::tempdir().expect("temp dir");
    write_raw(temp.path(), &future_config());

    let mut config = read(temp.path()).expect("read");
    config.agent = None;
    config.assets.as_mut().unwrap().s3 = None;
    let spaces = config.spaces.as_mut().unwrap();
    spaces.retain(|entry| entry.id != "b");
    spaces.push(SpaceRef {
        id: "c".into(),
        path: "gamma".into(),
        repo: None,
        extensions: UnknownKeys::from([("futureSpace".into(), json!("stale copy"))]),
    });
    write(temp.path(), &config).expect("write");

    let value = raw(temp.path());
    assert!(value.get("agent").is_none());
    assert!(value["assets"].get("s3").is_none());
    assert_eq!(value["assets"]["futureAssets"], "kept");
    assert!(space_entry(&value, "b").is_none());
    assert_eq!(space_entry(&value, "a").unwrap()["futureSpace"], "alpha");
    let added = space_entry(&value, "c").expect("added entry");
    assert!(added.get("futureSpace").is_none());
}

#[test]
fn mutate_reads_the_file_under_the_lock_and_keeps_unknown_keys() {
    let temp = tempfile::tempdir().expect("temp dir");
    write_raw(temp.path(), &future_config());

    mutate(temp.path(), |config| {
        config
            .spaces
            .as_mut()
            .unwrap()
            .retain(|entry| entry.id != "a");
        Ok::<_, SpaceConfigError>(())
    })
    .expect("mutate");

    let value = raw(temp.path());
    assert_unknown_keys_kept(&value);
    assert!(space_entry(&value, "a").is_none());
    assert_eq!(space_entry(&value, "b").unwrap()["futureSpace"], "beta");
    assert_eq!(value["variables"]["GIT"]["value"], "portable");
    assert!(value.get("git").is_none());
}

#[test]
fn writers_keep_an_unknown_storage_strategy_as_written() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut fixture = future_config();
    fixture["assets"]["strategy"] = json!("lfs-future");
    write_raw(temp.path(), &fixture);

    let mut config = known_fields_only(&read(temp.path()).expect("read"));
    config.name = "Renamed".into();
    write(temp.path(), &config).expect("write");
    assert_eq!(raw(temp.path())["assets"]["strategy"], "lfs-future");

    mutate(temp.path(), |config| {
        config.spaces.as_mut().unwrap().reverse();
        Ok::<_, SpaceConfigError>(())
    })
    .expect("mutate");
    let value = raw(temp.path());
    assert_eq!(value["assets"]["strategy"], "lfs-future");
    assert_unknown_keys_kept(&value);
    assert_eq!(
        crate::storage::config::read_space_assets_config(temp.path())
            .expect("core assets read")
            .assets
            .expect("assets")
            .strategy,
        crate::storage::config::AssetsStrategy::Unknown("lfs-future".into())
    );
}

#[test]
fn read_leaves_the_variables_section_to_variables() {
    let temp = tempfile::tempdir().expect("temp dir");
    write_raw(temp.path(), &future_config());

    let config = read(temp.path()).expect("read");

    assert!(!config.extensions.contains_key("variables"));
    assert_eq!(config.extensions["futureRoot"], json!({ "mode": "team" }));
}

#[test]
fn a_config_without_unknown_keys_is_written_as_before() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut config = config_with_git();
    config.spaces = Some(vec![SpaceRef {
        id: "a".into(),
        path: "alpha".into(),
        repo: None,
        extensions: UnknownKeys::new(),
    }]);

    write(temp.path(), &config).expect("write");

    assert_eq!(
        fs::read_to_string(temp.path().join(".svode/config.json")).expect("config"),
        "{\n  \"description\": \"\",\n  \"icon\": \"folder\",\n  \"name\": \"Docs\",\n  \"spaces\": [\n    {\n      \"id\": \"a\",\n      \"path\": \"alpha\",\n      \"repo\": null\n    }\n  ]\n}"
    );
}

/// Contents of `.svode/config.json` that exist but cannot be read, with the
/// reason each one gives.
fn unreadable_files() -> Vec<(&'static str, String, Unreadable)> {
    let field = |field: &str| Unreadable::Field {
        field: field.to_string(),
    };
    vec![
        (
            "conflict markers",
            "{\n<<<<<<< HEAD\n  \"name\": \"Ours\"\n=======\n  \"name\": \"Theirs\"\n>>>>>>> origin/main\n}\n"
                .to_string(),
            Unreadable::Conflict,
        ),
        ("broken JSON", "{\"name\": \"Docs\",".to_string(), Unreadable::NotJson),
        ("not an object", "[\"Docs\"]".to_string(), Unreadable::NotJson),
        ("no name", "{\"icon\": \"x\"}".to_string(), field("name")),
        (
            "field of another type",
            "{\"name\": \"Docs\", \"spaces\": {\"id\": 1}}".to_string(),
            field("spaces"),
        ),
        (
            "repeated key",
            "{\"name\": \"Ours\", \"name\": \"Theirs\"}".to_string(),
            field("name"),
        ),
    ]
}

#[test]
fn read_tells_why_an_existing_file_cannot_be_read() {
    for (case, contents, reason) in unreadable_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
        fs::write(temp.path().join(".svode/config.json"), &contents).expect("config");

        match read(temp.path()) {
            Err(SpaceConfigError::Unreadable(actual)) => assert_eq!(actual, reason, "{case}"),
            other => panic!("{case}: {other:?}"),
        }
    }
    let temp = tempfile::tempdir().expect("temp dir");
    assert!(matches!(
        read(temp.path()),
        Err(SpaceConfigError::Missing(_))
    ));
}

#[test]
fn the_reason_names_neither_the_path_nor_the_contents() {
    for (case, contents, _) in unreadable_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
        fs::write(temp.path().join(".svode/config.json"), &contents).expect("config");

        let message = read(temp.path()).unwrap_err().to_string();
        assert!(
            message.starts_with(".svode/config.json cannot be read: "),
            "{case}"
        );
        assert!(!message.contains(&*temp.path().to_string_lossy()), "{case}");
        assert!(
            !message.contains("Ours") && !message.contains("Docs"),
            "{case}"
        );
    }
}

#[test]
fn writers_refuse_an_unreadable_file_and_leave_it_as_is() {
    for (case, contents, reason) in unreadable_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
        let path = temp.path().join(".svode/config.json");
        fs::write(&path, &contents).expect("config");

        let refused = |result: Result<(), SpaceConfigError>| match result {
            Err(SpaceConfigError::Unreadable(actual)) => assert_eq!(actual, reason, "{case}"),
            other => panic!("{case}: {other:?}"),
        };
        refused(write(temp.path(), &config_with_git()));
        refused(mutate(temp.path(), |_| Ok::<_, SpaceConfigError>(())));
        assert!(matches!(
            create(temp.path(), &config_with_git()),
            Err(SpaceConfigError::Exists)
        ));
        assert_eq!(
            fs::read_to_string(&path).expect("config"),
            contents,
            "{case}"
        );
    }
}

#[test]
fn create_refuses_an_existing_file() {
    let temp = tempfile::tempdir().expect("temp dir");
    let config = json!({ "name": "Kept", "variables": { "GIT": {} } });
    write_raw(temp.path(), &config);

    assert!(matches!(
        create(temp.path(), &config_with_git()),
        Err(SpaceConfigError::Exists)
    ));
    assert_eq!(raw(temp.path()), config);
}

#[test]
fn create_writes_a_missing_file() {
    let temp = tempfile::tempdir().expect("temp dir");

    create(temp.path(), &config_with_git()).expect("create");

    let value = raw(temp.path());
    assert_eq!(value["name"], "Docs");
    assert!(value.get("git").is_none());
}

#[test]
fn write_drops_legacy_personal_git_policy() {
    let temp = tempfile::tempdir().expect("temp dir");

    write(temp.path(), &config_with_git()).expect("write config");

    let data = fs::read_to_string(temp.path().join(".svode/config.json")).expect("read config");
    assert!(!data.contains("autoSync"));
    assert!(!data.contains("autoCommitStructural"));
    assert!(!data.contains("autoCommitSystem"));

    let read_back = read(temp.path()).expect("read config");
    assert!(read_back.git.is_none());
}

#[test]
fn missing_binary_routing_stays_absent_on_read_and_write() {
    let temp = tempfile::tempdir().expect("temp dir");
    let dir = temp.path().join(".svode");
    fs::create_dir_all(&dir).expect("svode dir");
    fs::write(
        dir.join("config.json"),
        r#"{"name":"Legacy","assets":{"strategy":"lfs-remote"}}"#,
    )
    .expect("legacy config");

    let config = read(temp.path()).expect("read config");
    assert!(
        config
            .assets
            .as_ref()
            .is_some_and(|assets| assets.binary_routing.is_none())
    );
    write(temp.path(), &config).expect("write config");
    let raw = fs::read_to_string(dir.join("config.json")).expect("config");
    assert!(!raw.contains("binaryRouting"));
}

#[test]
fn future_binary_routing_fields_survive_config_round_trip() {
    let temp = tempfile::tempdir().expect("temp dir");
    let dir = temp.path().join(".svode");
    fs::create_dir_all(&dir).expect("svode dir");
    fs::write(
        dir.join("config.json"),
        r#"{
            "name":"Future",
            "assets":{
                "strategy":"lfs-remote",
                "binaryRouting":{
                    "version":2,
                    "lfsExtensions":["psd"],
                    "futureMode":"content-aware"
                }
            }
        }"#,
    )
    .expect("future config");

    let config = read(temp.path()).expect("read config");
    let routing = config
        .assets
        .as_ref()
        .and_then(|assets| assets.binary_routing.as_ref())
        .expect("routing");
    assert_ne!(routing.version, BINARY_ROUTING_VERSION);
    write(temp.path(), &config).expect("write config");
    let value = raw(temp.path());
    assert_eq!(
        value["assets"]["binaryRouting"]["futureMode"],
        "content-aware"
    );
}

#[test]
fn agent_section_survives_config_round_trip() {
    let temp = tempfile::tempdir().expect("temp dir");
    let agent = json!({
        "clis": ["claude"],
        "defaultModel": "sonnet",
        "systemPrompt": "Be brief.",
        "maxTurns": 12,
        "maxTimeout": 300
    });
    write_raw(temp.path(), &json!({ "name": "Legacy", "agent": agent }));

    let config = read(temp.path()).expect("read config");
    write(temp.path(), &config).expect("write config");
    assert_eq!(raw(temp.path())["agent"], agent);
}

#[test]
fn sibling_writers_preserve_latest_variables_and_reject_pending_transition() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), &config_with_git()).unwrap();
    let stale = read(temp.path()).unwrap();
    let context =
        crate::variables::Context::new(temp.path(), None, &temp.path().join("library")).unwrap();
    let owner =
        crate::variables::Owner::in_context(&context, &crate::variables::SourceOwner::Project)
            .unwrap();
    struct NoSecrets;
    impl crate::variables::SecretStore for NoSecrets {
        fn get(&self, _: &str) -> crate::variables::Result<Option<String>> {
            panic!("ordinary fixture")
        }
        fn set(&self, _: &str, _: &str) -> crate::variables::Result<()> {
            panic!("ordinary fixture")
        }
        fn remove(&self, _: &str) -> crate::variables::Result<()> {
            panic!("ordinary fixture")
        }
    }
    let service = crate::variables::Service::new(&NoSecrets);
    for (name, mode) in [
        ("PORTABLE", crate::variables::Mode::Git),
        ("LOCAL", crate::variables::Mode::Local),
    ] {
        service
            .save(
                &owner,
                crate::variables::Save {
                    name: name.into(),
                    mode,
                    kind: crate::variables::Kind::Variable,
                    value: Some(name.into()),
                    revision: service.catalog(&owner).unwrap().revision,
                    operation: crate::variables::SaveOperation::Create,
                    keep: None,
                },
            )
            .unwrap();
    }
    let before = service.catalog(&owner).unwrap();
    write(temp.path(), &stale).unwrap();
    crate::git::policy::write_user_policy(temp.path(), &GitUserPolicy::default()).unwrap();
    mutate(temp.path(), |_| Ok::<_, SpaceConfigError>(())).unwrap();
    let after = service.catalog(&owner).unwrap();
    assert_eq!(
        serde_json::to_value(before.entries).unwrap(),
        serde_json::to_value(after.entries).unwrap()
    );
    fs::write(temp.path().join(".svode/variables.pending.json"), "{}").unwrap();
    assert!(write(temp.path(), &stale).is_err());
    assert!(mutate(temp.path(), |_| Ok::<_, SpaceConfigError>(())).is_err());
    assert!(crate::git::policy::write_user_policy(temp.path(), &GitUserPolicy::default()).is_err());
}

#[test]
fn variables_refuse_to_write_a_config_that_cannot_be_read() {
    let temp = tempfile::tempdir().unwrap();
    let contents = "{\"icon\": \"x\", \"name\": \"A\", \"name\": \"B\"}";
    fs::create_dir_all(temp.path().join(".svode")).unwrap();
    fs::write(temp.path().join(".svode/config.json"), contents).unwrap();
    let context =
        crate::variables::Context::new(temp.path(), None, &temp.path().join("library")).unwrap();
    let owner =
        crate::variables::Owner::in_context(&context, &crate::variables::SourceOwner::Project)
            .unwrap();
    struct NoSecrets;
    impl crate::variables::SecretStore for NoSecrets {
        fn get(&self, _: &str) -> crate::variables::Result<Option<String>> {
            panic!("ordinary fixture")
        }
        fn set(&self, _: &str, _: &str) -> crate::variables::Result<()> {
            panic!("ordinary fixture")
        }
        fn remove(&self, _: &str) -> crate::variables::Result<()> {
            panic!("ordinary fixture")
        }
    }
    let service = crate::variables::Service::new(&NoSecrets);

    let saved = service.save(
        &owner,
        crate::variables::Save {
            name: "PORTABLE".into(),
            mode: crate::variables::Mode::Git,
            kind: crate::variables::Kind::Variable,
            value: Some("value".into()),
            revision: service.catalog(&owner).unwrap().revision,
            operation: crate::variables::SaveOperation::Create,
            keep: None,
        },
    );

    assert_eq!(saved.unwrap_err(), crate::variables::Error::InvalidConfig);
    assert_eq!(
        fs::read_to_string(temp.path().join(".svode/config.json")).unwrap(),
        contents
    );
}

#[test]
fn space_config_accepts_optional_tree_config_shape() {
    let config: SpaceConfig = serde_json::from_str(
        r#"{
            "name": "Docs",
            "tree": {
                "exclude": ["node_modules", "src/generated"],
                "include": ["docs/**/*.md"],
                "showIgnoredPlaceholders": true
            }
        }"#,
    )
    .expect("deserialize config");

    let tree = config.tree.expect("tree config");
    assert_eq!(tree.exclude, vec!["node_modules", "src/generated"]);
    assert_eq!(tree.include, vec!["docs/**/*.md"]);
    assert!(tree.show_ignored_placeholders);
}

#[test]
fn space_config_deserializes_without_tree_config() {
    let config: SpaceConfig =
        serde_json::from_str(r#"{"name":"Docs"}"#).expect("deserialize config");

    assert!(config.tree.is_none());
}

#[test]
fn git_config_accepts_legacy_personal_policy_fields() {
    let config: SpaceConfig = serde_json::from_str(
        r#"{
            "name": "Docs",
            "git": {
                "autoSync": true,
                "autoCommitStructural": true,
                "autoCommitSystem": false
            }
        }"#,
    )
    .expect("deserialize config");

    let git = config.git.expect("git config");
    assert_eq!(git.auto_sync, Some(true));
    assert_eq!(git.auto_commit_structural, Some(true));
    assert_eq!(git.auto_commit_system, Some(false));
}
