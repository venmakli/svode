use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBusinessError {
    pub code: String,
    pub message: String,
}

impl McpBusinessError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn no_active_project() -> Self {
        Self::new("NO_ACTIVE_PROJECT", "Open a project in Svode first")
    }
}

impl From<std::io::Error> for McpBusinessError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

impl From<serde_json::Error> for McpBusinessError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("SERIALIZATION_ERROR", error.to_string())
    }
}
