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

/// Markers of the block holding `RULES` in `info/exclude` of every repository
/// Svode opens (DF-273 R3).
pub(crate) const EXCLUDE_BLOCK: (&str, &str) = ("# svode:system:start", "# svode:system:end");

/// `info/exclude` content whose first Svode block holds every rule of
/// `RULES`, appended when there is none. Lines outside that block keep their
/// bytes; other lines inside it stay in it after the rules.
pub(crate) fn exclude_with_block(content: &str) -> String {
    use super::ops::{append_block, block_end, gitignore_lines, line_text};

    let (lines, eol) = gitignore_lines(content);
    let existing = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line_text(line).trim() == EXCLUDE_BLOCK.0)
        .find_map(|(start, _)| block_end(&lines, start, EXCLUDE_BLOCK).map(|end| (start, end)));
    let mut block = format!("{}{eol}", EXCLUDE_BLOCK.0);
    for rule in RULES {
        block.push_str(rule);
        block.push_str(eol);
    }
    if let Some((start, end)) = existing {
        for line in &lines[start + 1..end] {
            let text = line_text(line);
            if !text.trim().is_empty() && !RULES.contains(&text.trim()) {
                block.push_str(text);
                block.push_str(eol);
            }
        }
    }
    block.push_str(EXCLUDE_BLOCK.1);
    block.push_str(eol);
    match existing {
        Some((start, end)) => format!(
            "{}{block}{}",
            lines[..start].concat(),
            lines[end + 1..].concat()
        ),
        None => append_block(content, &block, eol),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn block(eol: &str, user: &[&str]) -> String {
        let mut block = format!("{}{eol}", EXCLUDE_BLOCK.0);
        for line in RULES.iter().chain(user) {
            block.push_str(&format!("{line}{eol}"));
        }
        block.push_str(&format!("{}{eol}", EXCLUDE_BLOCK.1));
        block
    }

    #[test]
    fn the_block_is_appended_after_the_lines_of_the_user_once() {
        assert_eq!(exclude_with_block(""), block("\n", &[]));
        let user = "# git ls-files --others --exclude-from=.git/info/exclude\nsecret.txt";
        let updated = exclude_with_block(user);
        assert_eq!(updated, format!("{user}\n{}", block("\n", &[])));
        assert_eq!(exclude_with_block(&updated), updated);
    }

    #[test]
    fn the_block_is_restored_in_place_with_the_lines_of_the_user_inside_it() {
        let stale = format!(
            "before\r\n{}\r\n.DS_Store\r\n\r\nmine.log\r\n{}\r\nafter\r\n",
            EXCLUDE_BLOCK.0, EXCLUDE_BLOCK.1
        );
        assert_eq!(
            exclude_with_block(&stale),
            format!("before\r\n{}after\r\n", block("\r\n", &["mine.log"]))
        );
    }

    #[test]
    fn an_unterminated_start_marker_stays_a_line_of_the_user() {
        let content = format!("{}\nmine.log\n", EXCLUDE_BLOCK.0);
        let updated = exclude_with_block(&content);
        assert_eq!(updated, format!("{content}{}", block("\n", &[])));
        assert_eq!(exclude_with_block(&updated), updated);
    }
}
