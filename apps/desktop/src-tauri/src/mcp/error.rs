use serde::{Deserialize, Serialize};

use crate::AppError;

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
        Self::new("NO_ACTIVE_PROJECT", "Open a project in CombAI first")
    }
}

impl From<AppError> for McpBusinessError {
    fn from(error: AppError) -> Self {
        let code = match &error {
            AppError::FileNotFound(_) => "FILE_NOT_FOUND",
            AppError::FileAlreadyExists(_) => "FILE_ALREADY_EXISTS",
            AppError::SpaceNotFound(_) => "SPACE_NOT_FOUND",
            AppError::PathNotAccessible(_) => "PATH_NOT_ACCESSIBLE",
            AppError::GitNotFound => "GIT_NOT_FOUND",
            AppError::GitCommandFailed(_) => "GIT_COMMAND_FAILED",
            AppError::GitConflict(_) => "GIT_CONFLICT",
            AppError::GitAuthRequired(_) => "GIT_AUTH_REQUIRED",
            AppError::GitNoRemote => "GIT_NO_REMOTE",
            AppError::Index(_) => "INDEX_ERROR",
            AppError::Db(_) => "DATABASE_ERROR",
            _ => "COMBAI_ERROR",
        };
        Self::new(code, error.to_string())
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
