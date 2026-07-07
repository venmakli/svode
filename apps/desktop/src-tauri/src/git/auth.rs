use std::path::Path;

use serde::Serialize;

use super::cli::GitCli;
use crate::AppError;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRemoteOperation {
    Sync,
    Clone,
    FirstPush,
    Fetch,
    LfsDiagnostics,
    LfsFetchPull,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRemoteAuthMethod {
    Https,
    Ssh,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthChallenge {
    pub operation: GitRemoteOperation,
    pub auth_method: GitRemoteAuthMethod,
    pub remote_url: Option<String>,
    pub host: Option<String>,
    pub repository: Option<String>,
    pub provider_hint: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteParts {
    protocol: String,
    host: String,
    path: String,
}

pub async fn build_auth_challenge(
    cli: &GitCli,
    repo_dir: &Path,
    operation: GitRemoteOperation,
    detail: Option<&str>,
) -> GitAuthChallenge {
    let remote_url = super::ops::get_remote(cli, repo_dir).await.ok().flatten();
    build_auth_challenge_for_remote(remote_url.as_deref(), operation, detail)
}

pub fn build_auth_challenge_for_remote(
    remote_url: Option<&str>,
    operation: GitRemoteOperation,
    detail: Option<&str>,
) -> GitAuthChallenge {
    let parts = remote_url.and_then(parse_remote_parts);
    let host = parts.as_ref().map(|parts| parts.host.clone());
    let repository = parts
        .as_ref()
        .and_then(|parts| repository_label(&parts.path));
    let auth_method = remote_url
        .map(remote_auth_method)
        .unwrap_or(GitRemoteAuthMethod::Unknown);
    let provider_hint = host.as_deref().and_then(provider_hint);

    GitAuthChallenge {
        operation,
        auth_method,
        remote_url: remote_url.map(redact_url_credentials),
        host,
        repository,
        provider_hint,
        detail: detail.and_then(|value| trim_detail(&redact_url_credentials(value))),
    }
}

pub async fn approve_http_credentials(
    cli: &GitCli,
    remote_url: &str,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AppError::GitCommandFailed(
            "Git credential username is required".to_string(),
        ));
    }
    if password.is_empty() {
        return Err(AppError::GitCommandFailed(
            "Git credential token is required".to_string(),
        ));
    }
    if contains_credential_newline(username) || contains_credential_newline(password) {
        return Err(AppError::GitCommandFailed(
            "Git credentials cannot contain newlines".to_string(),
        ));
    }

    let Some(parts) = parse_http_remote_parts(remote_url) else {
        return Err(AppError::GitCommandFailed(
            "Git HTTP(S) remote URL is required to save credentials".to_string(),
        ));
    };

    let payload = format!(
        "protocol={}\nhost={}\npath={}\nusername={}\npassword={}\n\n",
        parts.protocol, parts.host, parts.path, username, password
    );
    let out = cli
        .exec_no_dir_with_stdin(&["credential", "approve"], &payload)
        .await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git credential approve failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(())
}

pub fn remote_auth_method(remote_url: &str) -> GitRemoteAuthMethod {
    let lower = remote_url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        GitRemoteAuthMethod::Https
    } else if lower.starts_with("ssh://") || looks_like_scp_remote(remote_url) {
        GitRemoteAuthMethod::Ssh
    } else {
        GitRemoteAuthMethod::Unknown
    }
}

pub fn redact_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_idx) = rest.find("://") {
        let (before, after_before) = rest.split_at(scheme_idx + 3);
        out.push_str(before);
        rest = after_before;

        let authority_end = rest
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'')
            .unwrap_or(rest.len());
        let (authority, after_authority) = rest.split_at(authority_end);
        if let Some(at_idx) = authority.rfind('@') {
            out.push_str("***@");
            out.push_str(&authority[at_idx + 1..]);
        } else {
            out.push_str(authority);
        }
        rest = after_authority;
    }
    out.push_str(rest);
    out
}

fn parse_remote_parts(remote_url: &str) -> Option<RemoteParts> {
    parse_http_remote_parts(remote_url)
        .or_else(|| parse_ssh_url_remote_parts(remote_url))
        .or_else(|| parse_scp_remote_parts(remote_url))
}

fn parse_http_remote_parts(remote_url: &str) -> Option<RemoteParts> {
    let (protocol, rest) = remote_url.split_once("://")?;
    let protocol = protocol.to_ascii_lowercase();
    if protocol != "http" && protocol != "https" {
        return None;
    }
    let (authority, path) = split_authority_and_path(rest)?;
    let host = strip_userinfo(authority);
    if host.is_empty() {
        return None;
    }
    Some(RemoteParts {
        protocol,
        host: host.to_string(),
        path: normalize_remote_path(path),
    })
}

