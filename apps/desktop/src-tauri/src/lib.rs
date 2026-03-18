mod agent;
mod commands;
mod error;
mod files;
mod workspace;

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
        .plugin(tauri_plugin_dialog::init())
        .manage(files::FileWatcher::new())
        .manage(agent::AgentSessions::new())
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
            commands::workspace::get_app_settings,
            commands::workspace::save_app_settings,
            commands::workspace::list_projects,
            commands::workspace::create_project,
            commands::workspace::delete_project,
            commands::workspace::open_project,
            commands::workspace::list_workspaces,
            commands::workspace::create_workspace,
            commands::workspace::open_folder_as_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::get_last_active_project,
            agent::commands::agent_send,
            agent::commands::agent_stop,
            agent::commands::agent_list_available,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
