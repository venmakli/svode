use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use crate::error::AppError;
use crate::space::{config, registry, types::RegistryEntry};

const MENU_NEW_WINDOW: &str = "app:new-window";
const MENU_OPEN_FOLDER: &str = "app:open-folder";
const MENU_OPEN_RECENT_PREFIX: &str = "app:open-recent:";
const EVENT_OPEN_FOLDER: &str = "app-menu:open-folder";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowOpenIntent {
    Home,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

#[derive(Default)]
pub struct AppWindowState {
    inner: Mutex<AppWindowStateInner>,
}

#[derive(Default)]
struct AppWindowStateInner {
    project_windows: HashMap<String, String>,
    window_projects: HashMap<String, String>,
    window_intents: HashMap<String, WindowOpenIntent>,
    last_focused_window: Option<String>,
    next_home_window: u64,
}

impl AppWindowState {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_home_label(&self) -> String {
        let mut inner = self.inner.lock().expect("app window mutex poisoned");
        inner.next_home_window += 1;
        format!("launcher-{}", inner.next_home_window)
    }

    fn register_home_window(&self, label: &str) {
        let mut inner = self.inner.lock().expect("app window mutex poisoned");
        inner
            .window_intents
            .insert(label.to_string(), WindowOpenIntent::Home);
        inner.window_projects.remove(label);
    }

    fn register_project_window(&self, project_id: &str, label: &str) {
        let mut inner = self.inner.lock().expect("app window mutex poisoned");
        if let Some(previous_project_id) = inner.window_projects.get(label).cloned() {
            if previous_project_id != project_id
                && inner.project_windows.get(&previous_project_id) == Some(&label.to_string())
            {
                inner.project_windows.remove(&previous_project_id);
            }
        }
        inner
            .project_windows
            .insert(project_id.to_string(), label.to_string());
        inner
            .window_projects
            .insert(label.to_string(), project_id.to_string());
        inner.window_intents.insert(
            label.to_string(),
            WindowOpenIntent::Project {
                project_id: project_id.to_string(),
            },
        );
    }

    fn project_window_label(&self, project_id: &str) -> Option<String> {
        self.inner
            .lock()
            .expect("app window mutex poisoned")
            .project_windows
            .get(project_id)
            .cloned()
    }

    fn focus_window(&self, label: &str) {
        self.inner
            .lock()
            .expect("app window mutex poisoned")
            .last_focused_window = Some(label.to_string());
    }

    fn last_focused_window(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("app window mutex poisoned")
            .last_focused_window
            .clone()
    }

    fn intent_for_window(&self, label: &str) -> Option<WindowOpenIntent> {
        self.inner
            .lock()
            .expect("app window mutex poisoned")
            .window_intents
            .get(label)
            .cloned()
    }

    fn release_window_project(&self, label: &str) {
        let mut inner = self.inner.lock().expect("app window mutex poisoned");
        if let Some(project_id) = inner.window_projects.remove(label) {
            if inner.project_windows.get(&project_id) == Some(&label.to_string()) {
                inner.project_windows.remove(&project_id);
            }
        }
        inner
            .window_intents
            .insert(label.to_string(), WindowOpenIntent::Home);
    }

    fn remove_window(&self, label: &str) {
        let mut inner = self.inner.lock().expect("app window mutex poisoned");
        if let Some(project_id) = inner.window_projects.remove(label) {
            if inner.project_windows.get(&project_id) == Some(&label.to_string()) {
                inner.project_windows.remove(&project_id);
            }
        }
        inner.window_intents.remove(label);
        if inner.last_focused_window.as_deref() == Some(label) {
            inner.last_focused_window = None;
        }
    }
}

#[tauri::command]
pub fn new_project_window(app: AppHandle) -> Result<(), AppError> {
    open_home_window(&app).map(|_| ())
}

#[tauri::command]
pub fn open_project_window(app: AppHandle, project_id: String) -> Result<(), AppError> {
    open_or_focus_project_window(&app, &project_id).map(|_| ())
}

#[tauri::command]
pub fn get_window_open_intent(
    state: tauri::State<'_, AppWindowState>,
    window: Window,
) -> Option<WindowOpenIntent> {
    state.intent_for_window(window.label())
}

#[tauri::command]
pub fn release_current_project_window(state: tauri::State<'_, AppWindowState>, window: Window) {
    state.release_window_project(window.label());
}

pub fn build_initial_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    build_app_menu(app, RecentProjectsMode::Skip)
}

