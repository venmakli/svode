use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window, WindowEvent,
};

use crate::error::AppError;
use crate::navigation::NavigationItem;
use crate::space::{
    config, registry,
    types::{LastView, RegistryEntry, SpaceRegistry},
};

const MENU_NEW_WINDOW: &str = "app:new-window";
const MENU_OPEN_FOLDER: &str = "app:open-folder";
const MENU_OPEN_RECENT_PREFIX: &str = "app:open-recent:";
const EVENT_OPEN_FOLDER: &str = "app-menu:open-folder";
const EVENT_PROJECT_WINDOWS_CHANGED: &str = "app-windows:projects-changed";
const EVENT_PROJECT_REQUEST: &str = "app-windows:project-request";
const DEFAULT_WINDOW_WIDTH: f64 = 1200.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 800.0;
const MIN_WINDOW_WIDTH: f64 = 800.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowOpenIntent {
    Home,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

/// What the window of a project does for an action started in another window:
/// the window comes forward and, for an object or a new chat, opens it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectWindowRequest {
    Focus,
    NewChat,
    Open { item: NavigationItem },
}

/// The view a window keeps after it takes a project: the Space of the project,
/// or Home working with it as the active project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowView {
    Home,
    Project,
}

/// How a window stands to a project it is about to take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowBinding {
    /// Another window has the project; the action goes to that window.
    OtherWindow(String),
    /// The window already serves the project; its runtime keeps running.
    Unchanged,
    /// The window takes the project; the runtime of its previous project stops.
    Bound { previous: Option<String> },
}

#[derive(Default)]
pub struct AppWindowState {
    inner: Mutex<AppWindowStateInner>,
}

/// `project_windows` holds the window of each project, including a project
/// window still loading; `window_projects` holds the project each window
/// serves with a running project runtime.
#[derive(Default)]
struct AppWindowStateInner {
    project_windows: HashMap<String, String>,
    window_projects: HashMap<String, String>,
    window_intents: HashMap<String, WindowOpenIntent>,
    last_focused_window: Option<String>,
    remembered_view: Option<LastView>,
    next_home_window: u64,
}

impl AppWindowStateInner {
    fn binding_for(&self, label: &str, project_id: &str) -> WindowBinding {
        if self.window_projects.get(label).map(String::as_str) == Some(project_id) {
            return WindowBinding::Unchanged;
        }
        match self.project_windows.get(project_id) {
            Some(owner) if owner != label => WindowBinding::OtherWindow(owner.clone()),
            _ => WindowBinding::Bound {
                previous: self.window_projects.get(label).cloned(),
            },
        }
    }

    fn set_view(&mut self, label: &str, project_id: &str, view: WindowView) {
        let intent = match view {
            WindowView::Home => WindowOpenIntent::Home,
            WindowView::Project => WindowOpenIntent::Project {
                project_id: project_id.to_string(),
            },
        };
        self.window_intents.insert(label.to_string(), intent);
    }

    fn release_window(&mut self, label: &str) -> Option<String> {
        self.project_windows.retain(|_, owner| owner != label);
        self.window_projects.remove(label)
    }
}

impl AppWindowState {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AppWindowStateInner> {
        self.inner.lock().expect("app window mutex poisoned")
    }

    fn next_home_label(&self) -> String {
        let mut inner = self.lock();
        inner.next_home_window += 1;
        format!("launcher-{}", inner.next_home_window)
    }

    fn register_home_window(&self, label: &str) {
        let mut inner = self.lock();
        inner
            .window_intents
            .insert(label.to_string(), WindowOpenIntent::Home);
        inner.window_projects.remove(label);
    }

    /// Reserves the project for a project window that is still loading; the
    /// window takes it with its runtime when its webview opens the project.
    fn reserve_project_window(&self, project_id: &str, label: &str) {
        let mut inner = self.lock();
        inner
            .project_windows
            .insert(project_id.to_string(), label.to_string());
        inner.set_view(label, project_id, WindowView::Project);
    }

    /// How the window stands to the project, without changing anything.
    fn binding_for(&self, label: &str, project_id: &str) -> WindowBinding {
        self.lock().binding_for(label, project_id)
    }

