//! The speech process driven through its client, the way a host drives it.
//!
//! Recognition tests need the test model: `node scripts/fetch-speech-test-model.mjs`
//! puts it where they look (or set `SVODE_SPEECH_TEST_MODEL`). Without it they
//! are skipped, unless `SVODE_SPEECH_REQUIRE_MODEL` is set, as in CI.
//! `SVODE_SPEECH_EXPECT_BACKEND` (`cpu`, `metal` or `vulkan`) pins the backend
//! the engine must pick on its own on the machine running the tests.

mod common;

use std::time::Duration;

use common::{PHRASE, config, fixture, model, normalized, refuse_acceleration};
use svode_speech::client::{Recognizer, RecognizerError, TimeoutPolicy};
use svode_speech::protocol::{Backend, ErrorCode};

#[tokio::test]
async fn recognizes_the_fixture_on_the_cpu() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    refuse_acceleration(&dir);
    let recognizer = Recognizer::new(config(&dir, None));

    let result = recognizer
        .transcribe(&model, &fixture(), Some("en"))
        .await
        .unwrap();

    assert_eq!(result.backend, Backend::Cpu);
    assert!(
        normalized(&result.text).contains(PHRASE),
        "unexpected transcript of the fixture"
    );
    recognizer.shutdown().await;
}

#[tokio::test]
async fn picks_the_gpu_when_there_is_one_and_the_cpu_otherwise() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, None));

    recognizer.prepare(&model).await.unwrap();
    let result = recognizer
        .transcribe(&model, &fixture(), None)
        .await
        .unwrap();

    if let Ok(expected) = std::env::var("SVODE_SPEECH_EXPECT_BACKEND") {
        assert_eq!(format!("{:?}", result.backend).to_lowercase(), expected);
    }
    assert!(normalized(&result.text).contains(PHRASE));
    assert!(!recognizer.acceleration_refused());
    recognizer.shutdown().await;
}

#[tokio::test]
async fn a_crash_is_an_error_and_the_host_starts_a_new_process() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, Some("crash")));
    let samples = fixture();

    let first = recognizer.transcribe(&model, &samples, None).await;
    assert!(matches!(first, Err(RecognizerError::Crashed)), "{first:?}");
    assert!(!recognizer.is_running().await);

    recognizer.prepare(&model).await.unwrap();
    assert!(recognizer.is_running().await);
    let second = recognizer.transcribe(&model, &samples, None).await;
    assert!(
        matches!(second, Err(RecognizerError::Crashed)),
        "{second:?}"
    );
}

#[tokio::test]
async fn a_crash_with_acceleration_moves_the_device_to_the_cpu_until_an_update() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, Some("crash-accelerated")));
    let samples = fixture();

    let failed = recognizer.transcribe(&model, &samples, None).await;
    assert!(
        matches!(failed, Err(RecognizerError::Crashed)),
        "{failed:?}"
    );
    assert!(recognizer.acceleration_refused());

    let retried = recognizer.transcribe(&model, &samples, None).await.unwrap();
    assert_eq!(retried.backend, Backend::Cpu);
    assert!(normalized(&retried.text).contains(PHRASE));
    recognizer.shutdown().await;

    assert!(Recognizer::new(config(&dir, None)).acceleration_refused());
    let mut updated = config(&dir, None);
    updated.build_version = "0.1.0-test".into();
    assert!(!Recognizer::new(updated).acceleration_refused());
}

#[tokio::test]
async fn a_recognition_past_its_limit_times_out_and_stops_the_process() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let mut config = config(&dir, Some("stall"));
    config.timeout = TimeoutPolicy {
        base: Duration::from_secs(2),
        per_audio: 0,
    };
    let recognizer = Recognizer::new(config);

    let result = recognizer.transcribe(&model, &fixture(), None).await;

    assert!(
        matches!(result, Err(RecognizerError::TimedOut { limit }) if limit == Duration::from_secs(2)),
        "{result:?}"
    );
    assert!(!recognizer.is_running().await);
}

#[tokio::test]
async fn shutdown_ends_a_recognition_in_progress() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, Some("stall")));
    let samples = fixture();

    let running = recognizer.clone();
    let recognition = tokio::spawn(async move { running.transcribe(&model, &samples, None).await });
    tokio::time::sleep(Duration::from_secs(2)).await;
    tokio::time::timeout(Duration::from_secs(5), recognizer.shutdown())
        .await
        .expect("shutdown waits for the recognition");

    let result = recognition.await.unwrap();
    assert!(
        matches!(result, Err(RecognizerError::Stopped)),
        "{result:?}"
    );
    assert!(!recognizer.is_running().await);
}

#[tokio::test]
async fn an_idle_process_stops() {
    let Some(model) = model() else { return };
    let dir = tempfile::tempdir().unwrap();
    let mut config = config(&dir, None);
    config.idle = Duration::from_millis(500);
    let recognizer = Recognizer::new(config);

    recognizer
        .transcribe(&model, &fixture(), None)
        .await
        .unwrap();
    assert!(recognizer.is_running().await);

    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!recognizer.is_running().await);
}

#[tokio::test]
async fn a_missing_model_is_a_typed_error() {
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, None));
    let missing = dir.path().join("missing.gguf");

    let result = recognizer.transcribe(&missing, &[0.0; 16_000], None).await;

    assert!(
        matches!(
            result,
            Err(RecognizerError::Engine(ErrorCode::ModelMissing))
        ),
        "{result:?}"
    );
    assert!(!recognizer.is_running().await);
    assert!(!recognizer.acceleration_refused());
}

#[tokio::test]
async fn shutdown_stops_a_prepared_process() {
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, None));

    recognizer
        .prepare(&dir.path().join("missing.gguf"))
        .await
        .unwrap();
    assert!(recognizer.is_running().await);

    recognizer.shutdown().await;
    assert!(!recognizer.is_running().await);
}
