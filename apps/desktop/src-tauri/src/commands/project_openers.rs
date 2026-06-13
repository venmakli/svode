use std::{path::Path, path::PathBuf, process::Command};

use serde::{Deserialize, Serialize};

use crate::{AppError, system_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectOpenerId {
    Vscode,
    Cursor,
    FileManager,
    Terminal,
    Iterm2,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectOpenerKind {
    Editor,
    FileManager,
    Terminal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenerInfo {
    id: ProjectOpenerId,
    label: &'static str,
    kind: ProjectOpenerKind,
}

#[tauri::command]
pub fn list_project_openers() -> Vec<ProjectOpenerInfo> {
    let mut openers = Vec::new();

    if is_vscode_available() {
        openers.push(ProjectOpenerInfo {
            id: ProjectOpenerId::Vscode,
            label: "VS Code",
            kind: ProjectOpenerKind::Editor,
        });
    }

    if is_cursor_available() {
        openers.push(ProjectOpenerInfo {
            id: ProjectOpenerId::Cursor,
            label: "Cursor",
            kind: ProjectOpenerKind::Editor,
        });
    }

    openers.push(ProjectOpenerInfo {
        id: ProjectOpenerId::FileManager,
        label: file_manager_label(),
        kind: ProjectOpenerKind::FileManager,
    });

    if is_terminal_available() {
        openers.push(ProjectOpenerInfo {
            id: ProjectOpenerId::Terminal,
            label: terminal_label(),
            kind: ProjectOpenerKind::Terminal,
        });
    }

    if is_iterm2_available() {
        openers.push(ProjectOpenerInfo {
            id: ProjectOpenerId::Iterm2,
            label: "iTerm2",
            kind: ProjectOpenerKind::Terminal,
        });
    }

    openers
}

#[tauri::command]
pub fn open_project_in_tool(project_path: String, tool: ProjectOpenerId) -> Result<(), AppError> {
    let project_dir = resolve_project_dir(&project_path)?;

    match tool {
        ProjectOpenerId::Vscode => open_vscode(&project_dir),
        ProjectOpenerId::Cursor => open_cursor(&project_dir),
        ProjectOpenerId::FileManager => open_file_manager(&project_dir),
        ProjectOpenerId::Terminal => open_terminal(&project_dir),
        ProjectOpenerId::Iterm2 => open_iterm2(&project_dir),
    }
}

fn resolve_project_dir(project_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(project_path);
    let canonical = path
        .canonicalize()
        .map_err(|err| AppError::PathNotAccessible(format!("{project_path}: {err}")))?;

    if !canonical.is_dir() {
        return Err(AppError::PathNotAccessible(project_path.to_string()));
    }

    Ok(PathBuf::from(system_path::user_facing_path(&canonical)))
}

fn spawn(mut command: Command, label: &str) -> Result<(), AppError> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| AppError::General(format!("Failed to open {label}: {err}")))
}

fn command_available(command: &str) -> bool {
    which::which(command).is_ok()
}

#[cfg(target_os = "macos")]
fn macos_app_exists(app_name: &str) -> bool {
    let app_bundle = format!("{app_name}.app");
    let mut candidates = vec![
        PathBuf::from("/Applications").join(&app_bundle),
        PathBuf::from("/Applications/Utilities").join(&app_bundle),
        PathBuf::from("/System/Applications").join(&app_bundle),
        PathBuf::from("/System/Applications/Utilities").join(&app_bundle),
    ];

    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("Applications").join(&app_bundle));
    }

    candidates.iter().any(|path| path.exists())
}

#[cfg(not(target_os = "macos"))]
fn macos_app_exists(_app_name: &str) -> bool {
    false
}

fn is_vscode_available() -> bool {
    command_available("code") || macos_app_exists("Visual Studio Code")
}

fn is_cursor_available() -> bool {
    command_available("cursor") || macos_app_exists("Cursor")
}

