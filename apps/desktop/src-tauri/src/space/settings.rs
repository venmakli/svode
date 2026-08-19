use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::error::AppError;

use super::types::AppSettings;

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

fn read_app_settings_with_stored_locale(
    config_dir: &Path,
) -> Result<(AppSettings, Option<String>), AppError> {
    let path = config_dir.join("settings.json");
    if !path.exists() {
        let settings = AppSettings::default();
        write_app_settings(config_dir, &settings)?;
        return Ok((settings, Some("en".to_string())));
    }

    let data = std::fs::read_to_string(&path)?;
    let mut value: serde_json::Value = serde_json::from_str(&data)?;
    let stored_locale = value
        .get("appearance")
        .and_then(|appearance| appearance.get("language"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    if !matches!(stored_locale.as_deref(), Some("en" | "ru")) {
        if let Some(appearance) = value
            .get_mut("appearance")
            .and_then(serde_json::Value::as_object_mut)
        {
            appearance.insert(
                "language".to_string(),
                serde_json::Value::String("en".to_string()),
            );
        }
    }

    Ok((serde_json::from_value(value)?, stored_locale))
}

/// Read app settings from config_dir/settings.json, creating defaults if missing.
pub fn read_app_settings(config_dir: &Path) -> Result<AppSettings, AppError> {
    read_app_settings_with_stored_locale(config_dir).map(|(settings, _)| settings)
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

pub fn set_app_locale(config_dir: &Path, locale: &str) -> Result<String, AppError> {
    if !matches!(locale, "en" | "ru") {
        return Err(AppError::General(format!(
            "unsupported app locale: {locale}"
        )));
    }

    let (mut settings, stored_locale) = read_app_settings_with_stored_locale(config_dir)?;
    if stored_locale.as_deref() == Some(locale) {
        return Ok(locale.to_string());
    }

    settings.appearance.language = locale.to_string();
    write_app_settings(config_dir, &settings)?;
    Ok(locale.to_string())
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
            set_app_locale(config_dir.path(), "ru").expect("set ru locale"),
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
            set_app_locale(config_dir.path(), "en").expect("set en locale"),
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
    fn same_locale_is_a_write_free_no_op() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let path = config_dir.path().join("settings.json");
        let compact = serde_json::to_string(&settings_with_siblings("en")).expect("serialize");
        std::fs::write(&path, &compact).expect("write compact settings");

        assert_eq!(
            set_app_locale(config_dir.path(), "en").expect("set same locale"),
            "en"
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
                set_app_locale(config_dir.path(), "en").expect("repair locale"),
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
                let committed = set_app_locale(&config_dir, locale).expect("set locale");
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
}
