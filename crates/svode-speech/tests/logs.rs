//! Speech logs carry facts only. Its own test binary: `tracing` caches
//! callsite interest process-wide, so a scoped subscriber in a binary whose
//! other tests log without one would miss the events.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use common::{PHRASE, config, fixture, model, normalized};
use svode_speech::client::Recognizer;

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn logs_carry_facts_but_no_audio_or_text() {
    let Some(model) = model() else { return };
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let dir = tempfile::tempdir().unwrap();
    let recognizer = Recognizer::new(config(&dir, None));

    let result = recognizer
        .transcribe(&model, &fixture(), None)
        .await
        .unwrap();
    recognizer.shutdown().await;

    assert!(normalized(&result.text).contains(PHRASE));
    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("speech process started"), "{logs}");
    assert!(logs.contains("speech recognized"), "{logs}");
    assert!(logs.contains("audio_ms=11000"), "{logs}");
    for word in ["country", "ask not", "fellow"] {
        assert!(!logs.to_lowercase().contains(word), "logs quote the text");
    }
}
