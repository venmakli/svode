//! Speech recognition for dictation (Stage 10 `06`): the app's one speech
//! process, driven through `svode_speech::client`, and the models of the
//! release catalog the user installs, updates and removes. The process is a
//! sidecar next to the app binary; models and their device-local state live
//! in the app data directory.
//!
//! Installing a model is a background job: download with progress and
//! cancel, the integrity check of the store, then "Подготовка модели" (warm
//! up and measure, V7). The jobs live in memory; the frontend reads them
//! with the model list and follows [`MODELS_CHANGED_EVENT`] and
//! [`MODEL_PROGRESS_EVENT`].
//!
//! Dictation ([`dictation`]) records the default microphone natively
//! ([`capture`]) and recognizes the recording with the active model; the
//! app has one recording at a time.

mod capture;
pub mod commands;
pub mod dictation;
mod download;
mod microphone;
mod signal;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use svode_speech::catalog::{Mark, catalog};
use svode_speech::client::{Recognizer, RecognizerConfig};
use svode_speech::models::{InstalledModel, ModelStore};
use svode_speech::preparation;
use svode_speech::protocol::Backend;
use tokio::sync::{OnceCell, watch};

use download::DownloadError;

/// The model list changed: an install, update, preparation or removal
/// started, finished or failed, or the active model changed.
pub const MODELS_CHANGED_EVENT: &str = "speech-models-changed";
/// Download progress of one model, at most a few times a second.
pub const MODEL_PROGRESS_EVENT: &str = "speech-model-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub id: String,
    pub received: u64,
    pub total: u64,
}

/// What a running or failed job of a model is doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum JobStage {
    Downloading {
        received: u64,
        total: u64,
    },
    Preparing,
    /// Stays until the user retries or removes the model.
    Failed {
        failure: JobFailure,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobFailure {
    /// The download did not complete.
    Network,
    /// The file did not match the catalog.
    Integrity,
    /// The model could not be written.
    Disk,
    /// The model was installed but did not load or recognize.
    Preparation,
}

/// How a job reports to the frontend; Desktop emits Tauri events.
pub trait JobEvents: Send + Sync + 'static {
    fn changed(&self);
    fn progress(&self, progress: ModelProgress);
}

struct Job {
    stage: JobStage,
    cancel: Option<watch::Sender<bool>>,
}

#[derive(Clone)]
pub struct SpeechState(Arc<Speech>);

struct Speech {
    recognizer: Recognizer,
    store: ModelStore,
    http: reqwest::Client,
    gpu: OnceCell<Option<Backend>>,
    jobs: Mutex<HashMap<String, Job>>,
    dictation: Mutex<dictation::Slot>,
    dictation_ids: AtomicU64,
}

impl SpeechState {
    pub fn new(data_dir: &Path, version: &str) -> Self {
        let speech_dir = data_dir.join("speech");
        Self::with(
            RecognizerConfig::new(sidecar_path(), speech_dir.join("engine.json"), version),
            speech_dir,
        )
    }

    fn with(config: RecognizerConfig, speech_dir: PathBuf) -> Self {
        Self(Arc::new(Speech {
            recognizer: Recognizer::new(config),
            store: ModelStore::open(speech_dir),
            http: download::client(),
            gpu: OnceCell::new(),
            jobs: Mutex::default(),
            dictation: Mutex::default(),
            dictation_ids: AtomicU64::new(0),
        }))
    }

    pub async fn shutdown(&self) {
        self.0.recognizer.shutdown().await;
    }

    pub fn recognizer(&self) -> &Recognizer {
        &self.0.recognizer
    }

    pub fn store(&self) -> &ModelStore {
        &self.0.store
    }

    /// The GPU the engine finds on this device, asked once per run.
    pub async fn gpu(&self) -> Option<Backend> {
        *self
            .0
            .gpu
            .get_or_init(|| async {
                self.0.recognizer.probe().await.unwrap_or_else(|error| {
                    tracing::warn!("speech acceleration probe failed: {error}");
                    None
                })
            })
            .await
    }

    pub fn job(&self, id: &str) -> Option<JobStage> {
        self.jobs().get(id).map(|job| job.stage.clone())
    }

