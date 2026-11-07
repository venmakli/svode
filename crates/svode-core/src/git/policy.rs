//! Device-local Git policy shared by ignore projections and managed Git operations.

pub const S3_AGENT: &str = crate::storage::s3::CONFIG_REL;

/// Device-local navigation state of a Project: the state file and its
/// temporary replacement files.
pub const NAVIGATION_STATE: &str = ".svode/navigation.*";

pub const ENTRIES: &[&str] = &[
    ".svode/local.json",
    NAVIGATION_STATE,
    crate::git::write_guard::WRITE_LOCK_FILE,
    S3_AGENT,
    ".svode/variables.*",
    ".svode/*.db*",
];

/// Root lines earlier versions wrote besides `ENTRIES`; `.svode/*.db*` covers
/// them, so repair drops them together with their Svode-owned record.
const LEGACY_ENTRIES: &[&str] = &[".svode/*.db", ".svode/*.db-wal", ".svode/*.db-shm"];

/// Line only the inline block of earlier versions held, with the `*/` prefix.
const LEGACY_INLINE_ENTRIES: &[&str] = &[".svode/*.db-*"];

/// Unbounded header earlier versions wrote above each new set of root lines.
pub(crate) const LEGACY_HEADER: &str = "# Svode local files";

/// Markers of the block earlier versions wrote for the S3 agent config alone.
pub(crate) const LEGACY_S3_START: &str = "# svode:lfs-s3-agent:start";
pub(crate) const LEGACY_S3_END: &str = "# svode:lfs-s3-agent:end";

/// Whether Svode has ever written `line` (trimmed) as a local rule of a
/// repository root (`prefix` empty) or of the inline block (`prefix` `*/`).
pub(crate) fn written(line: &str, prefix: &str) -> bool {
    let Some(entry) = line.trim().strip_prefix(prefix) else {
        return false;
    };
    ENTRIES.contains(&entry)
        || LEGACY_ENTRIES.contains(&entry)
        || (!prefix.is_empty() && LEGACY_INLINE_ENTRIES.contains(&entry))
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
    read_user_policy(path).unwrap_or_default()
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

/// Per-user Git automation policy of one repository on this device, as it
/// acts: content commits include structural and system commits, so a stored
/// combination with either of them off while content commits are on reads as
/// on, and the next settings save writes it that way.
pub fn read_user_policy(
    path: &std::path::Path,
) -> Result<GitUserPolicy, crate::routines::local::LocalConfigError> {
    let mut policy = crate::routines::local::read(path)?.git.unwrap_or_default();
    if policy.auto_commit_content {
        policy.auto_commit_structural = true;
        policy.auto_commit_system = true;
    }
    Ok(policy)
}

/// Excludes the device-local files of `repo`, a test repository Svode
/// never repaired, in its `.git/info/exclude`, as the local policy keeps them
/// out of every repository Svode manages: the integration step and source
/// writes take `.svode/write.lock`.
#[cfg(test)]
pub(crate) fn exclude_device_local(repo: &std::path::Path) {
    use std::io::Write;
    let info = repo.join(".git/info");
    std::fs::create_dir_all(&info).expect("info dir");
    let mut exclude = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(info.join("exclude"))
        .expect("open exclude");
    for entry in ENTRIES {
        writeln!(exclude, "{entry}").expect("write exclude");
    }
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
            auto_commit_content: false,
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

    #[test]
    fn content_commits_turn_on_structural_and_system_commits_as_read() {
        let temp = tempfile::tempdir().expect("temp dir");
        for structural in [false, true] {
            for system in [false, true] {
                for sync in [false, true] {
                    for content in [false, true] {
                        let stored = GitUserPolicy {
                            auto_sync: sync,
                            auto_commit_structural: structural,
                            auto_commit_system: system,
                            auto_commit_content: content,
                        };
                        write_user_policy(temp.path(), &stored).expect("write policy");
                        let expected = GitUserPolicy {
                            auto_commit_structural: structural || content,
                            auto_commit_system: system || content,
                            ..stored.clone()
                        };

                        assert_eq!(
                            read_user_policy(temp.path()).expect("read policy"),
                            expected
                        );
                        assert_eq!(effective_user_policy(temp.path()), expected);
                        // The read never rewrites the stored flags.
                        let written: serde_json::Value = serde_json::from_str(
                            &std::fs::read_to_string(temp.path().join(".svode/local.json"))
                                .expect("read local"),
                        )
                        .expect("local json");
                        assert_eq!(written["git"]["autoCommitStructural"], structural);
                        assert_eq!(written["git"]["autoCommitSystem"], system);
                    }
                }
            }
        }
    }

    #[test]
    fn unreadable_local_config_keeps_automation_off() {
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
        std::fs::write(
            temp.path().join(".svode/local.json"),
            r#"{"git":{"autoCommitContent":"#,
        )
        .expect("write broken local config");

        assert!(read_user_policy(temp.path()).is_err());
        assert_eq!(effective_user_policy(temp.path()), GitUserPolicy::default());
    }
}
