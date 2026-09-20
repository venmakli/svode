//! Device-local Git policy shared by ignore projections and managed Git operations.

pub const S3_AGENT: &str = crate::storage::s3::CONFIG_REL;

pub const ENTRIES: &[&str] = &[
    ".svode/local.json",
    S3_AGENT,
    ".svode/variables.*",
    ".svode/*.db*",
];

pub fn rules(prefix: &str) -> String {
    ENTRIES
        .iter()
        .map(|entry| format!("{prefix}{entry}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn contains(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    parts.windows(2).any(|parts| {
        parts[0] == ".svode"
            && ENTRIES.iter().any(|entry| {
                let pattern = entry
                    .strip_prefix(".svode/")
                    .expect("local policy namespace");
                if let Some(inner) = pattern.strip_prefix('*').and_then(|p| p.strip_suffix('*')) {
                    parts[1].contains(inner)
                } else if let Some(prefix) = pattern.strip_suffix('*') {
                    parts[1].starts_with(prefix)
                } else {
                    parts[1] == pattern
                }
            })
    })
}

pub use crate::routines::local::GitUserPolicy;

/// Safe policy read for background side-effect gates. Invalid or missing local
/// config disables automation rather than enabling background commits/sync.
pub fn effective_user_policy(path: &std::path::Path) -> GitUserPolicy {
    crate::routines::local::read(path)
        .ok()
        .and_then(|local| local.git)
        .unwrap_or_default()
}

/// Write the device-local Git automation policy of one repository.
pub fn write_user_policy(
    path: &std::path::Path,
    policy: &GitUserPolicy,
) -> Result<(), crate::routines::local::LocalConfigError> {
    crate::routines::local::mutate_with(path, |local| {
        local.git = Some(policy.clone());
        Ok::<_, crate::routines::local::LocalConfigError>(())
    })
}

/// Per-user Git automation policy of one repository, as written on this device.
pub fn read_user_policy(
    path: &std::path::Path,
) -> Result<GitUserPolicy, crate::routines::local::LocalConfigError> {
    Ok(crate::routines::local::read(path)?.git.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_policy_defaults_false_and_round_trips_through_local_config() {
        let temp = tempfile::tempdir().expect("temp dir");

        assert_eq!(
            read_user_policy(temp.path()).expect("read missing local config"),
            GitUserPolicy::default()
        );
        assert_eq!(effective_user_policy(temp.path()), GitUserPolicy::default());

        let policy = GitUserPolicy {
            auto_sync: true,
            auto_commit_structural: false,
            auto_commit_system: true,
        };
        write_user_policy(temp.path(), &policy).expect("write policy");

        assert_eq!(read_user_policy(temp.path()).expect("read policy"), policy);
        assert_eq!(effective_user_policy(temp.path()), policy);
        assert!(
            std::fs::read_to_string(temp.path().join(".svode/local.json"))
                .expect("read local")
                .contains("autoSync")
        );
    }
}
