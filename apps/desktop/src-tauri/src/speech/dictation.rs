//! Dictation into a composer (`06`): the app's one recording, owned by a
//! composer of a webview, its recognition with the active model, a retry on
//! the same audio after a failed recognition, and cancel. Audio lives only
//! in this process and the speech process; it is dropped after the text,
//! a cancel or the release of its webview (V2, V6).
//!
//! A reload of the owner's webview stops the recording as ■: Desktop
//! recognizes it itself and keeps the text in memory until the webview's
//! new document takes it into the draft of the composer (DF-175).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use svode_speech::catalog::catalog;
use svode_speech::client::RecognizerError;
use svode_speech::protocol::ErrorCode;

use super::SpeechState;
use super::capture::{Capture, CaptureFailure};
use super::microphone::{self, Access};

/// The owner of the recording changed: a recording started or ended.
pub const DICTATION_CHANGED_EVENT: &str = "speech-dictation-changed";
/// Text recognized after a reload waits for the webview named in the
/// payload.
pub const DICTATED_TEXT_EVENT: &str = "speech-dictated-text";

/// A composer of a webview; `key` is the composer's own id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationOwner {
    pub webview: String,
    pub key: String,
}

/// Text recognized after its webview reloaded, for the draft of composer
/// `key` of that webview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictatedText {
    pub key: String,
    pub text: String,
}

/// Why a dictation gave no text, with the recovery the composer offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DictationFailure {
    /// Another composer records.
    Busy,
    /// No installed, supported active model: the enable popover.
    ModelMissing,
    #[serde(rename_all = "camelCase")]
    Denied {
        recovery: DeniedRecovery,
    },
    NoDevice,
    /// The recording had no signal (V2) and was not recognized.
    #[serde(rename_all = "camelCase")]
    NoSignal {
        sound_settings: bool,
    },
    /// The device failed while recording.
    Device,
    /// Recognition failed; "Повторить" recognizes the same audio.
    Recognition,
    /// The recording was cancelled meanwhile.
    Cancelled,
}

/// What lifts a denial of the microphone on this OS ("Ограничения
/// платформ" `06`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeniedRecovery {
    /// macOS with an ad-hoc signed release: the app is not listed in
    /// System Settings, so its decision is reset by this command; the
    /// system asks again after the next update anyway.
    ResetCommand { command: String },
    /// Windows: the desktop apps switch in the privacy settings.
    OpenSettings,
    /// Linux `.deb` has no permission model to change.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsTarget {
    MicrophonePrivacy,
    SoundInput,
}

pub fn denied_recovery(os: &str, identifier: &str) -> DeniedRecovery {
    match os {
        "macos" => DeniedRecovery::ResetCommand {
            command: format!("tccutil reset Microphone {identifier}"),
        },
        "windows" => DeniedRecovery::OpenSettings,
        _ => DeniedRecovery::None,
    }
}

/// The system settings page of `target`, where the OS has one to open.
pub fn settings_url(os: &str, target: SettingsTarget) -> Option<&'static str> {
    match (os, target) {
        ("windows", SettingsTarget::MicrophonePrivacy) => Some("ms-settings:privacy-microphone"),
        ("windows", SettingsTarget::SoundInput) => Some("ms-settings:sound"),
        ("macos", SettingsTarget::SoundInput) => {
            Some("x-apple.systempreferences:com.apple.preference.sound?input")
        }
        _ => None,
    }
}

fn capture_failure(failure: CaptureFailure, identifier: &str) -> DictationFailure {
    match failure {
        CaptureFailure::Denied => DictationFailure::Denied {
            recovery: denied_recovery(std::env::consts::OS, identifier),
        },
        CaptureFailure::NoDevice => DictationFailure::NoDevice,
        CaptureFailure::Device => DictationFailure::Device,
    }
}

fn recognition_failure(error: &RecognizerError) -> DictationFailure {
    match error {
        RecognizerError::Stopped => DictationFailure::Cancelled,
        RecognizerError::Engine(ErrorCode::ModelMissing | ErrorCode::ModelInvalid) => {
            DictationFailure::ModelMissing
        }
        _ => DictationFailure::Recognition,
    }
}

/// The model a recording is recognized with, fixed when it starts.
#[derive(Clone)]
pub(super) struct Model {
    id: String,
    path: PathBuf,
    language: Option<String>,
}

