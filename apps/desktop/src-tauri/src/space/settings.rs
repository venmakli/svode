use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::error::AppError;

use super::types::{AppPreferences, AppSettings};

const SUPPORTED_THEMES: [&str; 3] = ["system", "light", "dark"];
const SUPPORTED_LOCALES: [&str; 2] = ["en", "ru"];

#[derive(Debug, PartialEq, Eq)]
pub struct PreferenceMutation {
    pub value: String,
    pub changed: bool,
}

#[derive(Default)]
pub struct AppSettingsState {
    operation_lock: Mutex<()>,
}

impl AppSettingsState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.operation_lock
            .lock()
            .map_err(|_| AppError::General("app settings mutex poisoned".to_string()))
    }
}

fn read_app_settings_value(config_dir: &Path) -> Result<Option<serde_json::Value>, AppError> {
    let path = config_dir.join("settings.json");
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&data)?))
}

fn default_app_settings_value() -> Result<serde_json::Value, AppError> {
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

fn write_app_settings_value(config_dir: &Path, value: &serde_json::Value) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(value)?;
    std::fs::write(config_dir.join("settings.json"), data)?;
    Ok(())
}

/// Read app settings from config_dir/settings.json, creating defaults if missing.
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
pub fn write_app_settings(config_dir: &Path, settings: &AppSettings) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(settings)?;
    std::fs::write(config_dir.join("settings.json"), data)?;
    Ok(())
}

pub fn write_app_settings_preserving_locale(
    config_dir: &Path,
    settings: &AppSettings,
) -> Result<(), AppError> {
    let current = read_app_settings(config_dir)?;
    let mut updated = settings.clone();
    updated.appearance.language = current.appearance.language;
    write_app_settings(config_dir, &updated)
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

pub fn set_app_locale(config_dir: &Path, locale: &str) -> Result<PreferenceMutation, AppError> {
    if !SUPPORTED_LOCALES.contains(&locale) {
        return Err(AppError::General(format!(
            "unsupported app locale: {locale}"
        )));
    }
    set_app_preference(config_dir, "language", locale, &SUPPORTED_LOCALES)
}

pub fn set_app_theme(config_dir: &Path, theme: &str) -> Result<PreferenceMutation, AppError> {
    set_app_preference(config_dir, "theme", theme, &SUPPORTED_THEMES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::types::{AppAgentSettings, DetectedCli};
    use std::sync::{Arc, Barrier};

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

    #[test]
    fn full_settings_save_keeps_the_authoritative_locale() {
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("ru"))
            .expect("write current settings");
        let mut stale = settings_with_siblings("en");
        stale.appearance.theme = "light".to_string();
        stale.window.width = 1280;

        write_app_settings_preserving_locale(config_dir.path(), &stale)
            .expect("save sibling settings");

        let saved = read_app_settings(config_dir.path()).expect("read saved settings");
        assert_eq!(saved.appearance.language, "ru");
        assert_eq!(saved.appearance.theme, "light");
        assert_eq!(saved.window.width, 1280);
    }

    #[test]
    fn operation_lock_serializes_concurrent_locale_mutations() {
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");

        let locales = ["ru", "en", "ru", "en"];
        let state = Arc::new(AppSettingsState::new());
        let start = Arc::new(Barrier::new(locales.len()));
        let commit_order = Arc::new(std::sync::Mutex::new(Vec::new()));

        let handles = locales.map(|locale| {
            let config_dir = config_dir.path().to_path_buf();
            let state = Arc::clone(&state);
            let start = Arc::clone(&start);
            let commit_order = Arc::clone(&commit_order);
            std::thread::spawn(move || {
                start.wait();
                let _guard = state.lock().expect("lock settings mutation");
                let committed = set_app_locale(&config_dir, locale)
                    .expect("set locale")
                    .value;
                commit_order
                    .lock()
                    .expect("lock commit order")
                    .push(committed);
            })
        });

        for handle in handles {
            handle.join().expect("join locale mutation");
        }

        let last_committed = commit_order
            .lock()
            .expect("lock final commit order")
            .last()
            .cloned()
            .expect("at least one commit");
        assert_eq!(
            read_app_settings(config_dir.path())
                .expect("read final settings")
                .appearance
                .language,
            last_committed
        );
    }

    #[test]
    fn operation_lock_prevents_concurrent_theme_and_locale_field_loss() {
        let config_dir = tempfile::tempdir().expect("config dir");
        write_app_settings(config_dir.path(), &settings_with_siblings("en"))
            .expect("write settings");

        let state = Arc::new(AppSettingsState::new());
        let start = Arc::new(Barrier::new(2));
        let theme_handle = {
            let config_dir = config_dir.path().to_path_buf();
            let state = Arc::clone(&state);
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                let _guard = state.lock().expect("lock theme mutation");
                set_app_theme(&config_dir, "light").expect("set theme");
            })
        };
        let locale_handle = {
            let config_dir = config_dir.path().to_path_buf();
            let state = Arc::clone(&state);
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                let _guard = state.lock().expect("lock locale mutation");
                set_app_locale(&config_dir, "ru").expect("set locale");
            })
        };

        theme_handle.join().expect("join theme mutation");
        locale_handle.join().expect("join locale mutation");

        assert_eq!(
            read_app_preferences(config_dir.path()).expect("read final preferences"),
            AppPreferences {
                theme: "light".to_string(),
                language: "ru".to_string(),
                theme_needs_recovery: false,
            }
        );
    }
}
