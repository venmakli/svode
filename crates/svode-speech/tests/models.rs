//! Installing, updating and removing models in the device-local store.

use std::collections::BTreeMap;
use std::path::Path;

use sha2::{Digest, Sha256};
use svode_speech::catalog::{Catalog, CatalogModel, Language, License, Source};
use svode_speech::models::{Installation, Measurement, ModelError, ModelStore};
use svode_speech::protocol::Backend;

fn entry(id: &str, content: &[u8]) -> CatalogModel {
    CatalogModel {
        id: id.to_string(),
        name: id.to_string(),
        family: "whisper".into(),
        mark: None,
        file: format!("{id}-Q8_0.gguf"),
        quant: "Q8_0".into(),
        source: Source {
            repo: format!("handy-computer/{id}-gguf"),
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
        upstream: format!("upstream/{id}"),
    }
}

fn catalog(models: Vec<CatalogModel>) -> Catalog {
    Catalog {
        engine: "test".into(),
        models,
    }
}

async fn install(
    store: &ModelStore,
    model: &CatalogModel,
    content: &[u8],
) -> Result<(), ModelError> {
    let mut install = store.begin_install(model)?;
    for chunk in content.chunks(3) {
        install.write(chunk).await?;
    }
    install.finish().await.map(|_| ())
}

/// Every file under `dir`, relative, with its content.
fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, files);
            } else {
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                files.insert(name, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(dir, dir, &mut files);
    files
}

fn measurement() -> Measurement {
    Measurement {
        seconds: 1.5,
        backend: Backend::Cpu,
        version: "1".into(),
    }
}

#[tokio::test]
async fn an_install_checks_the_file_and_makes_a_new_model_active() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let tiny = entry("tiny", b"tiny model bytes");
    let catalog = catalog(vec![tiny.clone()]);

    install(&store, &tiny, b"tiny model bytes").await.unwrap();

    let installed = store.installed();
    assert_eq!(installed.len(), 1);
    assert_eq!(
        ModelStore::installation(&installed[0], &catalog),
        Installation::Current
    );
    assert_eq!(
        std::fs::read(store.model_path(&installed[0])).unwrap(),
        b"tiny model bytes"
    );
    assert_eq!(store.active(&catalog), Some(installed[0].clone()));
}

#[tokio::test]
async fn a_wrong_hash_a_cancel_or_a_broken_download_leave_the_previous_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let tiny = entry("tiny", b"tiny model bytes");
    let before = snapshot(dir.path());

    let wrong = install(&store, &tiny, b"tiny model BYTES").await;
    assert!(matches!(wrong, Err(ModelError::Integrity)));
    assert_eq!(snapshot(dir.path()), before);

    let longer = install(&store, &tiny, b"tiny model bytes and more").await;
    assert!(matches!(longer, Err(ModelError::Integrity)));
    assert_eq!(snapshot(dir.path()), before);

    let shorter = install(&store, &tiny, b"tiny model").await;
    assert!(matches!(shorter, Err(ModelError::Integrity)));
    assert_eq!(snapshot(dir.path()), before);

    // A cancel and a network failure drop the install halfway.
    let mut cancelled = store.begin_install(&tiny).unwrap();
    cancelled.write(b"tiny mo").await.unwrap();
    drop(cancelled);
    assert_eq!(snapshot(dir.path()), before);
    assert!(store.installed().is_empty());
    assert_eq!(store.settings().active_model, None);
}

#[tokio::test]
async fn a_failed_update_keeps_the_installed_file_working() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let old = entry("tiny", b"old file");
    install(&store, &old, b"old file").await.unwrap();
    store.record_measurement("tiny", measurement()).unwrap();
    let before = snapshot(dir.path());

    let new = entry("tiny", b"new file!");
    let failed = install(&store, &new, b"new file?").await;
    assert!(matches!(failed, Err(ModelError::Integrity)));
    let mut cancelled = store.begin_install(&new).unwrap();
    cancelled.write(b"new").await.unwrap();
    drop(cancelled);

    assert_eq!(snapshot(dir.path()), before);
    let catalog = catalog(vec![new]);
    let installed = store.active(&catalog).unwrap();
    assert_eq!(
        ModelStore::installation(&installed, &catalog),
        Installation::Outdated
    );
    assert_eq!(
        std::fs::read(store.model_path(&installed)).unwrap(),
        b"old file"
    );
}