#[derive(Default)]
pub(super) enum Slot {
    #[default]
    Idle,
    /// Waiting for the OS permission and the device.
    Opening { owner: DictationOwner, id: u64 },
    Recording {
        owner: DictationOwner,
        id: u64,
        capture: Capture,
        model: Model,
    },
    Recognizing {
        owner: DictationOwner,
        id: u64,
        /// The owner's webview reloaded: the text waits in Desktop for its
        /// new document, a failure drops the audio.
        reloaded: bool,
    },
    /// A failed recognition keeps its audio for "Повторить".
    Recorded {
        owner: DictationOwner,
        id: u64,
        samples: Arc<Vec<f32>>,
        model: Model,
    },
}

impl Slot {
    fn owner(&self) -> Option<&DictationOwner> {
        match self {
            Slot::Idle => None,
            Slot::Opening { owner, .. }
            | Slot::Recording { owner, .. }
            | Slot::Recognizing { owner, .. }
            | Slot::Recorded { owner, .. } => Some(owner),
        }
    }

    fn id(&self) -> Option<u64> {
        match self {
            Slot::Idle => None,
            Slot::Opening { id, .. }
            | Slot::Recording { id, .. }
            | Slot::Recognizing { id, .. }
            | Slot::Recorded { id, .. } => Some(*id),
        }
    }
}

impl SpeechState {
    /// The composer that records, recognizes or holds a failed recording.
    pub fn dictation_owner(&self) -> Option<DictationOwner> {
        self.slot().owner().cloned()
    }