    /// Binds the project to the window and sets the window view, unless another
    /// window has the project: then nothing changes.
    fn bind_project(&self, label: &str, project_id: &str, view: WindowView) -> WindowBinding {
        let mut inner = self.lock();
        let binding = inner.binding_for(label, project_id);
        if matches!(binding, WindowBinding::OtherWindow(_)) {
            return binding;
        }
        if let WindowBinding::Bound {
            previous: Some(previous),
        } = &binding
            && inner.project_windows.get(previous).map(String::as_str) == Some(label)
        {
            inner.project_windows.remove(previous);
        }
        inner
            .project_windows
            .insert(project_id.to_string(), label.to_string());
        inner
            .window_projects
            .insert(label.to_string(), project_id.to_string());
        inner.set_view(label, project_id, view);
        binding
    }

    /// Shows Home in the window; its project stays bound as the active project.
    fn show_home(&self, label: &str) {
        self.lock()
            .window_intents
            .insert(label.to_string(), WindowOpenIntent::Home);
    }

    fn project_window_label(&self, project_id: &str) -> Option<String> {
        self.lock().project_windows.get(project_id).cloned()
    }

    fn projects_in_other_windows(&self, label: &str) -> Vec<String> {
        let mut projects = self
            .lock()
            .project_windows
            .iter()
            .filter(|(_, owner)| owner.as_str() != label)
            .map(|(project_id, _)| project_id.clone())
            .collect::<Vec<_>>();
        projects.sort();
        projects
    }

    fn focus_window(&self, label: &str) {
        self.lock().last_focused_window = Some(label.to_string());
    }

    fn last_focused_window(&self) -> Option<String> {
        self.lock().last_focused_window.clone()
    }

    /// The view of the focused window when it is not the remembered last view
    /// yet; the caller stores it in the registry.
    fn view_to_remember(&self) -> Option<LastView> {
        let mut inner = self.lock();
        let label = inner.last_focused_window.as_ref()?;
        let view = match inner.window_intents.get(label)? {
            WindowOpenIntent::Home => LastView::Home,
            WindowOpenIntent::Project { project_id } => LastView::Project {
                project_id: project_id.clone(),
            },
        };
        if inner.remembered_view.as_ref() == Some(&view) {
            return None;
        }
        inner.remembered_view = Some(view.clone());
        Some(view)
    }

    fn intent_for_window(&self, label: &str) -> Option<WindowOpenIntent> {
        self.lock().window_intents.get(label).cloned()
    }

    /// Frees the window of a project removed from the list; a window showing
    /// its Space falls back to Home.
    fn release_project(&self, project_id: &str) -> bool {
        let mut inner = self.lock();
        let Some(label) = inner.project_windows.remove(project_id) else {
            return false;
        };
        if inner.window_projects.get(&label).map(String::as_str) == Some(project_id) {
            inner.window_projects.remove(&label);
        }
        if matches!(
            inner.window_intents.get(&label),
            Some(WindowOpenIntent::Project { project_id: id }) if id == project_id
        ) {
            inner.window_intents.insert(label, WindowOpenIntent::Home);
        }
        true
    }

    fn release_stale_window(&self, label: &str) -> Option<String> {
        let mut inner = self.lock();
        inner
            .window_intents
            .insert(label.to_string(), WindowOpenIntent::Home);
        inner.release_window(label)
    }

