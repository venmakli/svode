mod commands;
mod error;
mod files;

pub use error::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "combai_desktop_lib=debug".into()),
        )
        .init();

    tracing::info!("Starting CombAI desktop app");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(files::FileWatcher::new())
        .invoke_handler(tauri::generate_handler![
            commands::greet::greet,
            commands::files::list_entries,
            commands::files::create_entry,
            commands::files::read_entry,
            commands::files::write_entry,
            commands::files::delete_entry,
            commands::files::rename_entry,
            commands::files::watch_workspace,
            commands::files::unwatch_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
