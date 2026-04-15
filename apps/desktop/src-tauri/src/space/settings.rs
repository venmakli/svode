use std::path::Path;

use crate::error::AppError;

use super::types::AppSettings;

/// Read app settings from config_dir/settings.json, creating defaults if missing.
pub fn read_app_settings(config_dir: &Path) -> Result<AppSettings, AppError> {
    let path = config_dir.join("settings.json");
    if !path.exists() {
        let settings = AppSettings::default();
        write_app_settings(config_dir, &settings)?;
        return Ok(settings);
    }
    let data = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write app settings to config_dir/settings.json.
pub fn write_app_settings(config_dir: &Path, settings: &AppSettings) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(settings)?;
    std::fs::write(config_dir.join("settings.json"), data)?;
    Ok(())
}
