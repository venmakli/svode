//! Files that operating systems and office suites create next to the files of
//! a repository. They never belong in Git, so Svode keeps one rule set for
//! them (DF-273 R1, R4).

/// Ignore rules for files of macOS, Windows and Linux and lock files of office
/// suites. A rule without a leading `/` matches at any depth.
pub const RULES: &[&str] = &[
    // macOS
    ".DS_Store",
    "._*",
    ".AppleDouble",
    ".LSOverride",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".TemporaryItems",
    ".DocumentRevisions-V100",
    ".apdisk",
    // Windows
    "Thumbs.db",
    "ehthumbs.db",
    "desktop.ini",
    "$RECYCLE.BIN/",
    // Linux
    ".directory",
    ".Trash-*",
    ".fuse_hidden*",
    ".nfs*",
    // Lock files of Microsoft Office and LibreOffice
    "~$*",
    ".~lock.*#",
];

/// Comment above `RULES` in the `.gitignore` of a repository Svode creates.
pub(crate) const GITIGNORE_COMMENT: &str =
    "# Files that operating systems and office suites create";

/// Asserts that `gitignore` holds every rule as its own line above the
/// `# svode:local` block, and the block itself.
#[cfg(test)]
pub(crate) fn assert_rules_above_local_block(gitignore: &str) {
    let lines = gitignore.lines().map(str::trim).collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| *line == "# svode:local:start")
        .unwrap_or_else(|| panic!("no local block: {gitignore}"));
    assert!(lines[start..].contains(&"# svode:local:end"), "{gitignore}");
    for rule in RULES {
        let at = lines
            .iter()
            .position(|line| line == rule)
            .unwrap_or_else(|| panic!("no {rule}: {gitignore}"));
        assert!(at < start, "{rule} inside the local block: {gitignore}");
    }
}

/// Whether `gitignore` holds any rule of `RULES` as a line.
#[cfg(test)]
pub(crate) fn has_any_rule(gitignore: &str) -> bool {
    gitignore.lines().any(|line| RULES.contains(&line.trim()))
}
