//! Speech recognition for dictation: the app's one speech process, driven
//! through `svode_speech::client`. The process is a sidecar next to the app
//! binary; its device-local state lives in the app data directory.

use std::path::{Path, PathBuf};

use svode_speech::client::{Recognizer, RecognizerConfig};

pub struct SpeechState(Recognizer);

impl SpeechState {
    pub fn new(data_dir: &Path, version: &str) -> Self {
        Self(Recognizer::new(RecognizerConfig::new(
            sidecar_path(),
            data_dir.join("speech/engine.json"),
            version,
        )))
    }

    pub async fn shutdown(&self) {
        self.0.shutdown().await;
    }
}

/// Tauri places `externalBin` sidecars next to the app binary, in
/// development builds too.
fn sidecar_path() -> PathBuf {
    let name = if cfg!(windows) {
        "svode-speech.exe"
    } else {
        "svode-speech"
    };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}
