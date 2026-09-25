use std::fmt;
use std::path::Path;

/// Failure of an installation step with its stable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallError {
    pub code: &'static str,
    pub message: String,
}

impl InstallError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn io(path: &Path, error: std::io::Error) -> Self {
        Self::new("INSTALL_IO_ERROR", format!("{}: {error}", path.display()))
    }
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for InstallError {}
