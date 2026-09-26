use std::fmt;
use std::path::Path;

/// Failure of a connection step with its stable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectError {
    pub code: &'static str,
    pub message: String,
}

impl ConnectError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn io(path: &Path, error: std::io::Error) -> Self {
        Self::new("CONNECT_IO_ERROR", format!("{}: {error}", path.display()))
    }
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ConnectError {}
