//! Thin commands over the speech models and dictation. Reading the list
//! starts no download; install, update and removal are explicit actions.

use std::sync::Arc;

use serde::Serialize;
use svode_speech::catalog::{CatalogModel, License, Mark, catalog};
use svode_speech::models::{Installation, InstalledModel, Measurement, ModelStore};
use svode_speech::preparation::{Recommendation, recommend};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tauri_plugin_opener::OpenerExt;

use super::dictation::{
    DICTATION_CHANGED_EVENT, DictationFailure, DictationOwner, SettingsTarget, settings_url,
};
use super::{
    JobEvents, JobStage, MODEL_PROGRESS_EVENT, MODELS_CHANGED_EVENT, ModelProgress, SpeechState,
};
use crate::error::AppError;

struct TauriEvents(AppHandle);

impl JobEvents for TauriEvents {
    fn changed(&self) {
        let _ = self.0.emit(MODELS_CHANGED_EVENT, ());
    }

    fn progress(&self, progress: ModelProgress) {
        let _ = self.0.emit(MODEL_PROGRESS_EVENT, progress);
    }
}

pub fn events(app: &AppHandle) -> Arc<dyn JobEvents> {
    Arc::new(TauriEvents(app.clone()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModels {
    /// The catalog of this release, in its order.
    pub models: Vec<ModelView>,
    /// Installed models the release dropped: they can only be removed.
    pub unsupported: Vec<InstalledModel>,
    /// The active model, when it is installed and supported.
    pub active_model: Option<String>,
    pub recommendation: RecommendationView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    #[serde(flatten)]
    pub model: &'static CatalogModel,
    pub installation: Option<Installation>,
    pub installed_size: Option<u64>,
    /// The last measurement, while it is current (V7).
    pub measurement: Option<Measurement>,
    pub job: Option<JobStage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationView {
    /// The model recommended for this device.
    pub model_id: String,
    #[serde(flatten)]
    pub recommendation: Recommendation,
}

pub async fn models(state: &SpeechState) -> SpeechModels {
    let store = state.store();
    let recognizer = state.recognizer();
    let version = recognizer.build_version();
    let refused = recognizer.acceleration_refused();
    let catalog = catalog();
    let settings = store.settings();
    let installed = store.installed();
    let current = |id: &str| {
        settings
            .measurements
            .get(id)
            .filter(|measurement| measurement.is_current(version, refused))
            .cloned()
    };
    let models = catalog
        .models
        .iter()
        .map(|model| {
            let installed = installed.iter().find(|installed| installed.id == model.id);
            ModelView {
                model,
                installation: installed
                    .map(|installed| ModelStore::installation(installed, catalog)),
                installed_size: installed.map(|installed| installed.size),
                measurement: current(&model.id),
                job: state.job(&model.id),
            }
        })
        .collect();
    let accurate = catalog.marked(Mark::Accurate);
    let gpu = if refused { None } else { state.gpu().await };
    let recommendation = recommend(gpu, refused, current(&accurate.id).as_ref(), version);
    SpeechModels {
        models,
        unsupported: installed
            .iter()
            .filter(|installed| catalog.get(&installed.id).is_none())
            .cloned()
            .collect(),
        active_model: store.active(catalog).map(|model| model.id),
        recommendation: RecommendationView {
            model_id: catalog.marked(recommendation.model).id.clone(),
            recommendation,
        },
    }
}

#[tauri::command]
pub async fn speech_models(state: State<'_, SpeechState>) -> Result<SpeechModels, AppError> {
    Ok(models(&state).await)
}

/// Downloads, installs and prepares a model; progress and the outcome come
/// as events.
#[tauri::command]
pub async fn speech_model_install(
    app: AppHandle,
    state: State<'_, SpeechState>,
    id: String,
) -> Result<(), AppError> {
    state.start_install(&id, events(&app))
}

#[tauri::command]
pub async fn speech_model_cancel(
    state: State<'_, SpeechState>,
    id: String,
) -> Result<(), AppError> {
    state.cancel(&id);
    Ok(())
}

#[tauri::command]
pub async fn speech_model_prepare(
    app: AppHandle,
    state: State<'_, SpeechState>,
    id: String,
) -> Result<(), AppError> {
    state.start_preparation(&id, events(&app))
}

#[tauri::command]
pub async fn speech_model_activate(
    app: AppHandle,
    state: State<'_, SpeechState>,
    id: String,
) -> Result<(), AppError> {
    state.store().activate(&id, catalog())?;
    let _ = app.emit(MODELS_CHANGED_EVENT, ());
    Ok(())
}

#[tauri::command]
pub async fn speech_model_delete(
    app: AppHandle,
    state: State<'_, SpeechState>,
    id: String,
) -> Result<(), AppError> {
    state.delete(&id).await?;
    let _ = app.emit(MODELS_CHANGED_EVENT, ());
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLicense {
    pub id: &'static str,
    pub name: &'static str,
    pub license: &'static License,
    /// The model the GGUF is converted from.
    pub upstream: &'static str,
    /// The repository the file is downloaded from.
    pub repo: &'static str,
}

/// License and attribution of every catalog model, for About.
#[tauri::command]
pub fn speech_model_licenses() -> Vec<ModelLicense> {
    catalog()
        .models
        .iter()
        .map(|model| ModelLicense {
            id: &model.id,
            name: &model.name,
            license: &model.license,
            upstream: &model.upstream,
            repo: &model.source.repo,
        })
        .collect()
}

/// Tells every window which composer records, so the others disable
/// their microphone.
fn notify_dictation(app: &AppHandle, state: &SpeechState) {
    let _ = app.emit(DICTATION_CHANGED_EVENT, state.dictation_owner());
}

/// Cancels the dictation of a webview that reloads or closes.
pub fn release_webview(app: &AppHandle, webview: &str) {
    let Some(state) = app.try_state::<SpeechState>() else {
        return;
    };
    let state = state.inner().clone();
    if state
        .dictation_owner()
        .is_none_or(|owner| owner.webview != webview)
    {
        return;
    }
    let app = app.clone();
    let webview = webview.to_string();
    tauri::async_runtime::spawn(async move {
        state.release_dictation(&webview).await;
        notify_dictation(&app, &state);
    });
}

#[tauri::command]
pub fn speech_dictation_owner(state: State<'_, SpeechState>) -> Option<DictationOwner> {
    state.dictation_owner()
}

/// Starts recording for composer `key`; `levels` gets the dBFS of each
/// 50 ms window. Returns why it did not start, or nothing.
#[tauri::command]
pub async fn speech_dictation_start(
    app: AppHandle,
    webview: Webview,
    state: State<'_, SpeechState>,
    key: String,
    levels: Channel<f32>,
) -> Result<Option<DictationFailure>, AppError> {
    let owner = DictationOwner {
        webview: webview.label().to_string(),
        key,
    };
    let started = state
        .start_dictation(owner, &app.config().identifier, move |level| {
            let _ = levels.send(level);
        })
        .await;
    notify_dictation(&app, &state);
    Ok(started.err())
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum DictationResult {
    Text { text: String },
    Failed { failure: DictationFailure },
}

/// Stops the recording of composer `key` and recognizes it, or recognizes
/// its failed recording again.
#[tauri::command]
pub async fn speech_dictation_finish(
    app: AppHandle,
    webview: Webview,
    state: State<'_, SpeechState>,
    key: String,
) -> Result<DictationResult, AppError> {
    let owner = DictationOwner {
        webview: webview.label().to_string(),
        key,
    };
    let result = match state
        .finish_dictation(&owner, &app.config().identifier)
        .await
    {
        Ok(text) => DictationResult::Text { text },
        Err(failure) => DictationResult::Failed { failure },
    };
    notify_dictation(&app, &state);
    Ok(result)
}

#[tauri::command]
pub async fn speech_dictation_cancel(
    app: AppHandle,
    webview: Webview,
    state: State<'_, SpeechState>,
    key: String,
) -> Result<(), AppError> {
    let owner = DictationOwner {
        webview: webview.label().to_string(),
        key,
    };
    state.cancel_dictation(&owner).await;
    notify_dictation(&app, &state);
    Ok(())
}

/// Opens the system settings page of `target` where the OS has one.
#[tauri::command]
pub fn speech_open_system_settings(app: AppHandle, target: SettingsTarget) -> Result<(), AppError> {
    let url = settings_url(std::env::consts::OS, target)
        .ok_or_else(|| AppError::General("no system settings page".to_string()))?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::General(error.to_string()))
}