fn is_iterm2_available() -> bool {
    cfg!(target_os = "macos") && (macos_app_exists("iTerm") || macos_app_exists("iTerm2"))
}

fn is_terminal_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        return macos_app_exists("Terminal") || command_available("open");
    }

    #[cfg(target_os = "windows")]
    {
        return command_available("wt")
            || command_available("pwsh")
            || command_available("powershell");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return command_available("gnome-terminal")
            || command_available("konsole")
            || command_available("xfce4-terminal")
            || command_available("x-terminal-emulator")
            || command_available("xterm");
    }

    #[allow(unreachable_code)]
    false
}

fn file_manager_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "Finder";
    }

    #[cfg(target_os = "windows")]
    {
        return "Explorer";
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return "Files";
    }

    #[allow(unreachable_code)]
    "File manager"
}

fn terminal_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        if command_available("wt") {
            return "Windows Terminal";
        }
        return "PowerShell";
    }

    #[cfg(not(target_os = "windows"))]
    {
        "Terminal"
    }
}

#[cfg(target_os = "macos")]
fn open_macos_app(app_name: &str, path: &Path, label: &str) -> Result<(), AppError> {
    let mut command = Command::new("open");
    command.arg("-a").arg(app_name).arg(path);
    spawn(command, label)
}

fn open_vscode(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if macos_app_exists("Visual Studio Code") {
            return open_macos_app("Visual Studio Code", path, "VS Code");
        }
    }

    let mut command = Command::new("code");
    command.arg(path);
    spawn(command, "VS Code")
}

fn open_cursor(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if macos_app_exists("Cursor") {
            return open_macos_app("Cursor", path, "Cursor");
        }
    }

    let mut command = Command::new("cursor");
    command.arg(path);
    spawn(command, "Cursor")
}

fn open_file_manager(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(path);
        return spawn(command, "Finder");
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(path);
        return spawn(command, "Explorer");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        return spawn(command, "Files");
    }

    #[allow(unreachable_code)]
    Err(AppError::General("No supported file manager found".into()))
}

fn open_terminal(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        return open_macos_app("Terminal", path, "Terminal");
    }

    #[cfg(target_os = "windows")]
    {
        if command_available("wt") {
            let mut command = Command::new("wt");
            command.arg("-d").arg(path);
            return spawn(command, "Windows Terminal");
        }

        let shell = if command_available("pwsh") {
            "pwsh"
        } else {
            "powershell"
        };
        let escaped_path = path.display().to_string().replace('\'', "''");
        let mut command = Command::new(shell);
        command
            .arg("-NoExit")
            .arg("-Command")
            .arg(format!("Set-Location -LiteralPath '{escaped_path}'"));
        return spawn(command, "PowerShell");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if command_available("gnome-terminal") {
            let mut command = Command::new("gnome-terminal");
            command.arg("--working-directory").arg(path);
            return spawn(command, "Terminal");
        }

        if command_available("konsole") {
            let mut command = Command::new("konsole");
            command.arg("--workdir").arg(path);
            return spawn(command, "Terminal");
        }

        if command_available("xfce4-terminal") {
            let mut command = Command::new("xfce4-terminal");
            command.arg("--working-directory").arg(path);
            return spawn(command, "Terminal");
        }

        if command_available("x-terminal-emulator") {
            let mut command = Command::new("x-terminal-emulator");
            command.current_dir(path);
            return spawn(command, "Terminal");
        }

        if command_available("xterm") {
            let mut command = Command::new("xterm");
            command.current_dir(path);
            return spawn(command, "Terminal");
        }
    }

    #[allow(unreachable_code)]
    Err(AppError::General("No supported terminal found".into()))
}

fn open_iterm2(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if macos_app_exists("iTerm") {
            return open_macos_app("iTerm", path, "iTerm2");
        }
        return open_macos_app("iTerm2", path, "iTerm2");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(AppError::General(
            "iTerm2 is only available on macOS".into(),
        ))
    }
}