fn parse_ssh_url_remote_parts(remote_url: &str) -> Option<RemoteParts> {
    let rest = remote_url.strip_prefix("ssh://")?;
    let (authority, path) = split_authority_and_path(rest)?;
    let host = strip_userinfo(authority);
    if host.is_empty() {
        return None;
    }
    Some(RemoteParts {
        protocol: "ssh".to_string(),
        host: host.to_string(),
        path: normalize_remote_path(path),
    })
}

fn parse_scp_remote_parts(remote_url: &str) -> Option<RemoteParts> {
    if remote_url.contains("://") {
        return None;
    }
    let colon_idx = remote_url.find(':')?;
    let authority = &remote_url[..colon_idx];
    if authority.is_empty() || authority.contains('/') {
        return None;
    }
    let host = strip_userinfo(authority);
    if host.is_empty() {
        return None;
    }
    Some(RemoteParts {
        protocol: "ssh".to_string(),
        host: host.to_string(),
        path: normalize_remote_path(&remote_url[colon_idx + 1..]),
    })
}

fn split_authority_and_path(rest: &str) -> Option<(&str, &str)> {
    let path_idx = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..path_idx];
    let path = rest.get(path_idx..).unwrap_or_default();
    if authority.is_empty() {
        None
    } else {
        Some((authority, path))
    }
}

fn strip_userinfo(authority: &str) -> &str {
    authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority)
}

fn normalize_remote_path(path: &str) -> String {
    path.trim_start_matches('/')
        .trim_end_matches('/')
        .to_string()
}

fn repository_label(path: &str) -> Option<String> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.strip_suffix(".git").unwrap_or(trimmed).to_string())
}

fn provider_hint(host: &str) -> Option<String> {
    let lower = host.to_ascii_lowercase();
    if lower.contains("github.com") {
        Some("github".to_string())
    } else if lower.contains("gitlab.com") {
        Some("gitlab".to_string())
    } else if lower.contains("gitea") {
        Some("gitea".to_string())
    } else {
        None
    }
}

fn trim_detail(detail: &str) -> Option<String> {
    let trimmed = detail.trim();
    if trimmed.is_empty() {
        return None;
    }
    const MAX_CHARS: usize = 1200;
    if trimmed.chars().count() <= MAX_CHARS {
        Some(trimmed.to_string())
    } else {
        let mut out: String = trimmed.chars().take(MAX_CHARS).collect();
        out.push_str("\n...");
        Some(out)
    }
}

fn contains_credential_newline(value: &str) -> bool {
    value.contains('\n') || value.contains('\r')
}

fn looks_like_scp_remote(remote_url: &str) -> bool {
    if remote_url.contains("://") {
        return false;
    }
    let Some(colon_idx) = remote_url.find(':') else {
        return false;
    };
    let host_part = &remote_url[..colon_idx];
    !host_part.is_empty() && !host_part.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_https_auth_challenge_without_secrets() {
        let challenge = build_auth_challenge_for_remote(
            Some("https://user:secret@example.com/org/repo.git"),
            GitRemoteOperation::Sync,
            Some("fatal: Authentication failed for https://user:secret@example.com/org/repo.git"),
        );

        assert_eq!(challenge.auth_method, GitRemoteAuthMethod::Https);
        assert_eq!(challenge.host.as_deref(), Some("example.com"));
        assert_eq!(challenge.repository.as_deref(), Some("org/repo"));
        assert_eq!(
            challenge.remote_url.as_deref(),
            Some("https://***@example.com/org/repo.git")
        );
        assert!(
            !challenge
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("secret")
        );
    }

    #[test]
    fn parses_scp_remote_challenge() {
        let challenge = build_auth_challenge_for_remote(
            Some("git@example.com:org/repo.git"),
            GitRemoteOperation::Sync,
            None,
        );

        assert_eq!(challenge.auth_method, GitRemoteAuthMethod::Ssh);
        assert_eq!(challenge.host.as_deref(), Some("example.com"));
        assert_eq!(challenge.repository.as_deref(), Some("org/repo"));
    }

    #[test]
    fn parses_redacted_https_remote_for_credential_scope() {
        let parts = parse_http_remote_parts("https://***@example.com/org/repo.git").unwrap();

        assert_eq!(parts.protocol, "https");
        assert_eq!(parts.host, "example.com");
        assert_eq!(parts.path, "org/repo.git");
    }
}
