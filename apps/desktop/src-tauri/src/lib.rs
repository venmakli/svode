mod agent;
mod commands;
mod error;
mod files;
mod git;
mod index;
mod storage;
mod workspace;

use std::sync::Arc;

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
        .manage(Arc::new(files::BacklinkIndex::new()))
        .manage(git::GitState::new())
        .manage(index::IndexState::new())
        .invoke_handler(tauri::generate_handler![
            commands::greet::greet,
            commands::files::list_entries,
            commands::files::create_entry,
            commands::files::create_folder,
            commands::files::read_entry,
            commands::files::write_entry,
            commands::files::delete_entry,
            commands::files::rename_entry,
            commands::files::move_entry,
            commands::files::get_backlinks,
            commands::files::rebuild_backlinks,
            commands::files::validate_links,
            commands::files::nest_entry,
            commands::files::unnest_entry,
            commands::files::watch_workspace,
            commands::files::unwatch_workspace,
            commands::files::read_tree_order,
            commands::files::save_tree_order,
            commands::files::get_expanded_paths,
            commands::files::save_expanded_paths,
            commands::workspace::get_app_settings,
            commands::workspace::save_app_settings,
            commands::workspace::list_workspaces,
            commands::workspace::create_workspace,
            commands::workspace::open_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::get_last_active_workspace,
            commands::workspace::open_workspace_folder,
            commands::workspace::list_children,
            commands::workspace::create_child,
            commands::workspace::delete_child,
            commands::workspace::register_cloned_child,
            commands::workspace::path_exists,
            commands::workspace::ensure_assets_scope,
            commands::workspace::get_workspace_config,
            commands::workspace::save_workspace_config,
            commands::workspace::setup_cli_symlinks_cmd,
            commands::workspace::teardown_cli_symlinks_cmd,
            commands::workspace::check_symlink_health,
            commands::workspace::read_agents_md,
            agent::commands::agent_send,
            agent::commands::agent_stop,
            agent::commands::agent_list_available,
            agent::commands::agent_list_models,
            agent::commands::agent_respond_permission,
            git::commands::git_check_availability,
            git::commands::git_init_workspace,
            git::commands::git_clone_workspace,
            git::commands::git_status,
            git::commands::git_commit_file,
            git::commands::git_commit_all,
            git::commands::git_sync,
            git::commands::git_conflict_files,
            git::commands::git_resolve_continue,
            git::commands::git_merge_abort,
            git::commands::git_get_remote,
            git::commands::git_set_remote,
            git::commands::git_push,
            index::commands::reindex_workspace,
            index::commands::search_entries_by_title,
            index::commands::search_entries,
            index::commands::recent_entries,
            storage::commands::upload_asset,
            storage::commands::read_file_for_upload,
            storage::commands::list_assets,
            storage::commands::count_assets,
            storage::commands::get_assets_config,
            storage::commands::set_assets_strategy,
            storage::commands::check_s3_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
