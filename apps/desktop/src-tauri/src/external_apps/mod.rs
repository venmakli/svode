//! Device-local presentation of installed external applications.
//!
//! Names and icons come from the OS for the concrete installed application and
//! are delivered to the window only: they are never written to a project and
//! never exposed through MCP/CLI. The frontend receives an opaque application
//! id and a ready image, never an executable path.

use serde::Serialize;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub(crate) use macos::{
    app_presentation as macos_app_presentation, find_app_bundle as find_macos_app_bundle,
};

/// Symbolic fallback class shown when the OS returns no icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAppKind {
    Editor,
    FileManager,
    Terminal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAppDto {
    pub id: String,
    pub label: String,
    pub kind: ExternalAppKind,
    pub is_default: bool,
    /// `data:` URL of the application icon, absent when the OS returned none.
    pub icon: Option<String>,
}

/// What the OS reports for one installed application.
#[derive(Debug, Clone, Default)]
pub(crate) struct AppPresentation {
    pub label: Option<String>,
    pub icon: Option<String>,
}
