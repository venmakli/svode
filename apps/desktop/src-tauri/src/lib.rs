mod agent;
mod agent_sessions;
mod app_windows;
mod commands;
mod error;
mod files;
mod git;
mod identity;
mod index;
pub mod mcp;
mod native_file_drop;
mod process;
mod properties;
mod repo_path;
mod space;
mod storage;
mod system_path;
mod terminal;

use std::sync::Arc;

use tauri::Manager;

pub use error::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "svode_lib=debug".into()),
        )
        .init();

    tracing::info!("Starting Svode desktop app");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            app_windows::handle_single_instance(app, args, cwd);
        }))
        .manage(files::FileWatcher::new())
        .manage(agent::AgentSessions::new())
        .manage(agent_sessions::AgentSessionsState::new())
        .manage(Arc::new(files::WriteNonceRegistry::new()))
        .manage(git::GitState::new())
        .manage(index::IndexState::new())
        .manage(app_windows::AppWindowState::new())
        .manage(mcp::active::ActiveProjectState::new())
        .manage(properties::ActorCatalogState::new())
        .manage(terminal::TerminalManager::new())
        .menu(app_windows::build_initial_app_menu)
        .on_menu_event(|app, event| {
            app_windows::handle_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            app_windows::handle_window_event(app, window, event);
        })
        .setup(|app| {
            let service = Arc::new(git::autocommit::AutocommitService::new(
                app.handle().clone(),
            ));
            app.manage(service);
            if let Err(error) = native_file_drop::clear_materialized_file_drops(app.handle()) {
                tracing::warn!("failed to clear dropped-file cache during setup: {error}");
            }
            if let Err(error) = app_windows::rebuild_app_menu(app.handle()) {
                tracing::warn!("failed to rebuild app menu during setup: {error}");
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = mcp::ipc::start_desktop_ipc(handle).await {
                    tracing::warn!("failed to start MCP desktop IPC: {}", error.message);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet::greet,
            commands::files::list_entries,
            commands::files::list_tree_children,
            commands::files::get_entry_detail_state,
            commands::files::create_entry,
            commands::files::create_folder,
            commands::files::read_entry,
            commands::files::get_entry_schema,
            commands::files::get_collection_schema,
            commands::files::update_entry_field,
            commands::files::add_schema_column,
            commands::files::change_schema_type,
            commands::files::assign_unique_id,
            commands::files::normalize_unique_id_counter,
            commands::files::rename_schema_column,
            commands::files::update_schema_column,
            commands::files::delete_schema_column,
            commands::files::add_option,
            commands::files::rename_option,
            commands::files::delete_option,
            commands::files::update_option,
            commands::files::promote_orphan,
            commands::files::clear_field_values,
            commands::files::clear_option_values,
            commands::files::replace_option_values,
            commands::files::update_system_field_label,
            commands::files::update_document_label,
            commands::files::list_templates,
            commands::files::create_template,
            commands::files::delete_template,
            commands::files::duplicate_template,
            commands::files::instantiate_template,
            commands::files::set_default_template,
            commands::files::reorder_templates,
            commands::files::add_view,
            commands::files::rename_view,
            commands::files::update_view,
            commands::files::delete_view,
            commands::files::duplicate_view,
            commands::files::reorder_views,
            commands::files::list_entries_for_view,
            commands::files::query_entries,
            commands::files::resolve_relation,
            commands::files::resolve_relations_batch,
            commands::files::query_relation_backlinks,
            commands::files::diagnose_two_way_relation,
            commands::files::repair_two_way_relation,
            commands::files::list_collections,
            commands::files::list_actors,
            commands::files::refresh_actors,
            commands::files::write_entry,
            commands::files::delete_entry,
            commands::files::rename_entry,
            commands::files::move_entry,
            commands::files::get_backlinks,
            commands::files::rebuild_backlinks,
            commands::files::validate_links,
            commands::files::nest_entry,
            commands::files::unnest_entry,
            commands::files::convert_entry_to_folder,
            commands::files::convert_entry_to_leaf,
            commands::files::convert_entry_to_nested_collection,
            commands::files::convert_bare_folder_to_collection,
            commands::files::duplicate_entry,
            commands::files::watch_space,
            commands::files::unwatch_space,
            commands::files::read_tree_order,
            commands::files::save_tree_order,
            commands::files::get_expanded_paths,
            commands::files::save_expanded_paths,
            commands::files::resolve_doc_link,
            commands::files::make_relative_link,
            commands::files::suggest_link_fix,
            commands::space::get_app_settings,
            commands::space::save_app_settings,
            commands::space::list_projects,
            commands::space::create_project,
            commands::space::open_project,
            commands::space::delete_project,
            commands::space::get_last_active_project,
            commands::space::open_project_folder,
            commands::space::list_spaces,
            commands::space::reorder_spaces,
            commands::space::create_space,
            commands::space::delete_space,
            commands::space::register_cloned_space,
            commands::space::project_clone,
            commands::space::path_exists,
            commands::space::ensure_assets_scope,
            commands::space::ensure_space_scaffold,
            commands::space::get_space_config,
            commands::space::save_space_config,
            app_windows::new_project_window,
            app_windows::open_project_window,
            app_windows::get_window_open_intent,
            app_windows::release_current_project_window,
            commands::space::setup_cli_symlinks_cmd,
            commands::space::teardown_cli_symlinks_cmd,
            commands::space::check_symlink_health,
            commands::space::read_agents_md,
            commands::space::write_agents_md,
            commands::space::clone_missing_space,
            commands::space::remove_missing_space,
            commands::project_openers::list_project_openers,
            commands::project_openers::open_project_in_tool,
            agent::commands::agent_send,
            agent::commands::agent_stop,
            agent::commands::agent_list_available,
            agent::commands::agent_list_models,
            agent::commands::agent_respond_permission,
            agent_sessions::commands::agent_sessions_list,
            agent_sessions::commands::agent_sessions_refresh,
            agent_sessions::commands::agent_sessions_hot_status,
            agent_sessions::commands::agent_sessions_set_pinned,
            agent_sessions::commands::agent_sessions_reenter,
            git::commands::git_check_availability,
            git::commands::git_init_space,
            git::commands::git_clone_space,
            git::commands::git_status,
            git::commands::git_fetch_status,
            git::commands::git_commit_file,
            git::commands::git_commit_all,
            git::commands::git_commit_paths,
            git::commands::git_sync,
            git::commands::git_save_http_credentials,
            git::commands::git_conflict_files,
            git::commands::git_resolve_continue,
            git::commands::git_merge_abort,
            git::commands::git_get_remote,
            git::commands::git_set_remote,
            git::commands::git_push,
            git::commands::get_space_git_type,
            git::commands::git_get_submodule_url,
            git::commands::git_unpushed_commits,
            git::commands::git_publish,
            git::commands::git_enable_auto_sync,
            git::commands::git_set_auto_sync,
            git::commands::git_get_user_policy,
            git::commands::git_set_user_policy,
            identity::commands::get_git_identity,
            identity::commands::set_git_identity,
            identity::commands::get_repo_identity,
            identity::commands::set_repo_identity,
            identity::commands::get_project_fanout_preview,
            identity::commands::set_project_identity,
            index::commands::reindex_space,
            index::commands::reindex_project,
            index::commands::search_project_entries_by_title,
            index::commands::search_project_entries,
            index::commands::recent_project_entries,
            index::commands::count_broken_links,
            storage::commands::upload_asset,
            storage::commands::read_file_for_upload,
            storage::commands::list_assets,
            storage::commands::count_assets,
            storage::commands::get_assets_config,
            storage::commands::set_assets_strategy,
            storage::commands::check_s3_connection,
            storage::commands::has_s3_credentials,
            storage::commands::resolve_asset_url,
            storage::policy::diagnose_lfs_policy,
            storage::lfs::diagnose_lfs_remote,
            storage::lfs::repair_lfs,
            storage::lfs::get_lfs_state,
            terminal::commands::terminal_spawn,
            terminal::commands::terminal_write,
            terminal::commands::terminal_resize,
            terminal::commands::terminal_kill,
            terminal::commands::terminal_list,
            terminal::commands::terminal_prepare_paths,
            terminal::commands::terminal_prepare_resource_paths,
            terminal::commands::terminal_list_agent_surfaces,
            terminal::commands::terminal_register_agent_session,
            native_file_drop::native_file_drop_paths,
            native_file_drop::materialize_file_drop,
            native_file_drop::materialize_native_file_drop_paths,
            mcp::commands::mcp_set_active_context,
            mcp::commands::mcp_clear_active_context,
            mcp::commands::mcp_get_active_context,
            mcp::commands::mcp_get_status,
            mcp::commands::mcp_install_client,
            mcp::commands::mcp_remove_client,
            mcp::commands::mcp_print_config,
            mcp::commands::mcp_run_doctor,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let terminal_manager = app_handle.state::<terminal::TerminalManager>();
                terminal_manager.kill_all();

                if let Err(error) = native_file_drop::clear_materialized_file_drops(app_handle) {
                    tracing::warn!("failed to clear dropped-file cache during exit: {error}");
                }

                let autocommit = app_handle.state::<Arc<git::autocommit::AutocommitService>>();
                tauri::async_runtime::block_on(async {
                    autocommit.flush_all().await;
                });
            }
        });
}
