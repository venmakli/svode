use svode_tools::error::ToolError;

use crate::AppError;

impl From<AppError> for ToolError {
    fn from(error: AppError) -> Self {
        // An access refusal keeps the typed evidence and next step of the
        // shared mapping.
        if let AppError::RepositoryAccessDenied {
            repository_id,
            status,
            reason,
        } = error
        {
            return svode_core::git::GitError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            }
            .into();
        }
        let code = match &error {
            AppError::FileNotFound(_) => "FILE_NOT_FOUND",
            AppError::FileAlreadyExists(_) => "FILE_ALREADY_EXISTS",
            AppError::SpaceNotFound(_) => "SPACE_NOT_FOUND",
            AppError::PathNotAccessible(_) => "PATH_NOT_ACCESSIBLE",
            AppError::GitNotFound => "GIT_NOT_FOUND",
            AppError::GitCommandFailed(_) => "GIT_COMMAND_FAILED",
            AppError::GitConflict(_) => "GIT_CONFLICT",
            AppError::GitAuthRequired(_) => "GIT_AUTH_REQUIRED",
            AppError::RepositoryAccessDenied { .. } => "REPOSITORY_ACCESS_DENIED",
            AppError::GitNoRemote => "GIT_NO_REMOTE",
            AppError::PageWriteRecovery { .. } => "PAGE_WRITE_RECOVERY_FAILED",
            AppError::DocumentNameConflict(_) => "PAGE_NAME_CONFLICT",
            AppError::Index(_) => "INDEX_ERROR",
            AppError::Db(_) => "DATABASE_ERROR",
            _ => "SVODE_ERROR",
        };
        Self::new(code, error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_access_denial_has_stable_business_code() {
        let error = ToolError::from(AppError::RepositoryAccessDenied {
            repository_id: "repo".to_string(),
            status: "read_only".to_string(),
            reason: "none".to_string(),
        });

        assert_eq!(error.code, "REPOSITORY_ACCESS_DENIED");
        assert!(error.message.contains("status=read_only"));
        assert_eq!(error.evidence["status"], "read_only");
        assert!(error.evidence.contains_key("hint"));
    }
}
