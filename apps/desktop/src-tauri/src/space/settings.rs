use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};

use crate::error::AppError;

use super::types::{AppPreferences, AppSettings};

const SUPPORTED_THEMES: [&str; 3] = ["system", "light", "dark"];
const SUPPORTED_LOCALES: [&str; 2] = ["en", "ru"];

#[derive(Debug, PartialEq, Eq)]
pub struct PreferenceMutation {
    pub value: String,
    pub changed: bool,
}

/// A queued preference write, which hands its result over itself.
type PreferenceWrite = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct AppSettingsState {
    /// Serializes Variables operations, which hold it around their Keychain
    /// calls (`run_locked`); the preference commands never take it
    /// (DF-365 R2).
    operation_lock: Arc<Mutex<()>>,
    /// The queue of the settings executor, started with the first write.
    preference_writes: Mutex<Option<mpsc::Sender<PreferenceWrite>>>,
}

impl AppSettingsState {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn operation_lock(&self) -> Arc<Mutex<()>> {
        Arc::clone(&self.operation_lock)
    }

    /// Queues the locale write behind the earlier preference writes and
    /// returns at once; the future gives its result.
    pub fn set_app_locale(
        &self,
        config_dir: PathBuf,
        locale: String,
    ) -> Result<impl Future<Output = Result<PreferenceMutation, AppError>> + Send + use<>, AppError>
    {
        self.queue_preference_write(move || set_app_locale(&config_dir, &locale))
    }

    /// Queues the theme write behind the earlier preference writes and
    /// returns at once; the future gives its result.
    pub fn set_app_theme(
        &self,
        config_dir: PathBuf,
        theme: String,
    ) -> Result<impl Future<Output = Result<PreferenceMutation, AppError>> + Send + use<>, AppError>
    {
        self.queue_preference_write(move || set_app_theme(&config_dir, &theme))
    }

    /// Theme and locale writes run one at a time in queue order on the
    /// settings executor, its own thread: the settings lock they take may be
    /// held by a Variables operation across a Keychain prompt, so neither the
    /// main thread nor a tokio worker waits for it (DF-365 R2). The future
    /// waits for the result without holding a thread.
    fn queue_preference_write<W>(
        &self,
        write: W,
    ) -> Result<impl Future<Output = Result<PreferenceMutation, AppError>> + Send + use<W>, AppError>
    where
        W: FnOnce() -> Result<PreferenceMutation, AppError> + Send + 'static,
    {
        let (done, written) = tokio::sync::oneshot::channel();
        self.preference_executor()?
            .send(Box::new(move || {
                let _ = done.send(write());
            }))
            .map_err(|_| AppError::General("app settings executor stopped".to_string()))?;
        Ok(async move {
            written
                .await
                .map_err(|_| AppError::General("app settings write failed".to_string()))?
        })
    }

    fn preference_executor(&self) -> Result<mpsc::Sender<PreferenceWrite>, AppError> {
        let mut queue = self
            .preference_writes
            .lock()
            .map_err(|_| AppError::General("app settings executor mutex poisoned".to_string()))?;
        if let Some(queue) = queue.as_ref() {
            return Ok(queue.clone());
        }
        let (sender, writes) = mpsc::channel::<PreferenceWrite>();
        std::thread::Builder::new()
            .name("app-settings-writer".to_string())
            .spawn(move || {
                // Ends with the state that owns the queue.
                for write in writes {
                    // A write that panics drops its result sender and fails
                    // only its own call.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(write));
                }
            })?;
        *queue = Some(sender.clone());
        Ok(sender)
    }
}

pub(super) fn read_app_settings_value(
    config_dir: &Path,
) -> Result<Option<serde_json::Value>, AppError> {
    svode_core::variables::files::check_pending(config_dir)
        .map_err(|error| AppError::Storage(error.to_string()))?;
    let path = config_dir.join("settings.json");
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&data)?))
}

pub(super) fn default_app_settings_value() -> Result<serde_json::Value, AppError> {
    Ok(serde_json::to_value(AppSettings::default())?)
}

fn stored_appearance_field<'a>(value: &'a serde_json::Value, field: &str) -> Option<&'a str> {
    value
        .get("appearance")
        .and_then(|appearance| appearance.get(field))
        .and_then(serde_json::Value::as_str)
}

