use std::{path::Path, path::PathBuf, process::Command};

use serde::{Deserialize, Serialize};

use crate::{AppError, system_path};

#[cfg(any(target_os = "windows", test))]
const VSCODE_PATH_ENV: &str = "SVODE_VSCODE_PATH";

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsProgramCandidate {
    path: PathBuf,
    source: &'static str,
}

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

/// A filesystem target whose owning workspace must be retained by an external app.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactOpenerTarget {
    pub owner_root: String,
    pub canonical_artifact_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactOpenerCapability {
    OpenWorkspaceFile,
    RevealFile,
    OpenDirectory,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenerInfo {
    id: ProjectOpenerId,
    label: &'static str,
    kind: ProjectOpenerKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactOpenerInfo {
    id: ProjectOpenerId,
    label: &'static str,
    kind: ProjectOpenerKind,
    capabilities: Vec<ArtifactOpenerCapability>,
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

/// Lists only tools whose capability contract is safe for opening an artifact.
#[tauri::command]
pub fn list_artifact_openers() -> Vec<ArtifactOpenerInfo> {
    artifact_openers_with_availability(
        is_vscode_available(),
        is_cursor_available(),
        is_terminal_available(),
        is_iterm2_available(),
    )
}

fn artifact_openers_with_availability(
    vscode_available: bool,
    cursor_available: bool,
    terminal_available: bool,
    iterm2_available: bool,
) -> Vec<ArtifactOpenerInfo> {
    let mut openers = Vec::new();

    if vscode_available {
        openers.push(ArtifactOpenerInfo {
            id: ProjectOpenerId::Vscode,
            label: "VS Code",
            kind: ProjectOpenerKind::Editor,
            capabilities: vec![ArtifactOpenerCapability::OpenWorkspaceFile],
        });
    }

    if cursor_available {
        openers.push(ArtifactOpenerInfo {
            id: ProjectOpenerId::Cursor,
            label: "Cursor",
            kind: ProjectOpenerKind::Editor,
            capabilities: vec![ArtifactOpenerCapability::OpenWorkspaceFile],
        });
    }

    openers.push(ArtifactOpenerInfo {
        id: ProjectOpenerId::FileManager,
        label: file_manager_label(),
        kind: ProjectOpenerKind::FileManager,
        capabilities: vec![ArtifactOpenerCapability::RevealFile],
    });

    if terminal_available {
        openers.push(ArtifactOpenerInfo {
            id: ProjectOpenerId::Terminal,
            label: terminal_label(),
            kind: ProjectOpenerKind::Terminal,
            capabilities: vec![ArtifactOpenerCapability::OpenDirectory],
        });
    }

    if iterm2_available {
        openers.push(ArtifactOpenerInfo {
            id: ProjectOpenerId::Iterm2,
            label: "iTerm2",
            kind: ProjectOpenerKind::Terminal,
            capabilities: vec![ArtifactOpenerCapability::OpenDirectory],
        });
    }

    openers
}

#[tauri::command]
pub fn open_artifact_in_tool(
    target: ArtifactOpenerTarget,
    tool: ProjectOpenerId,
) -> Result<(), AppError> {
    // Re-resolve immediately before spawning: a discovered alias may have gone stale
    // or changed its canonical target since the Agent Context snapshot was produced.
    let (owner_root, artifact_path) = resolve_artifact_target(&target)?;

    match tool {
        ProjectOpenerId::Vscode => open_vscode_workspace_file(&owner_root, &artifact_path),
        ProjectOpenerId::FileManager => reveal_file(&artifact_path),
        ProjectOpenerId::Terminal => open_terminal(&owner_root),
        ProjectOpenerId::Iterm2 => open_iterm2(&owner_root),
        ProjectOpenerId::Cursor => open_cursor_workspace_file(&owner_root, &artifact_path),
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

fn resolve_artifact_target(target: &ArtifactOpenerTarget) -> Result<(PathBuf, PathBuf), AppError> {
    let owner_root = canonicalize_accessible_path(&target.owner_root)?;
    if !owner_root.is_dir() {
        return Err(AppError::PathNotAccessible(target.owner_root.clone()));
    }

    let artifact_path = canonicalize_accessible_path(&target.canonical_artifact_path)?;
    if !artifact_path.is_file() {
        return Err(AppError::PathNotAccessible(
            target.canonical_artifact_path.clone(),
        ));
    }

    if !artifact_path.starts_with(&owner_root) {
        return Err(AppError::PathNotAccessible(format!(
            "artifact is outside its owner root: {}",
            target.canonical_artifact_path
        )));
    }

    Ok((owner_root, artifact_path))
}

fn canonicalize_accessible_path(path: &str) -> Result<PathBuf, AppError> {
    PathBuf::from(path)
        .canonicalize()
        .map_err(|err| AppError::PathNotAccessible(format!("{path}: {err}")))
}

fn vscode_workspace_file_args(owner_root: &Path, artifact_path: &Path) -> Vec<PathBuf> {
    workspace_file_args(owner_root, artifact_path)
}

fn cursor_workspace_file_args(owner_root: &Path, artifact_path: &Path) -> Vec<PathBuf> {
    workspace_file_args(owner_root, artifact_path)
}

fn workspace_file_args(owner_root: &Path, artifact_path: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("--new-window"),
        owner_root.to_path_buf(),
        artifact_path.to_path_buf(),
    ]
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

#[cfg(any(target_os = "windows", test))]
fn push_windows_candidate(
    candidates: &mut Vec<WindowsProgramCandidate>,
    path: PathBuf,
    source: &'static str,
) {
    if path.as_os_str().is_empty() || candidates.iter().any(|candidate| candidate.path == path) {
        return;
    }

    candidates.push(WindowsProgramCandidate { path, source });
}

#[cfg(any(target_os = "windows", test))]
fn env_path(raw: std::ffi::OsString) -> PathBuf {
    let text = raw.to_string_lossy();
    let trimmed = text.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return PathBuf::from(&trimmed[1..trimmed.len() - 1]);
    }

    PathBuf::from(raw)
}

#[cfg(any(target_os = "windows", test))]
fn push_windows_vscode_install_candidates(
    candidates: &mut Vec<WindowsProgramCandidate>,
    root: PathBuf,
    source: &'static str,
) {
    let install_dir = root.join("Microsoft VS Code");
    push_windows_candidate(candidates, install_dir.join("Code.exe"), source);
    push_windows_candidate(candidates, install_dir.join("bin").join("code.cmd"), source);
}

#[cfg(any(target_os = "windows", test))]
fn windows_vscode_candidates_from(
    mut lookup_path: impl FnMut(&str) -> Option<PathBuf>,
    mut lookup_env: impl FnMut(&str) -> Option<std::ffi::OsString>,
) -> Vec<WindowsProgramCandidate> {
    let mut candidates = Vec::new();

    if let Some(configured) = lookup_env(VSCODE_PATH_ENV) {
        push_windows_candidate(&mut candidates, env_path(configured), "SVODE_VSCODE_PATH");
    }

    if let Some(local_app_data) = lookup_env("LOCALAPPDATA") {
        push_windows_vscode_install_candidates(
            &mut candidates,
            PathBuf::from(local_app_data).join("Programs"),
            "%LOCALAPPDATA%\\Programs",
        );
    }

    for (env_key, source) in [
        ("ProgramFiles", "%ProgramFiles%"),
        ("ProgramW6432", "%ProgramW6432%"),
        ("ProgramFiles(x86)", "%ProgramFiles(x86)%"),
    ] {
        if let Some(program_files) = lookup_env(env_key) {
            push_windows_vscode_install_candidates(
                &mut candidates,
                PathBuf::from(program_files),
                source,
            );
        }
    }

    for command in ["code.cmd", "code.exe", "code"] {
        if let Some(path) = lookup_path(command) {
            push_windows_candidate(&mut candidates, path, "PATH");
        }
    }

    candidates
}

#[cfg(target_os = "windows")]
fn windows_vscode_candidates() -> Vec<WindowsProgramCandidate> {
    windows_vscode_candidates_from(
        |command| which::which(command).ok(),
        |key| std::env::var_os(key),
    )
}

#[cfg(any(target_os = "windows", test))]
fn select_existing_windows_candidate(
    candidates: &[WindowsProgramCandidate],
    mut is_file: impl FnMut(&Path) -> bool,
) -> Option<WindowsProgramCandidate> {
    candidates
        .iter()
        .find(|candidate| is_file(&candidate.path))
        .cloned()
}

#[cfg(any(target_os = "windows", test))]
fn describe_windows_candidates(candidates: &[WindowsProgramCandidate]) -> String {
    if candidates.is_empty() {
        return "standard VS Code install paths and PATH commands code.cmd, code.exe, code".into();
    }

    candidates
        .iter()
        .map(|candidate| format!("{} ({})", candidate.path.display(), candidate.source))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(any(target_os = "windows", test))]
fn windows_vscode_help() -> String {
    format!(
        "Install VS Code, add its bin folder to PATH so code.cmd is available, or set {VSCODE_PATH_ENV} to the full Code.exe/code.cmd path."
    )
}

#[cfg(any(target_os = "windows", test))]
fn windows_vscode_not_found_error(candidates: &[WindowsProgramCandidate]) -> AppError {
    AppError::General(format!(
        "VS Code was not found. Tried: {}. {}",
        describe_windows_candidates(candidates),
        windows_vscode_help(),
    ))
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

#[cfg(target_os = "windows")]
fn is_vscode_available() -> bool {
    let candidates = windows_vscode_candidates();
    select_existing_windows_candidate(&candidates, |path| path.is_file()).is_some()
}

#[cfg(not(target_os = "windows"))]
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

#[cfg(target_os = "windows")]
fn open_vscode(path: &Path) -> Result<(), AppError> {
    let candidates = windows_vscode_candidates();
    let candidate = select_existing_windows_candidate(&candidates, |path| path.is_file())
        .ok_or_else(|| windows_vscode_not_found_error(&candidates))?;

    let mut command = Command::new(&candidate.path);
    command.arg(path);
    crate::process::hide_window(&mut command);
    command.spawn().map(|_| ()).map_err(|err| {
        AppError::General(format!(
            "Failed to open VS Code using {}: {err}. Tried: {}. {}",
            candidate.path.display(),
            describe_windows_candidates(&candidates),
            windows_vscode_help(),
        ))
    })
}

#[cfg(not(target_os = "windows"))]
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

#[cfg(target_os = "windows")]
fn open_vscode_workspace_file(owner_root: &Path, artifact_path: &Path) -> Result<(), AppError> {
    let candidates = windows_vscode_candidates();
    let candidate = select_existing_windows_candidate(&candidates, |path| path.is_file())
        .ok_or_else(|| windows_vscode_not_found_error(&candidates))?;
    let mut command = Command::new(&candidate.path);
    command.args(vscode_workspace_file_args(owner_root, artifact_path));
    crate::process::hide_window(&mut command);
    command.spawn().map(|_| ()).map_err(|err| {
        AppError::General(format!(
            "Failed to open VS Code using {}: {err}. Tried: {}. {}",
            candidate.path.display(),
            describe_windows_candidates(&candidates),
            windows_vscode_help(),
        ))
    })
}

#[cfg(target_os = "macos")]
fn open_vscode_workspace_file(owner_root: &Path, artifact_path: &Path) -> Result<(), AppError> {
    if command_available("code") {
        let mut command = Command::new("code");
        command.args(vscode_workspace_file_args(owner_root, artifact_path));
        return spawn(command, "VS Code");
    }

    if macos_app_exists("Visual Studio Code") {
        let mut command = Command::new("open");
        command
            .arg("-na")
            .arg("Visual Studio Code")
            .arg("--args")
            .args(vscode_workspace_file_args(owner_root, artifact_path));
        return spawn(command, "VS Code");
    }

    Err(AppError::General("VS Code was not found".into()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_vscode_workspace_file(owner_root: &Path, artifact_path: &Path) -> Result<(), AppError> {
    let mut command = Command::new("code");
    command.args(vscode_workspace_file_args(owner_root, artifact_path));
    spawn(command, "VS Code")
}

#[cfg(target_os = "macos")]
fn open_cursor_workspace_file(owner_root: &Path, artifact_path: &Path) -> Result<(), AppError> {
    if command_available("cursor") {
        let mut command = Command::new("cursor");
        command.args(cursor_workspace_file_args(owner_root, artifact_path));
        return spawn(command, "Cursor");
    }

    if macos_app_exists("Cursor") {
        let mut command = Command::new("open");
        command
            .arg("-na")
            .arg("Cursor")
            .arg("--args")
            .args(cursor_workspace_file_args(owner_root, artifact_path));
        return spawn(command, "Cursor");
    }

    Err(AppError::General("Cursor was not found".into()))
}

#[cfg(not(target_os = "macos"))]
fn open_cursor_workspace_file(owner_root: &Path, artifact_path: &Path) -> Result<(), AppError> {
    let mut command = Command::new("cursor");
    command.args(cursor_workspace_file_args(owner_root, artifact_path));
    #[cfg(target_os = "windows")]
    crate::process::hide_window(&mut command);
    spawn(command, "Cursor")
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

fn reveal_file(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg("-R").arg(path);
        return spawn(command, "Finder");
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", path.display()));
        return spawn(command, "Explorer");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Freedesktop has no portable select-file CLI; opening the canonical parent
        // is the safe fallback on platforms where file selection is unsupported.
        let parent = path.parent().ok_or_else(|| {
            AppError::PathNotAccessible(format!("file has no parent: {}", path.display()))
        })?;
        let mut command = Command::new("xdg-open");
        command.arg(parent);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use tempfile::tempdir;

    #[test]
    fn artifact_target_requires_canonical_file_inside_canonical_owner_root() {
        let temp = tempdir().expect("temporary directory");
        let owner = temp.path().join("owner");
        let nested = owner.join("nested");
        std::fs::create_dir_all(&nested).expect("owner directory");
        let artifact = nested.join("AGENTS.md");
        std::fs::write(&artifact, "instructions").expect("artifact");

        let (resolved_owner, resolved_artifact) = resolve_artifact_target(&ArtifactOpenerTarget {
            owner_root: owner.to_string_lossy().into_owned(),
            canonical_artifact_path: artifact.to_string_lossy().into_owned(),
        })
        .expect("valid artifact target");

        assert_eq!(
            resolved_owner,
            owner.canonicalize().expect("canonical owner")
        );
        assert_eq!(
            resolved_artifact,
            artifact.canonicalize().expect("canonical artifact")
        );
    }

    #[cfg(unix)]
    #[test]
    fn artifact_target_revalidates_symlink_alias_against_canonical_owner() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().expect("temporary directory");
        let owner = temp.path().join("owner-source");
        std::fs::create_dir_all(&owner).expect("owner directory");
        let artifact = owner.join("AGENTS.md");
        std::fs::write(&artifact, "instructions").expect("artifact");

        let owner_alias = temp.path().join("owner-alias");
        symlink(&owner, &owner_alias).expect("owner alias");
        let artifact_alias = owner_alias.join("AGENTS.md");

        let (resolved_owner, resolved_artifact) = resolve_artifact_target(&ArtifactOpenerTarget {
            owner_root: owner_alias.to_string_lossy().into_owned(),
            canonical_artifact_path: artifact_alias.to_string_lossy().into_owned(),
        })
        .expect("aliased target remains inside its canonical owner");

        assert_eq!(
            resolved_owner,
            owner.canonicalize().expect("canonical owner")
        );
        assert_eq!(
            resolved_artifact,
            artifact.canonicalize().expect("canonical artifact")
        );
        assert!(resolved_artifact.starts_with(&resolved_owner));
    }

    #[test]
    fn artifact_target_rejects_file_outside_owner_root() {
        let temp = tempdir().expect("temporary directory");
        let owner = temp.path().join("owner");
        std::fs::create_dir_all(&owner).expect("owner directory");
        let outside = temp.path().join("outside.md");
        std::fs::write(&outside, "outside").expect("outside artifact");

        let error = resolve_artifact_target(&ArtifactOpenerTarget {
            owner_root: owner.to_string_lossy().into_owned(),
            canonical_artifact_path: outside.to_string_lossy().into_owned(),
        })
        .expect_err("outside artifact must be rejected");

        assert!(error.to_string().contains("outside its owner root"));
    }

    #[test]
    fn artifact_target_rejects_stale_path_before_spawn() {
        let temp = tempdir().expect("temporary directory");
        let owner = temp.path().join("owner");
        std::fs::create_dir_all(&owner).expect("owner directory");
        let stale = owner.join("removed.md");

        let error = resolve_artifact_target(&ArtifactOpenerTarget {
            owner_root: owner.to_string_lossy().into_owned(),
            canonical_artifact_path: stale.to_string_lossy().into_owned(),
        })
        .expect_err("stale path must be rejected");

        assert!(matches!(error, AppError::PathNotAccessible(_)));
    }

    #[test]
    fn vscode_workspace_file_args_use_new_window_owner_then_artifact() {
        let owner = Path::new("/workspace/owner");
        let artifact = Path::new("/workspace/owner/.agents/skills/SKILL.md");

        assert_eq!(
            vscode_workspace_file_args(owner, artifact),
            vec![
                PathBuf::from("--new-window"),
                owner.to_path_buf(),
                artifact.to_path_buf(),
            ]
        );
    }

    #[test]
    fn cursor_workspace_file_args_use_new_window_owner_then_artifact() {
        let owner = Path::new("/workspace/owner");
        let artifact = Path::new("/workspace/owner/.agents/skills/SKILL.md");

        assert_eq!(
            cursor_workspace_file_args(owner, artifact),
            vscode_workspace_file_args(owner, artifact)
        );
    }

    #[test]
    fn artifact_openers_include_cursor_only_when_available() {
        let unavailable = artifact_openers_with_availability(false, false, false, false);
        assert!(
            unavailable
                .iter()
                .all(|opener| opener.id != ProjectOpenerId::Cursor)
        );

        let available = artifact_openers_with_availability(false, true, false, false);
        let cursor = available
            .iter()
            .find(|opener| opener.id == ProjectOpenerId::Cursor)
            .expect("Cursor should be listed when available");
        assert_eq!(
            cursor.capabilities,
            vec![ArtifactOpenerCapability::OpenWorkspaceFile]
        );
    }

    fn user_code_exe(local_app_data: &str) -> PathBuf {
        PathBuf::from(local_app_data)
            .join("Programs")
            .join("Microsoft VS Code")
            .join("Code.exe")
    }

    fn system_code_exe(program_files: &str) -> PathBuf {
        PathBuf::from(program_files)
            .join("Microsoft VS Code")
            .join("Code.exe")
    }

    #[test]
    fn windows_vscode_candidates_include_user_system_and_path_installs() {
        let local_app_data = r"C:\Users\me\AppData\Local";
        let program_files = r"C:\Program Files";
        let path_code_cmd =
            PathBuf::from(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd");

        let candidates = windows_vscode_candidates_from(
            |command| {
                if command == "code.cmd" {
                    Some(path_code_cmd.clone())
                } else {
                    None
                }
            },
            |key| match key {
                "LOCALAPPDATA" => Some(OsString::from(local_app_data)),
                "ProgramFiles" => Some(OsString::from(program_files)),
                _ => None,
            },
        );

        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.path == user_code_exe(local_app_data))
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.path == system_code_exe(program_files))
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.path == path_code_cmd)
        );
    }

    #[test]
    fn windows_vscode_selection_prefers_configured_existing_path() {
        let configured = PathBuf::from(r"D:\Tools\VS Code\Code.exe");
        let local_app_data = r"C:\Users\me\AppData\Local";
        let user_install = user_code_exe(local_app_data);

        let candidates = windows_vscode_candidates_from(
            |_| None,
            |key| match key {
                VSCODE_PATH_ENV => Some(OsString::from(format!("\"{}\"", configured.display()))),
                "LOCALAPPDATA" => Some(OsString::from(local_app_data)),
                _ => None,
            },
        );

        let selected = select_existing_windows_candidate(&candidates, |path| {
            path == configured.as_path() || path == user_install.as_path()
        })
        .expect("expected a VS Code candidate");

        assert_eq!(selected.path, configured);
    }

    #[test]
    fn windows_vscode_selection_falls_back_when_configured_path_is_missing() {
        let configured = PathBuf::from(r"D:\Missing\Code.exe");
        let local_app_data = r"C:\Users\me\AppData\Local";
        let user_install = user_code_exe(local_app_data);

        let candidates = windows_vscode_candidates_from(
            |_| None,
            |key| match key {
                VSCODE_PATH_ENV => Some(OsString::from(configured.as_os_str())),
                "LOCALAPPDATA" => Some(OsString::from(local_app_data)),
                _ => None,
            },
        );

        let selected =
            select_existing_windows_candidate(&candidates, |path| path == user_install.as_path())
                .expect("expected a VS Code candidate");

        assert_eq!(selected.path, user_install);
    }

    #[test]
    fn windows_vscode_not_found_error_is_actionable() {
        let candidates = vec![WindowsProgramCandidate {
            path: PathBuf::from(r"C:\Program Files\Microsoft VS Code\Code.exe"),
            source: "%ProgramFiles%",
        }];

        let message = windows_vscode_not_found_error(&candidates).to_string();

        assert!(message.contains("VS Code was not found"));
        assert!(message.contains(r"C:\Program Files\Microsoft VS Code\Code.exe"));
        assert!(message.contains("code.cmd"));
        assert!(message.contains(VSCODE_PATH_ENV));
    }
}