fn build_app_menu(
    app: &AppHandle,
    recent_projects_mode: RecentProjectsMode,
) -> tauri::Result<Menu<tauri::Wry>> {
    let default_menu = Menu::default(app)?;
    let menu = Menu::new(app)?;
    let file = build_file_menu(app, recent_projects_mode)?;
    let mut file_inserted = false;

    for item in default_menu.items()? {
        if is_file_submenu(&item) {
            menu.append(&file)?;
            file_inserted = true;
        } else {
            menu.append(&item)?;
        }
    }

    if !file_inserted {
        menu.prepend(&file)?;
    }

    Ok(menu)
}

#[derive(Debug, Clone, Copy)]
enum RecentProjectsMode {
    Load,
    Skip,
}

fn build_file_menu(
    app: &AppHandle,
    recent_projects_mode: RecentProjectsMode,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let file = Submenu::new(app, "File", true)?;

    file.append(&MenuItem::with_id(
        app,
        MENU_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?)?;
    file.append(&MenuItem::with_id(
        app,
        MENU_OPEN_FOLDER,
        "Open Folder...",
        true,
        Some("CmdOrCtrl+O"),
    )?)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;

    let open_recent = Submenu::new(app, "Open Recent", true)?;
    let recent_projects = match recent_projects_mode {
        RecentProjectsMode::Load => recent_projects(app).unwrap_or_else(|error| {
            tracing::warn!("failed to read recent projects for app menu: {error}");
            Vec::new()
        }),
        RecentProjectsMode::Skip => Vec::new(),
    };
    if recent_projects.is_empty() {
        open_recent.append(&MenuItem::with_id(
            app,
            format!("{MENU_OPEN_RECENT_PREFIX}empty"),
            "No Recent Projects",
            false,
            None::<&str>,
        )?)?;
    } else {
        for project in recent_projects {
            open_recent.append(&MenuItem::with_id(
                app,
                format!("{MENU_OPEN_RECENT_PREFIX}{}", project.id),
                project.label,
                true,
                None::<&str>,
            )?)?;
        }
    }
    file.append(&open_recent)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&PredefinedMenuItem::close_window(
        app,
        Some("Close Window"),
    )?)?;

    #[cfg(not(target_os = "macos"))]
    file.append(&PredefinedMenuItem::quit(app, Some("Quit Svode"))?)?;

    Ok(file)
}

fn is_file_submenu(item: &MenuItemKind<tauri::Wry>) -> bool {
    item.as_submenu()
        .and_then(|submenu| submenu.text().ok())
        .is_some_and(|text| text == "File")
}

pub fn rebuild_app_menu(app: &AppHandle) -> Result<(), AppError> {
    let menu = build_app_menu(app, RecentProjectsMode::Load)
        .map_err(|error| AppError::General(error.to_string()))?;
    app.set_menu(menu)
        .map(|_| ())
        .map_err(|error| AppError::General(error.to_string()))
}

pub fn register_current_project_window(app: &AppHandle, project_id: &str, window_label: &str) {
    app.state::<AppWindowState>()
        .register_project_window(project_id, window_label);
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_NEW_WINDOW => {
            if let Err(error) = open_home_window(app) {
                tracing::warn!("failed to open launcher window from menu: {error}");
            }
        }
        MENU_OPEN_FOLDER => {
            if let Err(error) = emit_open_folder_to_focused_window(app) {
                tracing::warn!("failed to emit open-folder menu event: {error}");
            }
        }
        _ if id.starts_with(MENU_OPEN_RECENT_PREFIX) => {
            let project_id = &id[MENU_OPEN_RECENT_PREFIX.len()..];
            if !project_id.is_empty() && project_id != "empty" {
                if let Err(error) = open_or_focus_project_window(app, project_id) {
                    tracing::warn!("failed to open recent project window: {error}");
                }
            }
        }
        _ => {}
    }
}

pub fn handle_window_event(app: &AppHandle, window: &Window, event: &WindowEvent) {
    let label = window.label().to_string();
    let window_state = app.state::<AppWindowState>();
    let active_state = app.state::<crate::mcp::active::ActiveProjectState>();

    match event {
        WindowEvent::Focused(true) => {
            window_state.focus_window(&label);
            active_state.focus_window(label);
        }
        WindowEvent::Destroyed => {
            window_state.remove_window(&label);
            active_state.remove_window(&label);
        }
        _ => {}
    }
}

pub fn handle_single_instance(app: &AppHandle, _args: Vec<String>, _cwd: String) {
    if let Err(error) = focus_last_window_or_open_home(app) {
        tracing::warn!("failed to handle single-instance activation: {error}");
    }
}

fn open_home_window(app: &AppHandle) -> Result<WebviewWindow, AppError> {
    let state = app.state::<AppWindowState>();
    let label = state.next_home_label();
    state.register_home_window(&label);
    build_window(app, &label, "Svode")
}