fn appearance_object_mut(
    value: &mut serde_json::Value,
) -> Result<&mut serde_json::Map<String, serde_json::Value>, AppError> {
    let root = value
        .as_object_mut()
        .ok_or_else(|| AppError::General("app settings root must be an object".to_string()))?;
    let appearance = root
        .entry("appearance".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    appearance
        .as_object_mut()
        .ok_or_else(|| AppError::General("app settings appearance must be an object".to_string()))
}

#[cfg(test)]
fn normalize_app_settings_value(
    mut value: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let appearance = appearance_object_mut(&mut value)?;
    let stored_theme = appearance.get("theme").and_then(serde_json::Value::as_str);
    if !matches!(stored_theme, Some("system" | "light" | "dark")) {
        appearance.insert(
            "theme".to_string(),
            serde_json::Value::String("system".to_string()),
        );
    }

    let stored_locale = appearance
        .get("language")
        .and_then(serde_json::Value::as_str);
    if !matches!(stored_locale, Some("en" | "ru")) {
        appearance.insert(
            "language".to_string(),
            serde_json::Value::String("en".to_string()),
        );
    }

    Ok(value)
}

pub(super) fn write_app_settings_value(
    config_dir: &Path,
    value: &serde_json::Value,
) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(value)?;
    let mut staged = tempfile::NamedTempFile::new_in(config_dir)?;
    staged.write_all(data.as_bytes())?;
    staged.as_file().sync_all()?;
    staged
        .persist(config_dir.join("settings.json"))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

/// Read app settings from config_dir/settings.json, creating defaults if missing.
#[cfg(test)]
pub fn read_app_settings(config_dir: &Path) -> Result<AppSettings, AppError> {
    let Some(value) = read_app_settings_value(config_dir)? else {
        let settings = AppSettings::default();
        write_app_settings(config_dir, &settings)?;
        return Ok(settings);
    };
    Ok(serde_json::from_value(normalize_app_settings_value(
        value,
    )?)?)
}

pub fn read_app_preferences(config_dir: &Path) -> Result<AppPreferences, AppError> {
    let Some(value) = read_app_settings_value(config_dir)? else {
        return Ok(AppPreferences {
            theme: "system".to_string(),
            language: "en".to_string(),
            theme_needs_recovery: true,
        });
    };
    let stored_theme = stored_appearance_field(&value, "theme");
    let stored_locale = stored_appearance_field(&value, "language");

    Ok(AppPreferences {
        theme: stored_theme
            .filter(|theme| SUPPORTED_THEMES.contains(theme))
            .unwrap_or("system")
            .to_string(),
        language: stored_locale
            .filter(|locale| SUPPORTED_LOCALES.contains(locale))
            .unwrap_or("en")
            .to_string(),
        theme_needs_recovery: !matches!(stored_theme, Some(theme) if SUPPORTED_THEMES.contains(&theme)),
    })
}

/// Write app settings to config_dir/settings.json.
#[cfg(test)]
pub fn write_app_settings(config_dir: &Path, settings: &AppSettings) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(settings)?;
    let mut staged = tempfile::NamedTempFile::new_in(config_dir)?;
    staged.write_all(data.as_bytes())?;
    staged.as_file().sync_all()?;
    staged
        .persist(config_dir.join("settings.json"))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn set_app_preference(
    config_dir: &Path,
    field: &str,
    value: &str,
    supported_values: &[&str],
) -> Result<PreferenceMutation, AppError> {
    if !supported_values.contains(&value) {
        return Err(AppError::General(format!(
            "unsupported app {field}: {value}"
        )));
    }

    let _guard = svode_core::variables::files::lock(config_dir)
        .map_err(|error| AppError::Storage(error.to_string()))?;
    svode_core::variables::files::check_pending(config_dir)
        .map_err(|error| AppError::Storage(error.to_string()))?;
    let mut settings = read_app_settings_value(config_dir)?
        .map(Ok)
        .unwrap_or_else(default_app_settings_value)?;
    if stored_appearance_field(&settings, field) == Some(value) {
        return Ok(PreferenceMutation {
            value: value.to_string(),
            changed: false,
        });
    }

    appearance_object_mut(&mut settings)?.insert(
        field.to_string(),
        serde_json::Value::String(value.to_string()),
    );
    write_app_settings_value(config_dir, &settings)?;
    Ok(PreferenceMutation {
        value: value.to_string(),
        changed: true,
    })
}

fn set_app_locale(config_dir: &Path, locale: &str) -> Result<PreferenceMutation, AppError> {
    if !SUPPORTED_LOCALES.contains(&locale) {
        return Err(AppError::General(format!(
            "unsupported app locale: {locale}"
        )));
    }
    set_app_preference(config_dir, "language", locale, &SUPPORTED_LOCALES)
}

fn set_app_theme(config_dir: &Path, theme: &str) -> Result<PreferenceMutation, AppError> {
    set_app_preference(config_dir, "theme", theme, &SUPPORTED_THEMES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::app_variables::SecretStore;
    use crate::space::types::{AppAgentSettings, DetectedCli};
    use std::sync::Barrier;
    use std::time::Duration;
    use svode_core::variables::{
        Context, Kind, Mode, Owner, Save, SaveOperation, Service, SourceOwner,
    };

    fn settings_with_siblings(locale: &str) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.appearance.theme = "dark".to_string();
        settings.appearance.language = locale.to_string();
        settings.window.width = 1440;
        settings.window.height = 900;
        settings.agents = Some(AppAgentSettings {
            detected: vec![DetectedCli {
                name: "codex".to_string(),
                path: "/usr/local/bin/codex".to_string(),
                version: Some("1.2.3".to_string()),
                auth_status: "authenticated".to_string(),
            }],
            last_scan: Some("2026-08-19T00:00:00Z".to_string()),
        });
        settings
    }

    #[test]
    fn locale_only_update_supports_both_locales_and_preserves_siblings() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let original = settings_with_siblings("en");
        write_app_settings(config_dir.path(), &original).expect("write settings");

        assert_eq!(
            set_app_locale(config_dir.path(), "ru")
                .expect("set ru locale")
                .value,
            "ru"
        );
        let updated = read_app_settings(config_dir.path()).expect("read updated settings");
        assert_eq!(updated.appearance.language, "ru");
        assert_eq!(updated.appearance.theme, "dark");
        assert_eq!(updated.window.width, 1440);
        assert_eq!(updated.window.height, 900);
        let agents = updated.agents.expect("agent settings preserved");
        assert_eq!(agents.detected.len(), 1);
        assert_eq!(agents.detected[0].name, "codex");
        assert_eq!(agents.last_scan.as_deref(), Some("2026-08-19T00:00:00Z"));

        assert_eq!(
            set_app_locale(config_dir.path(), "en")
                .expect("set en locale")
                .value,
            "en"
        );
        assert_eq!(
            read_app_settings(config_dir.path())
                .expect("read settings after second update")
                .appearance
                .language,
            "en"
        );
    }

    #[test]
    fn field_updates_preserve_raw_legacy_and_unknown_siblings() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let raw = serde_json::json!({
            "appearance": {
                "theme": "system",
                "language": "en",
                "futureAppearance": {"contrast": "high"}
            },
            "window": {"width": 1440, "height": 900, "futureWindow": true},
            "agents": {"detected": [], "lastScan": null},
            "futureTopLevel": ["preserve", 42]
        });
        std::fs::write(
            config_dir.path().join("settings.json"),
            serde_json::to_vec(&raw).expect("serialize raw settings"),
        )
        .expect("write raw settings");

        assert_eq!(
            set_app_theme(config_dir.path(), "dark").expect("set theme"),
            PreferenceMutation {
                value: "dark".to_string(),
                changed: true,
            }
        );
        assert_eq!(
            set_app_locale(config_dir.path(), "ru").expect("set locale"),
            PreferenceMutation {
                value: "ru".to_string(),
                changed: true,
            }
        );

        let saved: serde_json::Value = serde_json::from_slice(
            &std::fs::read(config_dir.path().join("settings.json")).expect("read updated settings"),
        )
        .expect("parse updated settings");
        assert_eq!(saved["appearance"]["theme"], "dark");
        assert_eq!(saved["appearance"]["language"], "ru");
        assert_eq!(
            saved["appearance"]["futureAppearance"],
            raw["appearance"]["futureAppearance"]
        );
        assert_eq!(saved["window"], raw["window"]);
        assert_eq!(saved["agents"], raw["agents"]);
        assert_eq!(saved["futureTopLevel"], raw["futureTopLevel"]);
    }

    #[test]
    fn app_preferences_normalize_invalid_fields_without_writing_them() {
        for appearance in [
            serde_json::json!({"theme": "sepia", "language": "de"}),
            serde_json::json!({}),
        ] {
            let config_dir = tempfile::tempdir().expect("config dir");
            let raw = serde_json::json!({
                "appearance": appearance,
                "window": {"width": 1200, "height": 800},
                "futureTopLevel": true
            });
            let path = config_dir.path().join("settings.json");
            let before = serde_json::to_vec(&raw).expect("serialize raw settings");
            std::fs::write(&path, &before).expect("write raw settings");

            assert_eq!(
                read_app_preferences(config_dir.path()).expect("read preferences"),
                AppPreferences {
                    theme: "system".to_string(),
                    language: "en".to_string(),
                    theme_needs_recovery: true,
                }
            );
            assert_eq!(
                std::fs::read(path).expect("read unchanged settings"),
                before
            );
        }
    }

    #[test]
    fn missing_settings_return_recoverable_defaults_without_materializing_a_file() {
        let config_dir = tempfile::tempdir().expect("config dir");

        assert_eq!(
            read_app_preferences(config_dir.path()).expect("read preferences"),
            AppPreferences {
                theme: "system".to_string(),
                language: "en".to_string(),
                theme_needs_recovery: true,
            }
        );
        assert!(!config_dir.path().join("settings.json").exists());
    }

    #[test]
    fn app_preference_projection_excludes_legacy_window_and_agent_state() {
        let projection = serde_json::to_value(AppPreferences {
            theme: "dark".to_string(),
            language: "ru".to_string(),
            theme_needs_recovery: false,
        })
        .expect("serialize app preferences");

        assert_eq!(
            projection,
            serde_json::json!({
                "theme": "dark",
                "language": "ru",
                "themeNeedsRecovery": false
            })
        );
        assert!(projection.get("window").is_none());
        assert!(projection.get("agents").is_none());
    }

    #[test]
    fn same_theme_is_a_write_free_no_op_and_invalid_theme_is_rejected() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let path = config_dir.path().join("settings.json");
        let compact = serde_json::to_string(&settings_with_siblings("en")).expect("serialize");
        std::fs::write(&path, &compact).expect("write compact settings");

        assert_eq!(
            set_app_theme(config_dir.path(), "dark").expect("set same theme"),
            PreferenceMutation {
                value: "dark".to_string(),
                changed: false,
            }
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("read unchanged settings"),
            compact
        );

        let error = set_app_theme(config_dir.path(), "sepia").expect_err("reject theme");
        assert_eq!(error.kind(), "general");
        assert_eq!(
            std::fs::read_to_string(path).expect("read settings after rejection"),
            compact
        );
    }

    #[test]
    fn same_locale_is_a_write_free_no_op() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let path = config_dir.path().join("settings.json");
        let compact = serde_json::to_string(&settings_with_siblings("en")).expect("serialize");
        std::fs::write(&path, &compact).expect("write compact settings");

        assert_eq!(
            set_app_locale(config_dir.path(), "en").expect("set same locale"),
            PreferenceMutation {
                value: "en".to_string(),
                changed: false,
            }
        );
        assert_eq!(
            std::fs::read_to_string(path).expect("read unchanged settings"),
            compact
        );
    }

    #[test]
    fn invalid_locale_leaves_persisted_settings_unchanged() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let settings = settings_with_siblings("ru");
        write_app_settings(config_dir.path(), &settings).expect("write settings");
        let path = config_dir.path().join("settings.json");
        let before = std::fs::read(&path).expect("read original settings");

        let error = set_app_locale(config_dir.path(), "de").expect_err("reject locale");

        assert_eq!(error.kind(), "general");
        assert_eq!(
            std::fs::read(path).expect("read settings after rejection"),
            before
        );
    }

    #[test]
    fn explicit_locale_update_repairs_unknown_or_missing_locale() {
        for appearance in [
            serde_json::json!({"theme": "dark", "language": "de"}),
            serde_json::json!({"theme": "dark"}),
        ] {
            let config_dir = tempfile::tempdir().expect("config dir");
            let raw = serde_json::json!({
                "appearance": appearance,
                "window": {"width": 1440, "height": 900}
            });
            std::fs::write(
                config_dir.path().join("settings.json"),
                serde_json::to_vec(&raw).expect("serialize raw settings"),
            )
            .expect("write raw settings");

            assert_eq!(
                read_app_settings(config_dir.path())
                    .expect("read normalized settings")
                    .appearance
                    .language,
                "en"
            );
            assert_eq!(
                set_app_locale(config_dir.path(), "en")
                    .expect("repair locale")
                    .value,
                "en"
            );
            assert_eq!(
                read_app_settings(config_dir.path())
                    .expect("read repaired settings")
                    .appearance
                    .language,
                "en"
            );
        }
    }

    /// Stands in for the Keychain: `get` reports that it was entered and
    /// waits until the test releases it.
    struct GatedSecretStore {
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl GatedSecretStore {
        fn new() -> (Self, tokio::sync::oneshot::Receiver<()>, mpsc::Sender<()>) {
            let (entered, on_entered) = tokio::sync::oneshot::channel();
            let (release, released) = mpsc::channel();
            let store = Self {
                entered: Mutex::new(Some(entered)),
                release: Mutex::new(released),
            };
            (store, on_entered, release)
        }
    }

    impl SecretStore for GatedSecretStore {
        fn get(&self, _account: &str) -> svode_core::variables::Result<Option<String>> {
            if let Some(entered) = self.entered.lock().expect("entered").take() {
                let _ = entered.send(());
            }
            let _ = self.release.lock().expect("release").recv();
            Ok(None)
        }

        fn set(&self, _account: &str, _value: &str) -> svode_core::variables::Result<()> {
            unreachable!("the catalog only reads secrets")
        }

        fn remove(&self, _account: &str) -> svode_core::variables::Result<()> {
            unreachable!("the catalog only reads secrets")
        }
    }

    /// A secret store that keeps values in memory, to set up Variables.
    #[derive(Default)]
    struct MemorySecretStore(Mutex<std::collections::BTreeMap<String, String>>);

    impl SecretStore for MemorySecretStore {
        fn get(&self, account: &str) -> svode_core::variables::Result<Option<String>> {
            Ok(self.0.lock().expect("secrets").get(account).cloned())
        }

        fn set(&self, account: &str, value: &str) -> svode_core::variables::Result<()> {
            self.0
                .lock()
                .expect("secrets")
                .insert(account.into(), value.into());
            Ok(())
        }

        fn remove(&self, account: &str) -> svode_core::variables::Result<()> {
            self.0.lock().expect("secrets").remove(account);
            Ok(())
        }
    }

    /// `owner` with the secret `API_TOKEN`, whose catalog reads the store.
    fn with_secret(owner: &Owner) {
        let secrets = MemorySecretStore::default();
        let service = Service::new(&secrets);
        let revision = service.catalog(owner).expect("catalog").revision;
        service
            .save(
                owner,
                Save {
                    name: "API_TOKEN".into(),
                    mode: Mode::Local,
                    kind: Kind::Secret,
                    value: Some("token".into()),
                    revision,
                    operation: SaveOperation::Create,
                    keep: None,
                },
            )
            .expect("save secret");
    }

    /// Starts a Variables operation under `run_locked` that reads the
    /// catalog of `owner` and waits in the secret store until released, as
    /// it waits for a Keychain prompt.
    async fn variables_operation_waiting_on_the_secret_store(
        state: &Arc<AppSettingsState>,
        owner: Owner,
    ) -> (
        tokio::task::JoinHandle<Result<usize, AppError>>,
        mpsc::Sender<()>,
    ) {
        let (secrets, entered, release) = GatedSecretStore::new();
        let operation = tokio::spawn({
            let state = Arc::clone(state);
            async move {
                crate::commands::app_variables::run_locked(&state, move || {
                    Service::new(&secrets)
                        .catalog(&owner)
                        .map(|catalog| catalog.entries.len())
                        .map_err(|failure| AppError::Storage(failure.to_string()))
                })
                .await
            }
        });
        tokio::time::timeout(WITHIN, entered)
            .await
            .expect("the Variables operation reaches the secret store")
            .expect("entered signal");
        (operation, release)
    }

    async fn finishes<T>(operation: tokio::task::JoinHandle<Result<T, AppError>>) -> T {
        tokio::time::timeout(WITHIN, operation)
            .await
            .expect("the operation finishes")
            .expect("join the operation")
            .expect("the operation succeeds")
    }

    async fn written(
        write: Result<impl Future<Output = Result<PreferenceMutation, AppError>>, AppError>,
    ) -> PreferenceMutation {
        tokio::time::timeout(WITHIN, write.expect("the write is queued"))
            .await
            .expect("the write finishes")
            .expect("the write succeeds")
    }

    const WITHIN: Duration = Duration::from_secs(5);

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn preference_commands_finish_while_project_variables_wait_on_the_secret_store() {
        // DF-365 acceptance 4(a): the commands no longer take the lock that
        // `run_locked` holds around the secret store.
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");
        let project = tempfile::tempdir().expect("project");
        std::fs::create_dir_all(project.path().join(".svode")).expect("project .svode");
        std::fs::write(
            project.path().join(".svode/config.json"),
            r#"{"name":"Test"}"#,
        )
        .expect("project config");
        let context = Context::new(project.path(), None, config_dir.path()).expect("context");
        let owner = Owner::in_context(&context, &SourceOwner::Project).expect("project owner");
        with_secret(&owner);
        let state = Arc::new(AppSettingsState::new());
        let (operation, release) =
            variables_operation_waiting_on_the_secret_store(&state, owner).await;

        let path = config_dir.path().to_path_buf();
        assert_eq!(
            written(state.set_app_theme(path.clone(), "light".into())).await,
            PreferenceMutation {
                value: "light".to_string(),
                changed: true,
            }
        );
        assert_eq!(
            written(state.set_app_locale(path.clone(), "ru".into()))
                .await
                .value,
            "ru"
        );
        let preferences = tokio::time::timeout(
            WITHIN,
            crate::commands::blocking(move || read_app_preferences(&path)),
        )
        .await
        .expect("get_app_preferences does not wait for the Variables operation")
        .expect("read preferences");
        assert_eq!(
            preferences,
            AppPreferences {
                theme: "light".to_string(),
                language: "ru".to_string(),
                theme_needs_recovery: false,
            }
        );
        assert!(!operation.is_finished());

        release.send(()).expect("release the secret store");
        assert_eq!(finishes(operation).await, 1);
    }

    #[test]
    fn with_global_variables_on_the_secret_store_a_theme_write_waits_on_the_executor_alone() {
        // DF-365 acceptance 4(b): the settings lock that global Variables
        // hold around the secret store is waited for by the settings
        // executor, never by the caller or a runtime thread.
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");
        let owner = Owner::global(config_dir.path()).expect("global owner");
        with_secret(&owner);
        let path = config_dir.path().to_path_buf();
        let state = Arc::new(AppSettingsState::new());

        within(Duration::from_secs(20), move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("current-thread runtime")
                .block_on(theme_write_waits_on_the_executor(state, owner, path))
        });
    }

    async fn theme_write_waits_on_the_executor(
        state: Arc<AppSettingsState>,
        owner: Owner,
        path: PathBuf,
    ) {
        let (operation, release) =
            variables_operation_waiting_on_the_secret_store(&state, owner.clone()).await;

        // `get_app_preferences` reads without the lock.
        let preferences = read_app_preferences(&path).expect("read preferences");
        assert_eq!(preferences.theme, "dark");

        // Queueing returns at once; the write waits on the executor.
        let write = tokio::spawn(
            state
                .set_app_theme(path.clone(), "light".into())
                .expect("the write is queued"),
        );
        // Another task of the only runtime thread goes on meanwhile.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !write.is_finished(),
            "the write waits for the settings lock"
        );
        assert_eq!(
            read_app_preferences(&path).expect("read preferences").theme,
            "dark"
        );

        release.send(()).expect("release the secret store");
        assert_eq!(finishes(operation).await, 1);
        let mutation = tokio::time::timeout(WITHIN, write)
            .await
            .expect("the write finishes after the release")
            .expect("join the write")
            .expect("set theme");
        assert_eq!(
            mutation,
            PreferenceMutation {
                value: "light".to_string(),
                changed: true,
            }
        );
        assert_eq!(
            read_app_preferences(&path).expect("read preferences").theme,
            "light"
        );
        let catalog = Service::new(&MemorySecretStore::default())
            .catalog(&owner)
            .expect("catalog after the write");
        assert_eq!(catalog.entries.len(), 1, "the global Variable stays");
    }

    /// Runs `body` on its own thread and fails if it does not return within
    /// `limit`, so a write that waits on its caller fails the test instead of
    /// hanging it.
    fn within<T: Send + 'static>(limit: Duration, body: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(body());
        });
        result
            .recv_timeout(limit)
            .expect("the test returns instead of waiting on its caller")
    }

    #[tokio::test]
    async fn a_series_of_theme_writes_queued_in_call_order_leaves_the_value_of_the_last_call() {
        // DF-365 acceptance 4(c): the ordered dispatch queues each call on
        // the main thread as it arrives, as this loop does, without waiting.
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");
        let state = AppSettingsState::new();
        let path = config_dir.path().to_path_buf();
        let themes: Vec<&str> = SUPPORTED_THEMES.iter().copied().cycle().take(200).collect();

        // The calls pile up behind the settings lock, as behind a Variables
        // operation, so only the queue keeps them in order once it is free.
        let held = svode_core::variables::files::lock(&path).expect("settings lock");
        let pending: Vec<_> = themes
            .iter()
            .map(|theme| state.set_app_theme(path.clone(), theme.to_string()))
            .collect();
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(held);
        // Results are awaited in reverse, so the call order alone decides
        // the outcome. Each call changes the theme its predecessor wrote,
        // which holds only when they are written in call order.
        for (theme, pending) in themes.iter().zip(pending).rev() {
            let mutation = written(pending).await;
            assert_eq!(mutation.value, *theme);
            assert!(mutation.changed, "{theme} follows a different theme");
        }

        assert_eq!(
            read_app_preferences(&path).expect("read preferences").theme,
            *themes.last().expect("last theme")
        );
    }

    #[tokio::test]
    async fn concurrent_theme_and_locale_writes_keep_both_fields() {
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");
        let state = AppSettingsState::new();
        let path = config_dir.path().to_path_buf();

        let theme = state.set_app_theme(path.clone(), "light".into());
        let locale = state.set_app_locale(path.clone(), "ru".into());
        let (theme, locale) = tokio::join!(written(theme), written(locale));
        assert!(theme.changed && locale.changed);

        assert_eq!(
            read_app_preferences(&path).expect("read final preferences"),
            AppPreferences {
                theme: "light".to_string(),
                language: "ru".to_string(),
                theme_needs_recovery: false,
            }
        );
    }

    #[tokio::test]
    async fn preference_writes_keep_settings_written_concurrently_by_variables() {
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");
        let state = AppSettingsState::new();
        let path = config_dir.path().to_path_buf();
        let start = Arc::new(Barrier::new(2));
        let owners: Vec<PathBuf> = (0..20)
            .map(|index| config_dir.path().join(format!("owner-{index}")))
            .collect();

        let variables = std::thread::spawn({
            let path = path.clone();
            let start = Arc::clone(&start);
            let owners = owners.clone();
            move || {
                start.wait();
                for owner in owners {
                    crate::space::app_variables::register_s3_owner(&path, &owner)
                        .expect("register owner");
                }
            }
        });
        start.wait();
        let pending: Vec<_> = (0..20)
            .map(|index| {
                let theme = SUPPORTED_THEMES[index % SUPPORTED_THEMES.len()];
                state.set_app_theme(path.clone(), theme.to_string())
            })
            .collect();
        for pending in pending {
            written(pending).await;
        }
        variables.join().expect("join Variables writes");

        let saved: serde_json::Value = serde_json::from_slice(
            &std::fs::read(path.join("settings.json")).expect("read settings"),
        )
        .expect("parse settings");
        assert_eq!(
            saved["appearance"]["theme"],
            SUPPORTED_THEMES[19 % SUPPORTED_THEMES.len()]
        );
        let registered: Vec<PathBuf> =
            serde_json::from_value(saved["s3VariableOwners"].clone()).expect("owners");
        assert_eq!(registered.len(), owners.len());
    }
}