    /// Forgets a closed window and returns the project whose runtime it served.
    fn remove_window(&self, label: &str) -> (Option<String>, bool) {
        let mut inner = self.lock();
        let had_projects = inner.project_windows.values().any(|owner| owner == label);
        let released = inner.release_window(label);
        inner.window_intents.remove(label);
        if inner.last_focused_window.as_deref() == Some(label) {
            inner.last_focused_window = None;
        }
        (released, had_projects)
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

/// The view of the window; the first window of a launch, opened without one,
/// takes the last view: Home stays its view, a project is opened by its webview.
#[tauri::command]
pub fn get_window_open_intent(app: AppHandle, window: Window) -> WindowOpenIntent {
    let state = app.state::<AppWindowState>();
    if let Some(intent) = state.intent_for_window(window.label()) {
        return intent;
    }
    let intent = match app_config_dir(&app).and_then(|dir| registry::read_registry(&dir)) {
        Ok(registry) => launch_intent(&registry, |entry| {
            config::read_space_config(Path::new(&entry.path)).is_ok()
        }),
        Err(error) => {
            tracing::warn!("failed to read the last view for the launch: {error}");
            WindowOpenIntent::Home
        }
    };
    if matches!(intent, WindowOpenIntent::Home) {
        state.show_home(window.label());
        remember_last_view(&app);
    }
    intent
}

/// The last view when its project is still listed and available, else Home. A
/// registry without a known last view launches into the last active project.
fn launch_intent(
    registry: &SpaceRegistry,
    is_available: impl Fn(&RegistryEntry) -> bool,
) -> WindowOpenIntent {
    let project_id = match &registry.last_view {
        Some(LastView::Home) => None,
        Some(LastView::Project { project_id }) => Some(project_id),
        Some(LastView::Unknown) | None => registry.last_active.as_ref(),
    };
    project_id
        .and_then(|id| registry.spaces.iter().find(|entry| &entry.id == id))
        .filter(|entry| is_available(entry))
        .map_or(WindowOpenIntent::Home, |entry| WindowOpenIntent::Project {
            project_id: entry.id.clone(),
        })
}

#[tauri::command]
pub fn show_home_in_current_window(app: AppHandle, window: Window) {
    app.state::<AppWindowState>().show_home(window.label());
    remember_last_view(&app);
}

/// Stores the view of the focused window as the last view when it changed.
fn remember_last_view(app: &AppHandle) {
    let Some(view) = app.state::<AppWindowState>().view_to_remember() else {
        return;
    };
    if let Err(error) = app_config_dir(app).and_then(|dir| registry::update_last_view(&dir, view)) {
        tracing::warn!("failed to remember the last view: {error}");
    }
}

/// Projects bound to windows other than the calling one; the set changes with
/// `app-windows:projects-changed`.
#[tauri::command]
pub fn list_projects_in_other_windows(
    state: tauri::State<'_, AppWindowState>,
    window: Window,
) -> Vec<String> {
    state.projects_in_other_windows(window.label())
}

#[tauri::command]
pub fn set_current_window_title(window: WebviewWindow, title: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        return set_macos_window_title(window, title);
    }

    #[cfg(not(target_os = "macos"))]
    window
        .set_title(&title)
        .map_err(|error| AppError::General(error.to_string()))
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
        None::<&str>,
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

/// How the window stands to the project; a window that closed without its
/// destroy event no longer holds the project.
pub fn window_binding(app: &AppHandle, window_label: &str, project_id: &str) -> WindowBinding {
    let state = app.state::<AppWindowState>();
    let binding = state.binding_for(window_label, project_id);
    if let WindowBinding::OtherWindow(owner) = &binding
        && app.get_webview_window(owner).is_none()
    {
        if let Some(released) = state.release_stale_window(owner) {
            stop_project_runtime(app, &released);
        }
        emit_project_windows_changed(app);
        return state.binding_for(window_label, project_id);
    }
    binding
}

/// Binds the project to the window and stops the runtime of the project the
/// window served before; the caller starts the runtime of a newly bound project.
pub fn bind_window_project(
    app: &AppHandle,
    window_label: &str,
    project_id: &str,
    view: WindowView,
) -> WindowBinding {
    let binding = app
        .state::<AppWindowState>()
        .bind_project(window_label, project_id, view);
    if let WindowBinding::Bound { previous } = &binding {
        if let Some(previous) = previous {
            stop_project_runtime(app, previous);
        }
        emit_project_windows_changed(app);
    }
    remember_last_view(app);
    binding
}

/// Stops a project runtime that finished starting after its window had moved
/// on to another project or closed.
pub fn stop_runtime_unless_served(app: &AppHandle, project_id: &str) {
    if app
        .state::<AppWindowState>()
        .project_window_label(project_id)
        .is_none()
    {
        stop_project_runtime(app, project_id);
    }
}

/// Brings the window of the project forward and hands it the action.
pub fn hand_off_to_project_window(
    app: &AppHandle,
    owner_label: &str,
    request: &ProjectWindowRequest,
) -> Result<(), AppError> {
    let window = app
        .get_webview_window(owner_label)
        .ok_or_else(|| AppError::General(format!("window {owner_label} is closed")))?;
    focus_window(&window)?;
    if !matches!(request, ProjectWindowRequest::Focus) {
        app.emit_to(
            EventTarget::window(owner_label),
            EVENT_PROJECT_REQUEST,
            request,
        )
        .map_err(|error| AppError::General(error.to_string()))?;
    }
    Ok(())
}

/// Frees the window of a project removed from the list.
pub fn release_project_window(app: &AppHandle, project_id: &str) {
    if app.state::<AppWindowState>().release_project(project_id) {
        emit_project_windows_changed(app);
        remember_last_view(app);
    }
}

fn emit_project_windows_changed(app: &AppHandle) {
    if let Err(error) = app.emit(EVENT_PROJECT_WINDOWS_CHANGED, ()) {
        tracing::warn!("failed to emit project windows change: {error}");
    }
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
            remember_last_view(app);
        }
        WindowEvent::Destroyed => {
            let (released, had_projects) = window_state.remove_window(&label);
            if let Some(project_id) = released {
                stop_project_runtime(app, &project_id);
            }
            if had_projects {
                emit_project_windows_changed(app);
            }
            active_state.remove_window(&label);
            app.state::<crate::agent_runtime::AgentRuntimeState>()
                .release_webview(&label);
            if let Some(connections) = app
                .try_state::<std::sync::Arc<crate::agent_runtime::connections::AgentConnections>>()
            {
                connections.release_webview(&label);
            }
            crate::speech::commands::release_webview(app, &label);
        }
        _ => {}
    }
}

