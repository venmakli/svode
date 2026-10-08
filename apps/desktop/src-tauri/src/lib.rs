mod actors;
mod agent_actors;
mod agent_context;
mod agent_runtime;
mod agent_sessions;
mod agent_setup;
mod app_windows;
mod apps;
mod attachments;
mod commands;
mod document;
mod error;
mod external_apps;
mod files;
mod git;
mod identity;
mod index;
mod installation;
#[cfg(target_os = "macos")]
mod macos_fullscreen;
pub mod mcp;
mod media;
mod native_file_drop;
mod navigation;
mod page;
mod process;
mod project_runtime;
mod properties;
mod repo_path;
mod routines;
mod space;
mod speech;
mod storage;
mod structure;
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

    let agent_runtime_state = agent_runtime::AgentRuntimeState::new();
    // Managed agent PTYs and ACP sessions share one writer registry.
    let terminal_manager = terminal::TerminalManager::new(agent_runtime_state.runtime().writers());
    let routine_acp_launches =
        routines::RoutineAcpLaunches::new(agent_runtime_state.runtime().clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            app_windows::handle_single_instance(app, args, cwd);
        }))
        .manage(agent_context::AgentContextState::new())
        .manage(files::FileWatcher::new())
        .manage(agent_sessions::AgentSessionsState::new())
        .manage(agent_runtime_state)
        .manage(Arc::new(svode_core::page::nonce::WriteNonceRegistry::new()))
        .manage(git::GitState::new())
        .manage(identity::IdentityState::new())
        .manage(routines::RoutineSchedulerState::new())
        .manage(project_runtime::ProjectRuntimeState::new())
        .manage(app_windows::AppWindowState::new())
        .manage(space::settings::AppSettingsState::new())
        .manage(mcp::active::ActiveProjectState::new())
        .manage(mcp::project_sessions::ProjectSessions::new())
        .manage(mcp::commands::McpConfigState::new())
        .manage(actors::ActorCatalogState::new())
        .manage(terminal_manager)
        .manage(routine_acp_launches)
        .manage(media::MediaSourceState::new())
        .manage(apps::AppSourceState::new())
        .manage(apps::AppProcessState::new())
        .register_asynchronous_uri_scheme_protocol("svode-media", |context, request, responder| {
            media::protocol::handle_media_protocol(
                context.app_handle().clone(),
                request,
                responder,
            );
        })
        .menu(app_windows::build_initial_app_menu)
        .on_menu_event(|app, event| {
            app_windows::handle_menu_event(app, event.id().as_ref());
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<agent_runtime::AgentRuntimeState>()
                    .release_webview(webview.label());
                if let Some(connections) =
                    webview.try_state::<Arc<agent_runtime::connections::AgentConnections>>()
                {
                    connections.release_webview(webview.label());
                }
                speech::commands::release_webview(webview.app_handle(), webview.label());
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            app_windows::handle_window_event(app, window, event);
        })
        .setup(|app| {
            let routine_stores = Arc::new(routines::RoutineStoreState::new());
            app.manage(routine_stores.clone());
            app.manage(index::IndexState::new());
            app.manage(index::update::IndexUpdateState::new(routine_stores));
            app.manage(git::GitHostState::new(app.handle().clone()));
            app.manage(git::access::RepositoryAccessState::new(
                app.handle().clone(),
            ));
            let git_runtime = app.state::<git::GitState>().runtime().clone();
            let git_host = app.state::<git::GitHostState>().handle().clone();
            let service = Arc::new(svode_core::git::autocommit::AutocommitService::new(
                git_runtime,
                git_host,
            ));
            app.manage(service);
            let agent_setup = agent_setup::AgentSetupState::new(
                &app.path().app_data_dir()?,
                app.path().app_config_dir()?,
            );
            app.manage(agent_setup.clone());
            let speech = speech::SpeechState::new(
                &app.path().app_data_dir()?,
                &app.package_info().version.to_string(),
            );
            speech.refresh_measurements(speech::commands::events(app.handle()));
            app.manage(speech);
            app.manage(Arc::new(agent_runtime::connections::AgentConnections::new(
                app.state::<agent_runtime::AgentRuntimeState>()
                    .runtime()
                    .clone(),
                agent_setup,
            )));
            if let Err(error) = native_file_drop::clear_materialized_file_drops(app.handle()) {
                tracing::warn!("failed to clear dropped-file cache during setup: {error}");
            }
            if let Err(error) = app_windows::rebuild_app_menu(app.handle()) {
                tracing::warn!("failed to rebuild app menu during setup: {error}");
            }
            app.state::<routines::RoutineSchedulerState>()
                .sync(app.handle());
            #[cfg(target_os = "macos")]
            macos_fullscreen::install(app.handle());
            agent_sessions::follow_acp_catalog_changes(
                &app.state::<agent_sessions::AgentSessionsState>(),
                app.state::<agent_runtime::AgentRuntimeState>()
                    .runtime()
                    .clone(),
            );
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updated_from = installation::take_ownership(&handle).await;
                mcp::commands::reconcile_clients(&handle, updated_from).await;
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = mcp::ipc::start_desktop_ipc(handle).await {
                    tracing::warn!("failed to start MCP desktop IPC: {}", error.message);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            attachments::commands::attachments_list,
            attachments::commands::attachments_inspect_import_source,
            attachments::commands::attachments_import_file,
            apps::commands::app_manifest_inspect,
            apps::commands::app_process_control,
            apps::commands::app_source_revoke,
            apps::commands::app_open_owner_directory,
            apps::commands::app_open_browser,
            commands::app_variables::get_app_variables,
            commands::app_variables::upsert_app_variable,
            commands::app_variables::remove_app_variable,
            commands::app_variables::recover_app_variables,
            commands::app_variables::set_app_variable_binding,
            document::commands::document_inspect_source,
            document::commands::document_read_source,
            document::commands::document_list_external_apps,
            document::commands::document_open_external,
            document::commands::document_reveal_external,
            media::commands::media_create_source,
            media::commands::media_create_local_source,
            media::commands::media_validate_source,
            media::commands::media_revoke_source,
            media::commands::media_list_external_apps,
            media::commands::media_open_external,
            media::commands::media_reveal_external,
            agent_context::commands::agent_context_get_instructions,
            agent_context::commands::agent_context_refresh_instructions,
            actors::commands::actors_get_catalog,
            actors::commands::actors_refresh_catalog,
            actors::commands::actors_get_activity,
            actors::commands::actors_preview_mutation,
            actors::commands::actors_apply_mutation,
            actors::commands::actors_get_mailmap_save_review,
            actors::commands::actors_save_mailmap,
            agent_actors::commands::agent_actors_get,
            agent_actors::commands::agent_actors_mutate,
            agent_actors::commands::agent_actors_generate_id,
            agent_actors::commands::agent_actors_inspect_binding,
            agent_actors::commands::agent_actors_diagnose_adapter,
            agent_actors::commands::agent_actors_get_catalog_save_review,
            agent_actors::commands::agent_actors_save_catalog,
            agent_actors::commands::agent_actors_preview_delete_references,
            routines::commands::routines_list,
            routines::commands::routines_refresh,
            routines::commands::routines_get_automatic_consent,
            routines::commands::routines_set_automatic_consent,
            routines::commands::routines_acknowledge_storage_recovery,
            routines::commands::routines_create,
            routines::commands::routines_update,
            routines::commands::routines_delete,
            routines::commands::routines_dispatch_manual,
            routines::commands::routines_resolve_launches,
            git::access::repository_access_get,
            git::access::repository_access_verify,
            git::access::repository_access_activate,
            commands::greet::greet,
            commands::files::list_content_tree,
            commands::files::list_tree_children,
            commands::files::get_page_detail_state,
            commands::files::get_scope_owner_facts,
            commands::files::create_page,
            commands::files::create_collection,
            commands::files::create_folder,
            commands::files::read_page,
            commands::files::get_page_schema,
            commands::files::get_collection_schema,
            commands::files::update_page_field,
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
            commands::files::list_collection_view_items,
            commands::files::query_collection_items,
            commands::files::resolve_relation,
            commands::files::resolve_relations_batch,
            commands::files::query_relation_backlinks,
            commands::files::diagnose_two_way_relation,
            commands::files::repair_two_way_relation,
            commands::files::list_collections,
            commands::files::list_actors,
            commands::files::refresh_actors,
            commands::files::write_page_body,
            commands::files::delete_content,
            commands::files::rename_content,
            commands::files::move_content,
            commands::files::get_backlinks,
            commands::files::rebuild_backlinks,
            commands::files::validate_links,
            commands::files::nest_page,
            commands::files::unnest_page,
            commands::files::convert_page_to_folder,
            commands::files::convert_page_to_leaf,
            commands::files::convert_to_collection,
            commands::files::convert_bare_folder_to_collection,
            commands::files::duplicate_page,
            commands::files::watch_space,
            commands::files::unwatch_space,
            commands::files::read_tree_order,
            commands::files::save_tree_order,
            commands::files::resolve_doc_link,
            commands::files::make_relative_link,
            commands::files::suggest_link_fix,
            commands::space::get_app_preferences,
            commands::space::set_app_locale,
            commands::space::set_app_theme,
            commands::space::list_projects,
            commands::space::create_project,
            commands::space::open_project,
            commands::space::activate_home_project,
            commands::space::delete_project,
            commands::space::open_project_folder,
            commands::space::list_spaces,
            commands::space::reorder_spaces,
            commands::space::create_space,
            commands::space::delete_space,
            commands::space::register_cloned_space,
            commands::space::project_clone,
            commands::space::path_exists,
            commands::space::path_kind,
            commands::space::search_project_files,
            commands::space::ensure_assets_scope,
            commands::space::ensure_space_scaffold,
            commands::space::get_space_config,
            commands::space::save_space_config,
            app_windows::new_project_window,
            app_windows::open_project_window,
            app_windows::get_window_open_intent,
            app_windows::show_home_in_current_window,
            app_windows::list_projects_in_other_windows,
            app_windows::set_current_window_title,
            commands::space::clone_missing_space,
            commands::space::remove_missing_space,
            commands::project_openers::list_project_openers,
            commands::project_openers::open_project_in_tool,
            commands::project_openers::list_artifact_openers,
            commands::project_openers::open_artifact_in_tool,
            agent_actors::commands::agent_adapters_list_identities,
            agent_sessions::commands::agent_sessions_list,
            agent_sessions::commands::agent_sessions_list_saved,
            agent_sessions::commands::agent_sessions_refresh,
            agent_sessions::commands::agent_sessions_hot_status,
            agent_sessions::commands::agent_sessions_reenter,
            agent_sessions::commands::agent_sessions_hold_catalog,
            agent_sessions::commands::agent_sessions_raise_catalog,
            agent_sessions::commands::agent_sessions_release_catalog,
            agent_runtime::commands::agent_runtime_subscribe,
            agent_runtime::commands::agent_runtime_unsubscribe,
            agent_runtime::commands::agent_runtime_detail,
            agent_runtime::commands::agent_runtime_media,
            agent_runtime::commands::agent_runtime_prompt,
            agent_runtime::commands::agent_runtime_set_setting,
            agent_runtime::commands::agent_runtime_cancel,
            agent_runtime::commands::agent_runtime_answer,
            agent_runtime::commands::agent_runtime_check,
            agent_runtime::commands::agent_runtime_hold_draft,
            agent_runtime::commands::agent_runtime_release_draft,
            agent_runtime::commands::agent_runtime_start_session,
            agent_runtime::commands::agent_runtime_open_session,
            agent_runtime::commands::agent_runtime_release_session,
            agent_setup::commands::agent_setup_list,
            agent_setup::commands::agent_setup_chat_agents,
            agent_setup::commands::agent_setup_enable,
            agent_setup::commands::agent_setup_disable,
            agent_setup::commands::agent_setup_update_adapter,
            agent_setup::commands::agent_setup_remove_adapter,
            agent_setup::commands::agent_setup_sign_in,
            agent_setup::commands::agent_custom_list,
            agent_setup::commands::agent_custom_add,
            agent_setup::commands::agent_custom_update,
            agent_setup::commands::agent_custom_remove,
            agent_setup::commands::agent_custom_set_enabled,
            agent_setup::commands::agent_custom_check,
            navigation::commands::navigation_read,
            navigation::commands::navigation_pin,
            navigation::commands::navigation_keep,
            navigation::commands::navigation_unpin,
            navigation::commands::navigation_unkeep,
            navigation::commands::navigation_forget,
            navigation::commands::navigation_retitle,
            navigation::commands::navigation_describe,
            navigation::commands::navigation_expanded_paths,
            navigation::commands::navigation_save_expanded_paths,
            git::commands::git_check_availability,
            git::commands::git_init_space,
            git::commands::git_clone_space,
            git::commands::git_status,
            git::commands::git_fetch_status,
            git::commands::git_commit_file,
            git::inspection::git_working_tree_item,
            git::inspection_stats::git_inspection_stats,
            git::commands::git_commit_all,
            git::commands::git_commit_paths,
            git::commands::git_sync,
            git::commands::git_publication_status,
            git::commands::git_retry_parent,
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
            index::commands::search_project_pages_by_title,
            index::commands::count_broken_links,
            index::commands::get_knowledge_documents,
            storage::commands::upload_asset,
            storage::commands::read_file_for_upload,
            storage::commands::list_assets,
            storage::commands::count_assets,
            storage::commands::get_assets_config,
            storage::commands::set_assets_strategy,
            storage::commands::has_s3_credentials,
            storage::bindings::get_s3_bindings,
            storage::bindings::check_s3_bindings,
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
            terminal::commands::terminal_register_agent_session,
            native_file_drop::native_file_drop_paths,
            native_file_drop::materialize_file_drop,
            native_file_drop::materialize_native_file_drop_paths,
            native_file_drop::native_clipboard_file_paths,
            native_file_drop::save_pasted_image,
            mcp::commands::mcp_set_active_context,
            mcp::commands::mcp_clear_active_context,
            mcp::commands::mcp_get_active_context,
            mcp::commands::mcp_get_status,
            mcp::commands::mcp_install_client,
            mcp::commands::mcp_remove_client,
            mcp::commands::mcp_remove_shared_skill,
            mcp::commands::mcp_run_doctor,
            speech::commands::speech_models,
            speech::commands::speech_model_install,
            speech::commands::speech_model_cancel,
            speech::commands::speech_model_prepare,
            speech::commands::speech_model_activate,
            speech::commands::speech_model_delete,
            speech::commands::speech_language_set,
            speech::commands::speech_model_licenses,
            speech::commands::speech_dictation_owner,
            speech::commands::speech_dictation_start,
            speech::commands::speech_dictation_finish,
            speech::commands::speech_dictation_cancel,
            speech::commands::speech_open_system_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Every normal exit path ends in `Exit`; macOS app-menu Quit and Windows
            // File → Quit never emit `ExitRequested` (tauri#9198).
            if let tauri::RunEvent::Exit = event {
                shutdown_desktop(app_handle);
            }
        });
}