    /// Downloads, installs and prepares model `id` of the catalog. A model
    /// with a running job keeps it: a second request does not start a
    /// second download.
    pub fn start_install(
        &self,
        id: &str,
        events: Arc<dyn JobEvents>,
    ) -> Result<(), crate::error::AppError> {
        let model = catalog()
            .get(id)
            .ok_or_else(|| svode_speech::models::ModelError::UnknownModel(id.to_string()))?;
        let (cancel, mut cancelled) = watch::channel(false);
        {
            let mut jobs = self.jobs();
            if jobs
                .get(id)
                .is_some_and(|job| !matches!(job.stage, JobStage::Failed { .. }))
            {
                return Ok(());
            }
            jobs.insert(
                id.to_string(),
                Job {
                    stage: JobStage::Downloading {
                        received: 0,
                        total: model.size,
                    },
                    cancel: Some(cancel),
                },
            );
        }
        events.changed();
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let speech = &state.0;
            let downloaded = download::install(
                &speech.http,
                &speech.store,
                &speech.recognizer,
                model,
                &model.url(),
                &mut cancelled,
                |received| {
                    state.set_stage(
                        &model.id,
                        JobStage::Downloading {
                            received,
                            total: model.size,
                        },
                    );
                    events.progress(ModelProgress {
                        id: model.id.clone(),
                        received,
                        total: model.size,
                    });
                },
            )
            .await;
            match downloaded {
                Ok(installed) => state.prepare(installed, events.as_ref()).await,
                Err(DownloadError::Cancelled) => {
                    state.jobs().remove(&model.id);
                    events.changed();
                }
                Err(error) => {
                    tracing::warn!(model = %model.id, "speech model download failed: {error}");
                    state.fail(&model.id, error.failure(), events.as_ref());
                }
            }
        });
        Ok(())
    }

    /// Cancels the download of model `id`; the store keeps its previous
    /// state.
    pub fn cancel(&self, id: &str) {
        if let Some(cancel) = self.jobs().get(id).and_then(|job| job.cancel.as_ref()) {
            let _ = cancel.send(true);
        }
    }

    /// Prepares installed model `id` again, after a failed preparation.
    pub fn start_preparation(
        &self,
        id: &str,
        events: Arc<dyn JobEvents>,
    ) -> Result<(), crate::error::AppError> {
        let installed = self
            .0
            .store
            .installed()
            .into_iter()
            .find(|model| model.id == id)
            .ok_or_else(|| svode_speech::models::ModelError::NotInstalled(id.to_string()))?;
        if self
            .job(id)
            .is_some_and(|stage| !matches!(stage, JobStage::Failed { .. }))
        {
            return Ok(());
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move { state.prepare(installed, events.as_ref()).await });
        Ok(())
    }

    /// Removes model `id`, stopping the process if it holds the file.
    pub async fn delete(&self, id: &str) -> Result<(), crate::error::AppError> {
        if self
            .job(id)
            .is_some_and(|stage| !matches!(stage, JobStage::Failed { .. }))
        {
            return Err(svode_speech::models::ModelError::Busy(id.to_string()).into());
        }
        self.0.recognizer.release(&self.0.store.model_dir(id)).await;
        self.0.store.delete(id)?;
        self.jobs().remove(id);
        Ok(())
    }

    /// Measures again, in the background, the active model and the accurate
    /// one when their measurement predates a Svode update or was made on a
    /// GPU the device has since refused (V7).
    pub fn refresh_measurements(&self, events: Arc<dyn JobEvents>) {
        let speech = &self.0;
        let settings = speech.store.settings();
        let version = speech.recognizer.build_version().to_string();
        let refused = speech.recognizer.acceleration_refused();
        let accurate = catalog().marked(Mark::Accurate).id.clone();
        let mut ids: Vec<String> = settings.active_model.into_iter().collect();
        if !ids.contains(&accurate) {
            ids.push(accurate);
        }
        let stale: Vec<InstalledModel> = speech
            .store
            .installed()
            .into_iter()
            .filter(|model| ids.contains(&model.id) && catalog().get(&model.id).is_some())
            .filter(|model| {
                settings
                    .measurements
                    .get(&model.id)
                    .is_some_and(|measurement| !measurement.is_current(&version, refused))
            })
            .filter(|model| self.job(&model.id).is_none())
            .collect();
        if stale.is_empty() {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            for model in stale {
                state.prepare(model, events.as_ref()).await;
            }
        });
    }

    async fn prepare(&self, installed: InstalledModel, events: &dyn JobEvents) {
        let id = installed.id.clone();
        let Some(model) = catalog().get(&id) else {
            self.jobs().remove(&id);
            return;
        };
        self.jobs().insert(
            id.clone(),
            Job {
                stage: JobStage::Preparing,
                cancel: None,
            },
        );
        events.changed();
        let path = self.0.store.model_path(&installed);
        match preparation::prepare(&self.0.recognizer, model, &path).await {
            Ok(measurement) => {
                if let Err(error) = self.0.store.record_measurement(&id, measurement) {
                    tracing::warn!(model = %id, "failed to record the speech model measurement: {error}");
                }
                self.jobs().remove(&id);
                events.changed();
            }
            Err(error) => {
                tracing::warn!(model = %id, "speech model preparation failed: {error}");
                self.fail(&id, JobFailure::Preparation, events);
            }
        }
    }

    fn fail(&self, id: &str, failure: JobFailure, events: &dyn JobEvents) {
        self.jobs().insert(
            id.to_string(),
            Job {
                stage: JobStage::Failed { failure },
                cancel: None,
            },
        );
        events.changed();
    }

    fn set_stage(&self, id: &str, stage: JobStage) {
        if let Some(job) = self.jobs().get_mut(id) {
            job.stage = stage;
        }
    }

    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Job>> {
        self.0.jobs.lock().expect("speech jobs lock")
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, dictation::Slot> {
        self.0.dictation.lock().expect("dictation lock")
    }

    fn next_dictation_id(&self) -> u64 {
        self.0.dictation_ids.fetch_add(1, Ordering::SeqCst) + 1
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

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    struct Log;

    impl JobEvents for Log {
        fn changed(&self) {}

        fn progress(&self, _progress: ModelProgress) {}
    }

    /// Live acceptance on macOS (slice 7.2): downloads the recommended
    /// models of the catalog from Hugging Face into a temporary directory,
    /// installs, warms up and measures them with the speech process at
    /// `SVODE_SPEECH_BIN` (a release build), and prints the recommendation.
    ///
    /// `SVODE_SPEECH_BIN=target/release/svode-speech cargo test -p svode-desktop speech::tests::live_ -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "downloads about 1.6 GB"]
    async fn live_downloads_prepares_and_measures_the_recommended_models() {
        let program = PathBuf::from(std::env::var("SVODE_SPEECH_BIN").expect("SVODE_SPEECH_BIN"));
        let dir = tempfile::tempdir().unwrap();
        let state = SpeechState::with(
            RecognizerConfig::new(program, dir.path().join("speech/engine.json"), "live"),
            dir.path().join("speech"),
        );
        eprintln!("gpu: {:?}", state.gpu().await);
        let before = commands::models(&state).await.recommendation;
        eprintln!("before the measurement: {before:?}");

        for mark in [Mark::Accurate, Mark::Fast] {
            let id = &catalog().marked(mark).id;
            let started = Instant::now();
            state.start_install(id, Arc::new(Log)).unwrap();
            let mut prepared_from = None;
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                match state.job(id) {
                    Some(JobStage::Downloading { .. }) => {}
                    Some(JobStage::Preparing) => {
                        prepared_from.get_or_insert_with(Instant::now);
                    }
                    Some(JobStage::Failed { failure }) => panic!("{id}: {failure:?}"),
                    None => break,
                }
            }
            let measurement = state.store().settings().measurements[id.as_str()].clone();
            eprintln!(
                "{id}: downloaded in {:?}, prepared in {:?}, reference recognized in {:.2} s on {:?}",
                prepared_from.unwrap_or_else(Instant::now) - started,
                prepared_from.map(|from| from.elapsed()),
                measurement.seconds,
                measurement.backend,
            );
        }

        let after = commands::models(&state).await;
        eprintln!("after the measurement: {:?}", after.recommendation);
        // Each new install became the active model, the last one stays
        // active: measuring did not change it.
        assert_eq!(
            after.active_model.as_deref(),
            Some(catalog().marked(Mark::Fast).id.as_str())
        );
        state.shutdown().await;
    }
}