    /// Starts recording for `owner`: asks the OS permission, opens the
    /// default input device and starts the speech process with the active
    /// model, so it loads while the user speaks. A failed recording of the
    /// same owner is replaced.
    pub async fn start_dictation(
        &self,
        owner: DictationOwner,
        identifier: &str,
        level: impl FnMut(f32) + Send + 'static,
    ) -> Result<(), DictationFailure> {
        let id = {
            let mut slot = self.slot();
            match &*slot {
                Slot::Idle => {}
                Slot::Recorded { owner: holder, .. } if *holder == owner => {}
                _ => return Err(DictationFailure::Busy),
            }
            let id = self.next_dictation_id();
            *slot = Slot::Opening {
                owner: owner.clone(),
                id,
            };
            id
        };
        let opened = self.open_dictation(identifier, level).await;
        let mut slot = self.slot();
        if slot.id() != Some(id) {
            return Err(DictationFailure::Cancelled);
        }
        match opened {
            Ok((capture, model)) => {
                let recognizer = self.recognizer().clone();
                let path = model.path.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = recognizer.prepare(&path).await {
                        tracing::warn!("dictation: the speech process did not start: {error}");
                    }
                });
                *slot = Slot::Recording {
                    owner,
                    id,
                    capture,
                    model,
                };
                Ok(())
            }
            Err(failure) => {
                *slot = Slot::Idle;
                tracing::warn!(os = std::env::consts::OS, failure = ?failure, "dictation did not start");
                Err(failure)
            }
        }
    }

    async fn open_dictation(
        &self,
        identifier: &str,
        level: impl FnMut(f32) + Send + 'static,
    ) -> Result<(Capture, Model), DictationFailure> {
        let model = self.active_model().ok_or(DictationFailure::ModelMissing)?;
        if microphone::authorize().await == Access::Denied {
            return Err(capture_failure(CaptureFailure::Denied, identifier));
        }
        let capture = tauri::async_runtime::spawn_blocking(move || Capture::start(level))
            .await
            .map_err(|_| DictationFailure::Device)?
            .map_err(|failure| capture_failure(failure, identifier))?;
        Ok((capture, model))
    }

    fn active_model(&self) -> Option<Model> {
        let installed = self.store().active(catalog())?;
        let entry = catalog().get(&installed.id)?;
        Some(Model {
            id: installed.id.clone(),
            path: self.store().model_path(&installed),
            language: entry
                .language_tag(entry.language(self.store().settings().language))
                .map(str::to_string),
        })
    }

    /// Stops the recording of `owner` as ■ and recognizes it, or recognizes
    /// a failed recording again. A recording without signal is dropped
    /// unrecognized.
    pub async fn finish_dictation(
        &self,
        owner: &DictationOwner,
        identifier: &str,
    ) -> Result<String, DictationFailure> {
        enum Taken {
            Capture(Capture, Model),
            Samples(Arc<Vec<f32>>, Model),
        }
        let (id, taken) = {
            let mut slot = self.slot();
            if slot.owner() != Some(owner) {
                return Err(if slot.owner().is_some() {
                    DictationFailure::Busy
                } else {
                    DictationFailure::Cancelled
                });
            }
            match std::mem::take(&mut *slot) {
                Slot::Recording {
                    id, capture, model, ..
                } => {
                    *slot = Slot::Recognizing {
                        owner: owner.clone(),
                        id,
                        reloaded: false,
                    };
                    (id, Taken::Capture(capture, model))
                }
                Slot::Recorded {
                    id, samples, model, ..
                } => {
                    *slot = Slot::Recognizing {
                        owner: owner.clone(),
                        id,
                        reloaded: false,
                    };
                    (id, Taken::Samples(samples, model))
                }
                other => {
                    // Still opening, or already recognizing.
                    *slot = other;
                    return Err(DictationFailure::Busy);
                }
            }
        };
        let (samples, model) = match taken {
            Taken::Samples(samples, model) => (samples, model),
            Taken::Capture(capture, model) => match recorded(capture, identifier).await {
                Ok(samples) => (Arc::new(samples), model),
                Err(failure) => {
                    let mut slot = self.slot();
                    if slot.id() == Some(id) {
                        *slot = Slot::Idle;
                    }
                    return Err(failure);
                }
            },
        };
        self.recognize(owner, id, samples, model).await
    }

    /// Recognizes `samples`; the text ends the dictation, a failure keeps
    /// the audio for a retry unless it was cancelled meanwhile. After a
    /// reload of the owner's webview the text waits for its new document
    /// and a failure drops the audio; the caller gets `Cancelled`.
    async fn recognize(
        &self,
        owner: &DictationOwner,
        id: u64,
        samples: Arc<Vec<f32>>,
        model: Model,
    ) -> Result<String, DictationFailure> {
        let result = self
            .recognizer()
            .transcribe(&model.path, &samples, model.language.as_deref())
            .await;
        let mut slot = self.slot();
        let reloaded = match &*slot {
            Slot::Recognizing {
                id: current,
                reloaded,
                ..
            } if *current == id => *reloaded,
            _ => return Err(DictationFailure::Cancelled),
        };
        match result {
            Ok(transcription) => {
                tracing::info!(model = %model.id, backend = ?transcription.backend, reloaded, "dictation recognized");
                *slot = Slot::Idle;
                if !reloaded {
                    return Ok(transcription.text);
                }
                self.dictated()
                    .entry(owner.webview.clone())
                    .or_default()
                    .push(DictatedText {
                        key: owner.key.clone(),
                        text: transcription.text,
                    });
                Err(DictationFailure::Cancelled)
            }
            Err(error) => {
                let failure = recognition_failure(&error);
                tracing::warn!(model = %model.id, failure = ?failure, reloaded, "dictation recognition failed");
                *slot = if failure == DictationFailure::Recognition && !reloaded {
                    Slot::Recorded {
                        owner: owner.clone(),
                        id,
                        samples,
                        model,
                    }
                } else {
                    Slot::Idle
                };
                Err(if reloaded {
                    DictationFailure::Cancelled
                } else {
                    failure
                })
            }
        }
    }

    /// Cancels what `owner` records, recognizes or holds; its audio is
    /// dropped. A recognition in progress stops with the speech process.
    pub async fn cancel_dictation(&self, owner: &DictationOwner) {
        self.cancel_where(|holder| holder == owner).await;
    }

    /// The owner's webview reloads (R1 DF-175): its drafts survive, so a
    /// recording stops as ■ and Desktop recognizes it, and a recognition in
    /// progress goes on, both for the new document; opening the microphone
    /// is cancelled and the audio of a failed recognition dropped, as
    /// nobody can retry it.
    pub async fn reload_dictation(&self, webview: &str, identifier: &str) {
        let recording = {
            let mut slot = self.slot();
            if slot.owner().is_none_or(|owner| owner.webview != webview) {
                return;
            }
            match std::mem::take(&mut *slot) {
                Slot::Recording {
                    owner,
                    id,
                    capture,
                    model,
                } => {
                    *slot = Slot::Recognizing {
                        owner: owner.clone(),
                        id,
                        reloaded: true,
                    };
                    Some((owner, id, capture, model))
                }
                Slot::Recognizing { owner, id, .. } => {
                    *slot = Slot::Recognizing {
                        owner,
                        id,
                        reloaded: true,
                    };
                    None
                }
                Slot::Opening { .. } | Slot::Recorded { .. } | Slot::Idle => None,
            }
        };
        let Some((owner, id, capture, model)) = recording else {
            return;
        };
        match recorded(capture, identifier).await {
            Ok(samples) => {
                let _ = self.recognize(&owner, id, Arc::new(samples), model).await;
            }
            Err(_) => {
                let mut slot = self.slot();
                if slot.id() == Some(id) {
                    *slot = Slot::Idle;
                }
            }
        }
    }

    /// Takes the text recognized after `webview` reloaded; each text is
    /// taken once.
    pub fn take_dictated(&self, webview: &str) -> Vec<DictatedText> {
        self.dictated().remove(webview).unwrap_or_default()
    }

    pub fn has_dictated(&self, webview: &str) -> bool {
        self.dictated().contains_key(webview)
    }

    /// Cancels the dictation of a webview that closes and drops its text
    /// not taken yet: its composers and their drafts are gone (R5 DF-175).
    pub async fn release_dictation(&self, webview: &str) {
        self.cancel_where(|holder| holder.webview == webview).await;
        // After the cancel, so a recognition ending meanwhile adds nothing.
        self.dictated().remove(webview);
    }

    async fn cancel_where(&self, matches: impl Fn(&DictationOwner) -> bool) {
        let previous = {
            let mut slot = self.slot();
            if !slot.owner().is_some_and(&matches) {
                return;
            }
            std::mem::take(&mut *slot)
        };
        match previous {
            Slot::Recording { capture, .. } => {
                let _ = tauri::async_runtime::spawn_blocking(move || drop(capture.finish())).await;
            }
            Slot::Recognizing { .. } => self.recognizer().shutdown().await,
            _ => {}
        }
    }
}