#[tokio::test]
async fn an_update_replaces_the_file_and_keeps_the_active_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let a = entry("a", b"model a");
    let old_b = entry("b", b"old b");
    install(&store, &old_b, b"old b").await.unwrap();
    install(&store, &a, b"model a").await.unwrap();
    assert_eq!(store.settings().active_model.as_deref(), Some("a"));
    store.record_measurement("b", measurement()).unwrap();

    let new_b = entry("b", b"new b file");
    install(&store, &new_b, b"new b file").await.unwrap();

    let catalog = catalog(vec![a, new_b]);
    let settings = store.settings();
    assert_eq!(settings.active_model.as_deref(), Some("a"));
    assert!(!settings.measurements.contains_key("b"));
    let b = store.installed().into_iter().find(|m| m.id == "b").unwrap();
    assert_eq!(
        ModelStore::installation(&b, &catalog),
        Installation::Current
    );
    assert_eq!(std::fs::read(store.model_path(&b)).unwrap(), b"new b file");
    let models = snapshot(&dir.path().join("speech/models"));
    assert_eq!(
        models.keys().cloned().collect::<Vec<_>>(),
        [
            "a/a-Q8_0.gguf",
            "a/model.json",
            "b/b-Q8_0.gguf",
            "b/model.json"
        ]
    );
}

#[tokio::test]
async fn a_measurement_never_changes_the_active_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let a = entry("a", b"model a");
    let b = entry("b", b"model b");
    install(&store, &a, b"model a").await.unwrap();
    install(&store, &b, b"model b").await.unwrap();

    store.record_measurement("a", measurement()).unwrap();

    assert_eq!(store.settings().active_model.as_deref(), Some("b"));
}

#[tokio::test]
async fn a_repeated_download_does_not_duplicate_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let tiny = entry("tiny", b"tiny model bytes");

    let first = store.begin_install(&tiny).unwrap();
    assert!(matches!(
        store.begin_install(&tiny),
        Err(ModelError::Busy(_))
    ));
    drop(first);

    install(&store, &tiny, b"tiny model bytes").await.unwrap();
    assert!(matches!(
        store.begin_install(&tiny),
        Err(ModelError::AlreadyInstalled(_))
    ));
    assert_eq!(store.installed().len(), 1);
}

#[tokio::test]
async fn removing_a_model_touches_only_its_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("speech");
    let store = ModelStore::open(root.clone());
    let a = entry("a", b"model a");
    let b = entry("b", b"model b");
    install(&store, &a, b"model a").await.unwrap();
    install(&store, &b, b"model b").await.unwrap();
    store.record_measurement("a", measurement()).unwrap();
    store.record_measurement("b", measurement()).unwrap();
    std::fs::write(root.join("engine.json"), b"{}").unwrap();

    let mut expected = snapshot(dir.path());
    store.delete("b").unwrap();

    expected
        .retain(|path, _| !path.starts_with("speech/models/b/") && path != "speech/settings.json");
    let mut after = snapshot(dir.path());
    let settings = after.remove("speech/settings.json").unwrap();
    assert_eq!(after, expected);
    let settings: serde_json::Value = serde_json::from_slice(&settings).unwrap();
    // b was the active model: none is active until the user picks another.
    assert_eq!(settings["activeModel"], serde_json::Value::Null);
    assert!(settings["measurements"]["a"].is_object());
    assert!(settings["measurements"]["b"].is_null());

    assert!(matches!(
        store.delete("b"),
        Err(ModelError::NotInstalled(_))
    ));
}

#[tokio::test]
async fn a_model_the_release_dropped_is_unsupported_and_cannot_be_active() {
    let dir = tempfile::tempdir().unwrap();
    let store = ModelStore::open(dir.path().join("speech"));
    let gone = entry("gone", b"gone");
    install(&store, &gone, b"gone").await.unwrap();

    let catalog = catalog(vec![entry("other", b"other")]);
    let installed = &store.installed()[0];
    assert_eq!(
        ModelStore::installation(installed, &catalog),
        Installation::Unsupported
    );
    assert_eq!(store.active(&catalog), None);
    assert!(matches!(
        store.activate("gone", &catalog),
        Err(ModelError::UnknownModel(_))
    ));
    store.delete("gone").unwrap();
    assert!(store.installed().is_empty());
}

#[tokio::test]
async fn opening_the_store_finishes_an_interrupted_install_or_update() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("speech");
    let models = root.join("models");
    {
        let store = ModelStore::open(root.clone());
        install(&store, &entry("a", b"model a"), b"model a")
            .await
            .unwrap();
    }
    // Quit between the renames of an update of a, during an install of b
    // and during the removal of c.
    std::fs::rename(models.join("a"), models.join(".replaced-a")).unwrap();
    std::fs::create_dir_all(models.join(".staging-b")).unwrap();
    std::fs::write(models.join(".staging-b/b.gguf"), b"part").unwrap();
    std::fs::create_dir_all(models.join(".removed-c")).unwrap();

    let store = ModelStore::open(root);

    let installed = store.installed();
    assert_eq!(installed.len(), 1);
    assert_eq!(
        std::fs::read(store.model_path(&installed[0])).unwrap(),
        b"model a"
    );
    let names: Vec<_> = std::fs::read_dir(&models)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["a"]);
}

#[test]
fn the_release_catalog_is_the_one_the_store_checks_against() {
    let catalog = svode_speech::catalog::catalog();
    let tiny = catalog.get("whisper-tiny").unwrap();
    assert_eq!(
        tiny.sha256, "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834",
        "the test model of scripts/fetch-speech-test-model.mjs"
    );
}
