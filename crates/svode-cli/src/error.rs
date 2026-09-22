use serde_json::{Map, Value};

/// Failure of one command with its stable code and exit status.
#[derive(Debug)]
pub struct CliError {
    pub code: String,
    pub message: String,
    pub exit: i32,
    /// Selectors known at the moment of failure.
    pub target: Map<String, Value>,
    /// Evidence fields of a business failure of the shared operation.
    pub evidence: Map<String, Value>,
    /// Short recovery hint printed to stderr in human mode.
    pub hint: Option<&'static str>,
}

impl CliError {
    fn new(code: impl Into<String>, message: impl Into<String>, exit: i32) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            exit,
            target: Map::new(),
            evidence: Map::new(),
            hint: None,
        }
    }

    pub fn operation(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, 1)
    }

    pub fn argument(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message, 2)
    }

    /// Input that cannot be read or decoded before the command runs.
    pub fn input(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, 2)
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
        let mut error = Map::new();
        error.insert("code".into(), Value::from(self.code.as_str()));
        error.insert("message".into(), Value::from(self.message.as_str()));
        error.insert("target".into(), Value::Object(self.target.clone()));
        error.extend(self.evidence.clone());
        serde_json::json!({
            "schemaVersion": 1,
            "ok": false,
            "error": error,
        })
    }
}