/// Stops `capture` and returns its audio when it can be recognized.
async fn recorded(capture: Capture, identifier: &str) -> Result<Vec<f32>, DictationFailure> {
    let recording = tauri::async_runtime::spawn_blocking(move || capture.finish())
        .await
        .map_err(|_| DictationFailure::Device)?;
    tracing::info!(
        os = std::env::consts::OS,
        duration_ms = recording.duration().as_millis() as u64,
        signal = recording.has_signal,
        "dictation recorded"
    );
    match recording.failed {
        Some(failure) if recording.samples.is_empty() => Err(capture_failure(failure, identifier)),
        _ if !recording.has_signal => Err(DictationFailure::NoSignal {
            sound_settings: settings_url(std::env::consts::OS, SettingsTarget::SoundInput)
                .is_some(),
        }),
        _ => Ok(recording.samples),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::capture::Recording;
    use svode_speech::client::RecognizerConfig;

    const IDENTIFIER: &str = "app.svode.desktop";

    /// A speech process that loads any model and answers a transcription
    /// once the `gate` file exists: with the `text` file's text, or a
    /// failure without one.
    #[cfg(unix)]
    const FAKE_SPEECH: &str = r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"load"'*) echo '{"type":"loaded","backend":"cpu"}' ;;
    *'"type":"transcribe"'*)
      while [ ! -e "$FAKE_DIR/gate" ]; do sleep 0.02; done
      if [ -e "$FAKE_DIR/text" ]; then
        printf '{"type":"transcript","text":"%s"}\n' "$(cat "$FAKE_DIR/text")"
      else
        echo '{"type":"failed","error":"engine"}'
      fi ;;
  esac
done
"#;

    struct Fixture {
        state: SpeechState,
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let program = dir.path().join("svode-speech");
            #[cfg(unix)]
            svode_testkit::write_executable(&program, FAKE_SPEECH).unwrap();
            let mut config =
                RecognizerConfig::new(program, dir.path().join("speech/engine.json"), "test");
            config
                .env
                .push(("FAKE_DIR".into(), dir.path().display().to_string()));
            let state = SpeechState::with(config, dir.path().join("speech"));
            Self { state, dir }
        }

        fn model(&self) -> Model {
            Model {
                id: "fake".to_string(),
                path: self.dir.path().join("model.gguf"),
                language: None,
            }
        }

        #[cfg(unix)]
        /// Lets the speech process answer, with `text` or a failure.
        fn answer(&self, text: Option<&str>) {
            if let Some(text) = text {
                std::fs::write(self.dir.path().join("text"), text).unwrap();
            }
            std::fs::write(self.dir.path().join("gate"), "").unwrap();
        }

        fn record(&self, owner: &DictationOwner, has_signal: bool) {
            *self.state.slot() = Slot::Recording {
                owner: owner.clone(),
                id: self.state.next_dictation_id(),
                capture: Capture::recorded(Recording {
                    samples: vec![0.25; 1600],
                    has_signal,
                    failed: None,
                }),
                model: self.model(),
            };
        }

        fn hold_failed(&self, owner: &DictationOwner) {
            *self.state.slot() = Slot::Recorded {
                owner: owner.clone(),
                id: self.state.next_dictation_id(),
                samples: Arc::new(vec![0.25; 1600]),
                model: self.model(),
            };
        }

        #[cfg(unix)]
        async fn until_recognizing(&self) {
            for _ in 0..500 {
                if matches!(*self.state.slot(), Slot::Recognizing { .. }) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("the recognition did not start");
        }
    }

    fn owner(webview: &str) -> DictationOwner {
        DictationOwner {
            webview: webview.to_string(),
            key: "session:codex:s1".to_string(),
        }
    }

    #[cfg(unix)]
    fn dictated(text: &str) -> Vec<DictatedText> {
        vec![DictatedText {
            key: "session:codex:s1".to_string(),
            text: text.to_string(),
        }]
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_reload_while_recording_recognizes_it_for_the_new_document_once() {
        let fixture = Fixture::new();
        fixture.record(&owner("main"), true);
        fixture.answer(Some("fix the import"));

        fixture.state.reload_dictation("main", IDENTIFIER).await;

        assert_eq!(fixture.state.dictation_owner(), None);
        assert!(fixture.state.has_dictated("main"));
        // A second reload before delivery keeps the text.
        fixture.state.reload_dictation("main", IDENTIFIER).await;
        assert!(fixture.state.take_dictated("other").is_empty());
        assert_eq!(
            fixture.state.take_dictated("main"),
            dictated("fix the import")
        );
        assert!(fixture.state.take_dictated("main").is_empty());
        fixture.state.shutdown().await;
    }

    #[tokio::test]
    async fn a_reload_drops_a_recording_without_signal_unrecognized() {
        let fixture = Fixture::new();
        fixture.record(&owner("main"), false);

        fixture.state.reload_dictation("main", IDENTIFIER).await;

        assert_eq!(fixture.state.dictation_owner(), None);
        assert!(!fixture.state.has_dictated("main"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_recognition_in_progress_is_finished_for_the_new_document() {
        let fixture = Fixture::new();
        let main = owner("main");
        fixture.hold_failed(&main);
        let state = fixture.state.clone();
        let retry = {
            let main = main.clone();
            tokio::spawn(async move { state.finish_dictation(&main, IDENTIFIER).await })
        };
        fixture.until_recognizing().await;

        fixture.state.reload_dictation("main", IDENTIFIER).await;

        // The slot stays with Desktop until the text is ready (R3).
        assert_eq!(fixture.state.dictation_owner(), Some(main));
        fixture.answer(Some("and the tests"));
        // The old document gets nothing: the text is for the new one.
        assert_eq!(retry.await.unwrap(), Err(DictationFailure::Cancelled));
        assert_eq!(fixture.state.dictation_owner(), None);
        assert_eq!(
            fixture.state.take_dictated("main"),
            dictated("and the tests")
        );
        fixture.state.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_recognition_after_a_reload_drops_the_audio() {
        let fixture = Fixture::new();
        fixture.record(&owner("main"), true);
        fixture.answer(None);

        fixture.state.reload_dictation("main", IDENTIFIER).await;

        assert!(matches!(*fixture.state.slot(), Slot::Idle));
        assert!(!fixture.state.has_dictated("main"));
        fixture.state.shutdown().await;
    }

    #[tokio::test]
    async fn a_reload_drops_the_audio_of_a_failed_recognition_and_cancels_opening() {
        let fixture = Fixture::new();
        fixture.hold_failed(&owner("main"));
        fixture.state.reload_dictation("main", IDENTIFIER).await;
        assert!(matches!(*fixture.state.slot(), Slot::Idle));

        *fixture.state.slot() = Slot::Opening {
            owner: owner("main"),
            id: fixture.state.next_dictation_id(),
        };
        fixture.state.reload_dictation("main", IDENTIFIER).await;
        assert!(matches!(*fixture.state.slot(), Slot::Idle));
        assert!(!fixture.state.has_dictated("main"));
    }

    #[tokio::test]
    async fn a_reload_of_another_webview_keeps_the_dictation() {
        let fixture = Fixture::new();
        fixture.record(&owner("main"), true);

        fixture.state.reload_dictation("other", IDENTIFIER).await;

        assert!(matches!(*fixture.state.slot(), Slot::Recording { .. }));
        fixture.state.cancel_dictation(&owner("main")).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closing_the_window_cancels_the_dictation_and_drops_the_text_not_taken() {
        let fixture = Fixture::new();
        fixture.record(&owner("main"), true);
        fixture.answer(Some("fix the import"));
        fixture.state.reload_dictation("main", IDENTIFIER).await;
        assert!(fixture.state.has_dictated("main"));

        fixture.state.release_dictation("main").await;
        assert!(fixture.state.take_dictated("main").is_empty());

        // A recognition finishing for a reloaded window that then closes.
        std::fs::remove_file(fixture.dir.path().join("gate")).unwrap();
        let main = owner("main");
        fixture.hold_failed(&main);
        let state = fixture.state.clone();
        let retry = {
            let main = main.clone();
            tokio::spawn(async move { state.finish_dictation(&main, IDENTIFIER).await })
        };
        fixture.until_recognizing().await;
        fixture.state.reload_dictation("main", IDENTIFIER).await;
        fixture.state.release_dictation("main").await;

        assert_eq!(retry.await.unwrap(), Err(DictationFailure::Cancelled));
        assert_eq!(fixture.state.dictation_owner(), None);
        assert!(!fixture.state.has_dictated("main"));
        fixture.state.shutdown().await;
    }

    #[test]
    fn a_denial_offers_the_recovery_of_each_os() {
        assert_eq!(
            denied_recovery("macos", "app.svode.desktop"),
            DeniedRecovery::ResetCommand {
                command: "tccutil reset Microphone app.svode.desktop".to_string()
            }
        );
        assert_eq!(
            denied_recovery("windows", "app.svode.desktop"),
            DeniedRecovery::OpenSettings
        );
        assert_eq!(
            denied_recovery("linux", "app.svode.desktop"),
            DeniedRecovery::None
        );
        assert_eq!(
            settings_url("windows", SettingsTarget::MicrophonePrivacy),
            Some("ms-settings:privacy-microphone")
        );
    }

    #[test]
    fn sound_settings_open_where_the_os_has_a_page() {
        assert!(settings_url("macos", SettingsTarget::SoundInput).is_some());
        assert_eq!(
            settings_url("windows", SettingsTarget::SoundInput),
            Some("ms-settings:sound")
        );
        assert_eq!(settings_url("linux", SettingsTarget::SoundInput), None);
        // macOS lifts a denial by the reset command, not a settings page.
        assert_eq!(
            settings_url("macos", SettingsTarget::MicrophonePrivacy),
            None
        );
    }

    #[test]
    fn a_failed_recognition_is_retried_unless_the_model_is_gone_or_it_was_cancelled() {
        assert_eq!(
            recognition_failure(&RecognizerError::Crashed),
            DictationFailure::Recognition
        );
        assert_eq!(
            recognition_failure(&RecognizerError::TimedOut {
                limit: std::time::Duration::from_secs(60)
            }),
            DictationFailure::Recognition
        );
        assert_eq!(
            recognition_failure(&RecognizerError::Engine(ErrorCode::ModelMissing)),
            DictationFailure::ModelMissing
        );
        assert_eq!(
            recognition_failure(&RecognizerError::Stopped),
            DictationFailure::Cancelled
        );
    }

    #[test]
    fn failures_serialize_with_their_recovery() {
        let denied = serde_json::to_value(DictationFailure::Denied {
            recovery: DeniedRecovery::OpenSettings,
        })
        .unwrap();
        assert_eq!(
            denied,
            serde_json::json!({ "code": "denied", "recovery": { "kind": "openSettings" } })
        );
        let silent = serde_json::to_value(DictationFailure::NoSignal {
            sound_settings: true,
        })
        .unwrap();
        assert_eq!(
            silent,
            serde_json::json!({ "code": "noSignal", "soundSettings": true })
        );
    }
}