fn shutdown_desktop(app_handle: &tauri::AppHandle) {
    tracing::info!("running desktop shutdown sequence");
    app_handle
        .state::<routines::RoutineSchedulerState>()
        .stop_all();
    let agent_runtime = app_handle.state::<agent_runtime::AgentRuntimeState>();
    tauri::async_runtime::block_on(agent_runtime.runtime().shutdown());
    let speech = app_handle.state::<speech::SpeechState>();
    tauri::async_runtime::block_on(speech.shutdown());
    app_handle
        .state::<routines::RoutineAcpLaunches>()
        .record_exit();
    let terminal_manager = app_handle.state::<terminal::TerminalManager>();
    terminal_manager.kill_all();
    let app_processes = app_handle.state::<apps::AppProcessState>();
    app_processes.kill_all();

    if let Err(error) = native_file_drop::clear_materialized_file_drops(app_handle) {
        tracing::warn!("failed to clear dropped-file cache during exit: {error}");
    }

    let autocommit = app_handle.state::<Arc<svode_core::git::autocommit::AutocommitService>>();
    let project_sessions = app_handle.state::<mcp::project_sessions::ProjectSessions>();
    tauri::async_runtime::block_on(async {
        autocommit.flush_all().await;
        project_sessions.close_all().await;
    });
}