fn stop_project_runtime(app: &AppHandle, project_id: &str) {
    let Ok(config_dir) = app_config_dir(app) else {
        return;
    };
    let Ok(Some(project)) = registry::find_space(&config_dir, project_id) else {
        return;
    };
    app.state::<crate::apps::AppProcessState>()
        .stop_project(Path::new(&project.path));
    let app = app.clone();
    let project_path = PathBuf::from(project.path);
    tauri::async_runtime::spawn(async move {
        app.state::<crate::project_runtime::ProjectRuntimeState>()
            .close_project(&app, &project_path)
            .await;
    });
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
        if let Some(released) = state.release_stale_window(&label) {
            stop_project_runtime(app, &released);
        }
    }

    let label = project_window_label(project_id);
    state.reserve_project_window(project_id, &label);
    emit_project_windows_changed(app);
    build_window(app, &label, &format!("{} - Svode", cfg.name))
}

fn build_window(app: &AppHandle, label: &str, title: &str) -> Result<WebviewWindow, AppError> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title(title)
        .inner_size(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .decorations(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0))
        // Keep WebKit's DOM drag lifecycle available for Plate and sidebar
        // resources. External file paths are read from NSDragPboard instead.
        .disable_drag_drop_handler();

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

#[cfg(target_os = "macos")]
fn set_macos_window_title(window: WebviewWindow, title: String) -> Result<(), AppError> {
    // Keep the title change and inset redraw in one main-thread callback.
    // Tao's asynchronous set_title can otherwise reset the inset afterward:
    // https://github.com/tauri-apps/tauri/issues/13044
    window
        .with_webview(move |webview| unsafe {
            use objc2_app_kit::{NSView, NSWindow};
            use objc2_foundation::NSString;

            // SAFETY: Tauri executes with_webview on the main thread and keeps
            // these AppKit handles alive for the duration of the callback.
            // WKWebView is an NSView subclass, so the superclass cast is valid.
            let ns_window = &*webview.ns_window().cast::<NSWindow>();
            ns_window.setTitle(&NSString::from_str(&title));

            let wk_webview = &*webview.inner().cast::<NSView>();
            let Some(parent_view) = wk_webview.superview() else {
                tracing::warn!(
                    "failed to reapply macOS traffic light position: parent view missing"
                );
                return;
            };

            // Wry stores the configured traffic-light inset on this parent view
            // and reapplies it from drawRect. Force the same draw path that a
            // native window resize triggers after AppKit has laid out the titlebar.
            parent_view.setNeedsDisplay(true);
            parent_view.displayIfNeeded();
        })
        .map_err(|error| AppError::General(error.to_string()))
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

    fn is_home(state: &AppWindowState, label: &str) -> bool {
        matches!(state.intent_for_window(label), Some(WindowOpenIntent::Home))
    }

    #[test]
    fn opening_another_project_in_a_window_rebinds_it_and_stops_the_previous() {
        let state = AppWindowState::new();
        state.bind_project("main", "project-a", WindowView::Project);

        let binding = state.bind_project("main", "project-b", WindowView::Project);

        assert_eq!(
            binding,
            WindowBinding::Bound {
                previous: Some("project-a".to_string())
            }
        );
        assert_eq!(state.project_window_label("project-a"), None);
        assert_eq!(
            state.project_window_label("project-b"),
            Some("main".to_string())
        );
    }

    #[test]
    fn home_activation_binds_the_project_and_keeps_the_home_view() {
        let state = AppWindowState::new();
        state.register_home_window("launcher-1");

        let binding = state.bind_project("launcher-1", "project-a", WindowView::Home);

        assert_eq!(binding, WindowBinding::Bound { previous: None });
        assert!(is_home(&state, "launcher-1"));
        assert_eq!(
            state.project_window_label("project-a"),
            Some("launcher-1".to_string())
        );
    }

    #[test]
    fn home_activation_of_another_project_stops_the_previous_and_stays_home() {
        let state = AppWindowState::new();
        state.register_home_window("launcher-1");
        state.bind_project("launcher-1", "project-a", WindowView::Home);

        let binding = state.bind_project("launcher-1", "project-b", WindowView::Home);

        assert_eq!(
            binding,
            WindowBinding::Bound {
                previous: Some("project-a".to_string())
            }
        );
        assert!(is_home(&state, "launcher-1"));
        assert_eq!(state.project_window_label("project-a"), None);
    }

    #[test]
    fn going_home_from_a_space_keeps_the_project_bound_without_restart() {
        let state = AppWindowState::new();
        state.bind_project("main", "project-a", WindowView::Project);

        state.show_home("main");

        assert!(is_home(&state, "main"));
        assert_eq!(
            state.project_window_label("project-a"),
            Some("main".to_string())
        );
        assert_eq!(
            state.bind_project("main", "project-a", WindowView::Home),
            WindowBinding::Unchanged
        );
        assert_eq!(
            state.bind_project("main", "project-a", WindowView::Project),
            WindowBinding::Unchanged
        );
        assert!(matches!(
            state.intent_for_window("main"),
            Some(WindowOpenIntent::Project { project_id }) if project_id == "project-a"
        ));
    }

    #[test]
    fn a_project_of_another_window_is_not_rebound() {
        let state = AppWindowState::new();
        state.bind_project("project-project-a", "project-a", WindowView::Project);
        state.register_home_window("launcher-1");
        state.bind_project("launcher-1", "project-b", WindowView::Home);

        for view in [WindowView::Home, WindowView::Project] {
            assert_eq!(
                state.bind_project("launcher-1", "project-a", view),
                WindowBinding::OtherWindow("project-project-a".to_string())
            );
        }
        assert_eq!(
            state.project_window_label("project-a"),
            Some("project-project-a".to_string())
        );
        assert_eq!(
            state.project_window_label("project-b"),
            Some("launcher-1".to_string())
        );
        assert!(is_home(&state, "launcher-1"));
    }

    #[test]
    fn a_loading_project_window_holds_its_project_until_it_opens_it() {
        let state = AppWindowState::new();
        state.reserve_project_window("project-a", "project-project-a");

        assert_eq!(
            state.binding_for("launcher-1", "project-a"),
            WindowBinding::OtherWindow("project-project-a".to_string())
        );
        assert_eq!(
            state.bind_project("project-project-a", "project-a", WindowView::Project),
            WindowBinding::Bound { previous: None }
        );
        assert_eq!(
            state.binding_for("project-project-a", "project-a"),
            WindowBinding::Unchanged
        );
    }

    #[test]
    fn projects_in_other_windows_exclude_the_calling_window() {
        let state = AppWindowState::new();
        state.bind_project("launcher-1", "project-a", WindowView::Home);
        state.bind_project("project-project-b", "project-b", WindowView::Project);
        state.reserve_project_window("project-c", "project-project-c");

        assert_eq!(
            state.projects_in_other_windows("launcher-1"),
            vec!["project-b".to_string(), "project-c".to_string()]
        );
        assert_eq!(
            state.projects_in_other_windows("project-project-b"),
            vec!["project-a".to_string(), "project-c".to_string()]
        );
    }

    #[test]
    fn closing_a_window_frees_its_project() {
        let state = AppWindowState::new();
        state.bind_project("launcher-1", "project-a", WindowView::Home);
        state.focus_window("launcher-1");

        let (released, had_projects) = state.remove_window("launcher-1");

        assert_eq!(released, Some("project-a".to_string()));
        assert!(had_projects);
        assert_eq!(state.project_window_label("project-a"), None);
        assert_eq!(state.last_focused_window(), None);
        assert_eq!(
            state.bind_project("launcher-2", "project-a", WindowView::Home),
            WindowBinding::Bound { previous: None }
        );
    }

    #[test]
    fn closing_a_loading_project_window_frees_its_reservation() {
        let state = AppWindowState::new();
        state.reserve_project_window("project-a", "project-project-a");

        assert_eq!(state.remove_window("project-project-a"), (None, true));
        assert_eq!(state.project_window_label("project-a"), None);
    }

    #[test]
    fn removing_a_project_from_the_list_frees_its_window() {
        let state = AppWindowState::new();
        state.bind_project("project-project-a", "project-a", WindowView::Project);
        state.bind_project("launcher-1", "project-b", WindowView::Home);

        assert!(state.release_project("project-a"));
        assert!(state.release_project("project-b"));
        assert!(!state.release_project("project-c"));

        assert!(is_home(&state, "project-project-a"));
        assert!(is_home(&state, "launcher-1"));
        assert_eq!(
            state.binding_for("launcher-1", "project-b"),
            WindowBinding::Bound { previous: None }
        );
    }

    #[test]
    fn a_stale_window_releases_the_project_it_served() {
        let state = AppWindowState::new();
        state.bind_project("project-project-a", "project-a", WindowView::Project);

        assert_eq!(
            state.release_stale_window("project-project-a"),
            Some("project-a".to_string())
        );
        assert_eq!(state.project_window_label("project-a"), None);
    }

    fn project_view(project_id: &str) -> LastView {
        LastView::Project {
            project_id: project_id.to_string(),
        }
    }

    #[test]
    fn a_focused_window_gives_its_view_once() {
        let state = AppWindowState::new();
        state.register_home_window("launcher-1");

        state.focus_window("launcher-1");

        assert_eq!(state.view_to_remember(), Some(LastView::Home));
        assert_eq!(state.view_to_remember(), None);
    }

    #[test]
    fn the_focused_window_changing_its_view_gives_the_new_view() {
        let state = AppWindowState::new();
        state.register_home_window("launcher-1");
        state.focus_window("launcher-1");
        state.view_to_remember();

        state.bind_project("launcher-1", "project-a", WindowView::Project);
        assert_eq!(state.view_to_remember(), Some(project_view("project-a")));

        state.show_home("launcher-1");
        assert_eq!(state.view_to_remember(), Some(LastView::Home));
    }

    #[test]
    fn home_activation_keeps_the_last_view_home() {
        let state = AppWindowState::new();
        state.register_home_window("launcher-1");
        state.focus_window("launcher-1");
        state.view_to_remember();

        state.bind_project("launcher-1", "project-a", WindowView::Home);
        state.bind_project("launcher-1", "project-b", WindowView::Home);

        assert_eq!(state.view_to_remember(), None);
    }

    #[test]
    fn the_window_focused_last_wins_over_later_changes_in_other_windows() {
        let state = AppWindowState::new();
        state.bind_project("project-project-a", "project-a", WindowView::Project);
        state.register_home_window("launcher-1");
        state.focus_window("launcher-1");
        assert_eq!(state.view_to_remember(), Some(LastView::Home));

        state.focus_window("project-project-a");
        assert_eq!(state.view_to_remember(), Some(project_view("project-a")));

        state.bind_project("launcher-1", "project-b", WindowView::Project);
        assert_eq!(state.view_to_remember(), None);
    }

    #[test]
    fn closing_the_focused_window_keeps_its_view_as_the_last_view() {
        let state = AppWindowState::new();
        state.bind_project("project-project-a", "project-a", WindowView::Project);
        state.focus_window("project-project-a");
        state.view_to_remember();

        state.remove_window("project-project-a");

        assert_eq!(state.view_to_remember(), None);
    }

    #[test]
    fn a_window_without_a_view_gives_nothing_to_remember() {
        let state = AppWindowState::new();
        state.focus_window("main");

        assert_eq!(state.view_to_remember(), None);
    }

    fn registry(last_active: Option<&str>, last_view: Option<LastView>) -> SpaceRegistry {
        SpaceRegistry {
            spaces: ["project-a", "project-b", "missing"]
                .into_iter()
                .map(|id| RegistryEntry {
                    id: id.to_string(),
                    last_opened: None,
                    path: format!("/{id}"),
                })
                .collect(),
            last_active: last_active.map(str::to_string),
            last_view,
        }
    }

    fn launch(registry: &SpaceRegistry) -> Option<String> {
        match launch_intent(registry, |entry| entry.id != "missing") {
            WindowOpenIntent::Home => None,
            WindowOpenIntent::Project { project_id } => Some(project_id),
        }
    }

    #[test]
    fn the_launch_opens_the_last_view() {
        assert_eq!(
            launch(&registry(Some("project-a"), Some(LastView::Home))),
            None
        );
        assert_eq!(
            launch(&registry(
                Some("project-a"),
                Some(project_view("project-b"))
            )),
            Some("project-b".to_string())
        );
    }

    #[test]
    fn a_removed_or_unavailable_last_project_launches_home() {
        assert_eq!(launch(&registry(None, Some(project_view("removed")))), None);
        assert_eq!(
            launch(&registry(Some("project-a"), Some(project_view("missing")))),
            None
        );
    }

    #[test]
    fn a_registry_without_a_known_last_view_launches_the_last_active_project() {
        assert_eq!(
            launch(&registry(Some("project-a"), None)),
            Some("project-a".to_string())
        );
        assert_eq!(
            launch(&registry(Some("project-b"), Some(LastView::Unknown))),
            Some("project-b".to_string())
        );
        assert_eq!(launch(&registry(None, None)), None);
    }

    #[test]
    fn serializes_project_window_requests_for_the_target_window() {
        let open: ProjectWindowRequest = serde_json::from_value(serde_json::json!({
            "kind": "open",
            "item": {
                "key": { "kind": "page", "path": "notes/plan.md" },
                "title": "Plan"
            }
        }))
        .expect("decode open request");
        assert!(matches!(
            &open,
            ProjectWindowRequest::Open { item } if item.title == "Plan"
        ));
        assert_eq!(
            serde_json::to_value(ProjectWindowRequest::NewChat).expect("encode new chat"),
            serde_json::json!({ "kind": "newChat" })
        );
        assert_eq!(
            serde_json::from_value::<ProjectWindowRequest>(serde_json::json!({ "kind": "focus" }))
                .expect("decode focus"),
            ProjectWindowRequest::Focus
        );
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

    #[test]
    fn code_owned_window_defaults_match_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("parse Tauri config");
        let window = &config["app"]["windows"][0];

        assert_eq!(window["width"], DEFAULT_WINDOW_WIDTH);
        assert_eq!(window["height"], DEFAULT_WINDOW_HEIGHT);
        assert_eq!(window["minWidth"], MIN_WINDOW_WIDTH);
        assert_eq!(window["minHeight"], MIN_WINDOW_HEIGHT);
    }

    /// The first window takes file drops as the windows of `build_window`
    /// do on Linux: by the native handler of Tauri, which reads the paths
    /// on disk and leaves the HTML5 drags of the page to WebKitGTK.
    #[test]
    fn the_first_window_of_linux_differs_only_by_the_native_drop_handler() {
        let base: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("parse Tauri config");
        let linux: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.linux.conf.json"))
                .expect("parse Linux Tauri config");
        let mut window = base["app"]["windows"][0].clone();
        assert_eq!(window["dragDropEnabled"], false);
        window["dragDropEnabled"] = true.into();
        assert_eq!(linux, serde_json::json!({ "app": { "windows": [window] } }));
    }
}
