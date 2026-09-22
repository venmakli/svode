use serde_json::{Map, Value};

/// Failure of one command with its stable code and exit status.
#[derive(Debug)]
pub struct CliError {
    pub code: &'static str,
    pub message: String,
    pub exit: i32,
    /// Selectors known at the moment of failure.
    pub target: Map<String, Value>,
    /// Usage printed to stderr for grammar failures.
    pub usage: Option<String>,
    /// Short recovery hint printed to stderr in human mode.
    pub hint: Option<&'static str>,
}

impl CliError {
    pub fn operation(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            exit: 1,
            target: Map::new(),
            usage: None,
            hint: None,
        }
    }

    pub fn argument(message: impl Into<String>, usage: Option<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT",
            message: message.into(),
            exit: 2,
            target: Map::new(),
            usage,
            hint: None,
        }
    }

    pub fn with_target(mut self, target: Map<String, Value>) -> Self {
        self.target = target;
        self
    }

    pub fn with_hint(mut self, hint: &'static str) -> Self {
        self.hint = Some(hint);
        self
    }

    pub fn envelope(&self) -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "ok": false,
            "error": {
                "code": self.code,
                "message": self.message,
                "target": self.target,
            },
        })
    }
}