fn open_or_focus_project_window(
    app: &AppHandle,
    project_id: &str,
) -> Result<WebviewWindow, AppError> {
    let config_dir = app_config_dir(app)?;
    let sp_ref = registry::find_space(&config_dir, project_id)?
        .ok_or_else(|| AppError::SpaceNotFound(project_id.to_string()))?;
    let project_path = PathBuf::from(&sp_ref.path);
    let cfg = config::read_space_config(&project_path)?;

    let state = app.state::<AppWindowState>();
    if let Some(label) = state.project_window_label(project_id) {
        if let Some(window) = app.get_webview_window(&label) {
            focus_window(&window)?;
            return Ok(window);
        }
        state.release_window_project(&label);
    }

    let label = project_window_label(project_id);
    state.register_project_window(project_id, &label);
    build_window(app, &label, &format!("{} - Svode", cfg.name))
}

fn build_window(app: &AppHandle, label: &str, title: &str) -> Result<WebviewWindow, AppError> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title(title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .decorations(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0));

    #[cfg(windows)]
    let builder = builder.drag_and_drop(false);

    let window = builder
        .focused(true)
        .build()
        .map_err(|error| AppError::General(error.to_string()))?;
    focus_window(&window)?;
    Ok(window)
}

fn focus_window(window: &WebviewWindow) -> Result<(), AppError> {
    window
        .show()
        .map_err(|error| AppError::General(error.to_string()))?;
    window
        .set_focus()
        .map_err(|error| AppError::General(error.to_string()))
}

fn focus_last_window_or_open_home(app: &AppHandle) -> Result<(), AppError> {
    if let Some(label) = app.state::<AppWindowState>().last_focused_window() {
        if let Some(window) = app.get_webview_window(&label) {
            return focus_window(&window);
        }
    }

    if let Some(window) = app.webview_windows().into_values().next() {
        return focus_window(&window);
    }

    open_home_window(app).map(|_| ())
}

fn emit_open_folder_to_focused_window(app: &AppHandle) -> Result<(), AppError> {
    if let Some(label) = app.state::<AppWindowState>().last_focused_window() {
        if let Some(window) = app.get_webview_window(&label) {
            focus_window(&window)?;
            return window
                .emit(EVENT_OPEN_FOLDER, ())
                .map_err(|error| AppError::General(error.to_string()));
        }
    }

    let window = open_home_window(app)?;
    window
        .emit(EVENT_OPEN_FOLDER, ())
        .map_err(|error| AppError::General(error.to_string()))
}

fn app_config_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map_err(|error| AppError::General(error.to_string()))
}

struct RecentProject {
    id: String,
    label: String,
    last_opened: Option<String>,
}

fn recent_projects(app: &AppHandle) -> Result<Vec<RecentProject>, AppError> {
    let config_dir = app_config_dir(app)?;
    let reg = registry::read_registry(&config_dir)?;
    let mut projects = reg
        .spaces
        .iter()
        .filter_map(|entry| recent_project_from_entry(entry).ok())
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| {
        b.last_opened
            .cmp(&a.last_opened)
            .then_with(|| a.label.cmp(&b.label))
    });
    Ok(projects)
}

fn recent_project_from_entry(entry: &RegistryEntry) -> Result<RecentProject, AppError> {
    let cfg = config::read_space_config(Path::new(&entry.path))?;
    let label = format!("{} {}", cfg.icon, cfg.name);
    Ok(RecentProject {
        id: entry.id.clone(),
        label,
        last_opened: entry.last_opened.clone(),
    })
}

fn project_window_label(project_id: &str) -> String {
    let safe = project_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("project-{safe}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaps_window_when_current_window_opens_another_project() {
        let state = AppWindowState::new();
        state.register_project_window("project-a", "main");
        state.register_project_window("project-b", "main");

        assert_eq!(state.project_window_label("project-a"), None);
        assert_eq!(
            state.project_window_label("project-b"),
            Some("main".to_string())
        );
    }

    #[test]
    fn release_window_project_removes_project_focus_target() {
        let state = AppWindowState::new();
        state.register_project_window("project-a", "project-project-a");
        state.release_window_project("project-project-a");

        assert_eq!(state.project_window_label("project-a"), None);
        assert!(matches!(
            state.intent_for_window("project-project-a"),
            Some(WindowOpenIntent::Home)
        ));
    }

    #[test]
    fn serializes_project_intent_with_camel_case_project_id() {
        let intent = WindowOpenIntent::Project {
            project_id: "project-a".to_string(),
        };

        let value = serde_json::to_value(intent).expect("serialize intent");

        assert_eq!(
            value,
            serde_json::json!({
                "kind": "project",
                "projectId": "project-a"
            })
        );
    }
}
