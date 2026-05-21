mod agent;
mod commands;
mod error;
mod files;
mod git;
mod identity;
mod index;
mod properties;
mod space;
mod storage;

use std::sync::Arc;

use tauri::Manager;

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
        .manage(Arc::new(files::WriteNonceRegistry::new()))
        .manage(git::GitState::new())
        .manage(index::IndexState::new())
        .manage(properties::PersonCacheState::new())
        .setup(|app| {
            let service = Arc::new(git::autocommit::AutocommitService::new(
                app.handle().clone(),
            ));
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet::greet,
            commands::files::list_entries,
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
            commands::files::repair_two_way_relation,
            commands::files::list_collections,
            commands::files::list_persons,
            commands::files::refresh_persons,
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
            commands::space::create_space,
            commands::space::delete_space,
            commands::space::register_cloned_space,
            commands::space::project_clone,
            commands::space::path_exists,
            commands::space::ensure_assets_scope,
            commands::space::get_space_config,
            commands::space::save_space_config,
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
            git::commands::git_check_availability,
            git::commands::git_init_space,
            git::commands::git_clone_space,
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
            git::commands::get_space_git_type,
            git::commands::git_get_submodule_url,
            git::commands::git_unpushed_commits,
            git::commands::git_publish,
            git::commands::git_enable_auto_sync,
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
            storage::lfs::repair_lfs,
            storage::lfs::get_lfs_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let autocommit = app_handle.state::<Arc<git::autocommit::AutocommitService>>();
                tauri::async_runtime::block_on(async {
                    autocommit.flush_all().await;
                });
            }
        });
}
