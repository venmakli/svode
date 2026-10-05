//! What the speech process tests share. Each test binary uses part of it.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use svode_speech::client::RecognizerConfig;

pub const PHRASE: &str = "ask not what your country can do for you";
pub const VERSION: &str = "0.0.9-test";

pub fn model() -> Option<PathBuf> {
    let path = std::env::var_os("SVODE_SPEECH_TEST_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/speech-test/whisper-tiny-Q8_0.gguf")
        });
    if path.exists() {
        return Some(path);
    }
    assert!(
        std::env::var_os("SVODE_SPEECH_REQUIRE_MODEL").is_none(),
        "the speech test model is missing at {}",
        path.display()
    );
    eprintln!("skipped: no speech test model at {}", path.display());
    None
}

/// The reference recording: JFK's inaugural address (public domain), 11 s
/// of 16 kHz mono.
pub fn fixture() -> Vec<f32> {
    svode_speech::preparation::reference().to_vec()
}

pub fn config(dir: &tempfile::TempDir, fault: Option<&str>) -> RecognizerConfig {
    let mut config = RecognizerConfig::new(
        PathBuf::from(env!("CARGO_BIN_EXE_svode-speech")),
        dir.path().join("speech/engine.json"),
        VERSION,
    );
    if let Some(fault) = fault {
        config.env.push(("SVODE_SPEECH_FAULT".into(), fault.into()));
    }
    config
}

/// A device that already refused acceleration recognizes on the CPU only.
pub fn refuse_acceleration(dir: &tempfile::TempDir) {
    let state = dir.path().join("speech/engine.json");
    std::fs::create_dir_all(state.parent().unwrap()).unwrap();
    std::fs::write(
        state,
        format!(r#"{{"accelerationRefusedFor":"{VERSION}"}}"#),
    )
    .unwrap();
}

pub fn normalized(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
