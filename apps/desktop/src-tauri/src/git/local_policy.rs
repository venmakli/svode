//! Device-local Git policy shared by ignore projections and managed Git operations.

pub(crate) const S3_AGENT: &str = svode_core::storage::s3::CONFIG_REL;

pub(super) const ENTRIES: &[&str] = &[
    ".svode/local.json",
    S3_AGENT,
    ".svode/variables.*",
    ".svode/*.db*",
];

pub(super) fn rules(prefix: &str) -> String {
    ENTRIES
        .iter()
        .map(|entry| format!("{prefix}{entry}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn contains(path: &str) -> bool {
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
