use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub code: String,
    pub message: String,
    /// Recovery evidence published next to the code, such as diagnostics.
    #[serde(flatten, default)]
    pub evidence: Map<String, Value>,
}

impl ToolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            evidence: Map::new(),
        }
    }

    pub fn with_evidence(mut self, key: &str, value: Value) -> Self {
        self.evidence.insert(key.to_string(), value);
        self
    }

    pub fn no_active_project() -> Self {
        Self::new("NO_ACTIVE_PROJECT", "Open a project in Svode first")
    }
}

impl From<std::io::Error> for ToolError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("SERIALIZATION_ERROR", error.to_string())
    }
}
