//! Installing the compact catalog model from a local file and preparing it
//! through the real process, as CI does on Windows and Linux on the CPU.

mod common;

use common::{VERSION, config, model, refuse_acceleration};
use svode_speech::catalog::catalog;
use svode_speech::client::Recognizer;
use svode_speech::models::ModelStore;
use svode_speech::preparation::prepare;
use svode_speech::protocol::Backend;
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn installs_the_compact_catalog_model_and_measures_it_on_the_cpu() {
    let Some(source) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    refuse_acceleration(&dir);
    let store = ModelStore::open(dir.path().join("speech"));
    let entry = catalog().get("whisper-tiny").unwrap();

    let mut install = store.begin_install(entry).unwrap();
    let mut file = tokio::fs::File::open(&source).await.unwrap();
    let mut chunk = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut chunk).await.unwrap();
        if read == 0 {
            break;
        }
        install.write(&chunk[..read]).await.unwrap();
    }
    let installed = install.finish().await.unwrap();
    assert_eq!(store.active(catalog()), Some(installed.clone()));

    let recognizer = Recognizer::new(config(&dir, None));
    let measurement = prepare(&recognizer, entry, &store.model_path(&installed))
        .await
        .unwrap();

    assert_eq!(measurement.backend, Backend::Cpu);
    assert_eq!(measurement.version, VERSION);
    assert!(measurement.seconds > 0.0);
    assert!(measurement.is_current(VERSION, true));
    store
        .record_measurement(&installed.id, measurement.clone())
        .unwrap();
    assert_eq!(
        store.settings().measurements.get("whisper-tiny"),
        Some(&measurement)
    );
    recognizer.shutdown().await;
}

#[tokio::test]
async fn a_gpu_failing_during_the_preparation_moves_it_to_the_cpu() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, Some("crash-accelerated")));
    let entry = catalog().get("whisper-tiny").unwrap();

    let measurement = prepare(&recognizer, entry, &model).await.unwrap();

    assert!(recognizer.acceleration_refused());
    assert_eq!(measurement.backend, Backend::Cpu);
    assert!(measurement.is_current(VERSION, true));
    recognizer.shutdown().await;
}

#[tokio::test]
async fn probes_the_gpu_the_engine_would_accelerate_with() {
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, None));

    let gpu = recognizer.probe().await.unwrap();

    match std::env::var("SVODE_SPEECH_EXPECT_BACKEND").as_deref() {
        Ok("cpu") => assert_eq!(gpu, None),
        Ok("metal") => assert_eq!(gpu, Some(Backend::Metal)),
        Ok("vulkan") => assert_eq!(gpu, Some(Backend::Vulkan)),
        _ => {}
    }
    assert!(!recognizer.is_running().await);
}
