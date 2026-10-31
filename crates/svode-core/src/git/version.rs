//! The version of the Git executable Svode runs and what it allows.

use std::fmt;

/// `major.minor.patch` of a Git release. Ordering follows the numbers, never a
/// contiguous sequence: the release after 2.56 is 2.98.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    /// Oldest Git Svode runs on: `rev-parse --path-format` and `GIT_CONFIG_COUNT`.
    pub const MINIMUM: Self = Self::new(2, 31, 0);
    /// `merge-tree --write-tree` merges in memory, so background integration
    /// may merge; an older supported Git only fast-forwards in the background.
    pub const BACKGROUND_MERGE: Self = Self::new(2, 38, 0);

    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// The release of `git version` output such as `git version 2.50.1 (Apple
    /// Git-155)`, `git version 2.56.0.windows.2` or `git version 2.98.0-rc0`.
    pub fn parse(output: &str) -> Option<Self> {
        let release = output.trim().strip_prefix("git version ")?;
        let release = release.split_whitespace().next()?;
        let mut parts = release.split(['.', '-']).map(|part| {
            let digits = part.len() - part.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            part[..digits].parse::<u32>().ok()
        });
        let major = parts.next()??;
        let minor = parts.next()??;
        let patch = parts.next().flatten().unwrap_or(0);
        Some(Self::new(major, minor, patch))
    }

    pub fn supported(self) -> bool {
        self >= Self::MINIMUM
    }

    pub fn background_merge(self) -> bool {
        self >= Self::BACKGROUND_MERGE
    }
}

impl fmt::Display for GitVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The part of `git version` output after its fixed prefix, as people read it.
pub fn release_label(output: &str) -> Option<String> {
    let output = output.trim();
    let label = output.strip_prefix("git version ").unwrap_or(output).trim();
    (!label.is_empty()).then(|| label.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vendor_suffixes_release_candidates_and_the_next_major() {
        for (output, version) in [
            ("git version 2.31.0", GitVersion::new(2, 31, 0)),
            (
                "git version 2.50.1 (Apple Git-155)\n",
                GitVersion::new(2, 50, 1),
            ),
            ("git version 2.56.0.windows.2", GitVersion::new(2, 56, 0)),
            ("git version 2.98.0-rc0", GitVersion::new(2, 98, 0)),
            ("git version 2.98.0.rc0", GitVersion::new(2, 98, 0)),
            ("git version 3.0.0", GitVersion::new(3, 0, 0)),
            ("git version 2.45.0.123.gabcdef0", GitVersion::new(2, 45, 0)),
        ] {
            assert_eq!(GitVersion::parse(output), Some(version), "{output}");
        }
        for output in ["", "git version", "git-lfs/3.4.0", "git version x.y"] {
            assert_eq!(GitVersion::parse(output), None, "{output}");
        }
    }

    #[test]
    fn minimum_and_background_merge_follow_numbers_not_a_sequence() {
        let parse = |output: &str| GitVersion::parse(output).unwrap();
        assert!(!parse("git version 2.30.9").supported());
        assert!(!parse("git version 1.99.0").supported());
        assert!(parse("git version 2.31.0").supported());
        assert!(!parse("git version 2.37.7").background_merge());
        assert!(parse("git version 2.38.0").background_merge());
        assert!(parse("git version 2.98.0-rc0") > parse("git version 2.56.0.windows.2"));
        for output in [
            "git version 2.50.1 (Apple Git-155)",
            "git version 2.98.0-rc0",
            "git version 3.0.0",
        ] {
            let version = parse(output);
            assert!(
                version.supported() && version.background_merge(),
                "{output}"
            );
        }
    }

    #[test]
    fn release_label_keeps_the_vendor_suffix() {
        assert_eq!(
            release_label("git version 2.50.1 (Apple Git-155)\n").as_deref(),
            Some("2.50.1 (Apple Git-155)")
        );
        assert_eq!(release_label("  "), None);
    }
}
