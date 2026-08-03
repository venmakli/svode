use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use regex::Regex;

use crate::supported_adapters::{
    RegistryEnvironment, SupportedAdapterId, SupportedAdapterSnapshot,
};

use super::super::model::{
    InstructionAvailability, InstructionDiscovery, InstructionDiscoveryPolicy, InstructionOwner,
    InstructionOwnerKind, InstructionReference, InstructionRow, InstructionSourceKind,
};
use super::DiscoveryResult;
use super::io::{diagnostic, inspect, path_string};

const PREVIEW_BYTES: usize = 64 * 1024;
const MAX_IMPORT_DEPTH: usize = 5;
const MAX_IMPORT_REFERENCES: usize = 128;

pub(super) fn discover(
    repository_root: &Path,
    _target_root: &Path,
    directory_chain: &[PathBuf],
    environment: &RegistryEnvironment,
    adapter: &SupportedAdapterSnapshot,
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let personal = environment.claude_config_dir.join("CLAUDE.md");
    result.observed_personal_paths.push(path_string(&personal));
    discover_group(
        &[personal],
        &environment.claude_config_dir,
        InstructionSourceKind::Personal,
        InstructionOwner {
            kind: InstructionOwnerKind::ClientConfiguration,
            root: path_string(&environment.claude_config_dir),
        },
        0,
        adapter,
        &mut result,
    );

    let root_candidates = [
        repository_root.join("CLAUDE.md"),
        repository_root.join(".claude/CLAUDE.md"),
    ];
    result
        .observed_project_paths
        .extend(root_candidates.iter().map(|path| path_string(path)));
    discover_group(
        &root_candidates,
        repository_root,
        InstructionSourceKind::Project,
        InstructionOwner {
            kind: InstructionOwnerKind::TargetSpace,
            root: path_string(repository_root),
        },
        0,
        adapter,
        &mut result,
    );

    for (directory_depth, directory) in directory_chain.iter().enumerate() {
        let mut candidates = vec![directory.join("CLAUDE.local.md")];
        if directory != repository_root {
            candidates.insert(0, directory.join("CLAUDE.md"));
        }
        for candidate in candidates {
            result.observed_project_paths.push(path_string(&candidate));
            discover_group(
                &[candidate],
                repository_root,
                InstructionSourceKind::Project,
                InstructionOwner {
                    kind: InstructionOwnerKind::TargetSpace,
                    root: path_string(directory),
                },
                directory_depth,
                adapter,
                &mut result,
            );
        }
    }
    result
}

fn discover_group(
    candidates: &[PathBuf],
    allowed_root: &Path,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
    directory_depth: usize,
    adapter: &SupportedAdapterSnapshot,
    result: &mut DiscoveryResult,
) {
    let adapter_id = SupportedAdapterId::ClaudeCode;
    let mut inspected = candidates
        .iter()
        .filter_map(|path| {
            inspect(path, allowed_root, PREVIEW_BYTES, Some(adapter_id))
                .map(|source| (path, source))
        })
        .collect::<Vec<_>>();
    let selected = inspected.iter().position(|(_, source)| {
        source
            .preview
            .as_ref()
            .is_some_and(|preview| !preview.markdown.trim().is_empty())
    });

    for (precedence, (path, mut source)) in inspected.drain(..).enumerate() {
        if let Some(diagnostic) = source.diagnostic.take() {
            result.diagnostics.push(diagnostic);
        }
        let executable_known =
            adapter.executable.path.is_some() && adapter.executable.version.is_some();
        let selected_candidate = selected == Some(precedence);
        let effective = selected_candidate
            && executable_known
            && !source.compatibility_unknown
            && !source.is_alias;
        let (availability, reason) = if source.compatibility_unknown {
            (
                InstructionAvailability::CompatibilityUnknown,
                "Source resolves outside the supported Claude discovery boundary".to_string(),
            )
        } else if source.is_alias {
            (
                InstructionAvailability::CompatibilityUnknown,
                "Claude instruction alias support is not proven by the supported public contract"
                    .to_string(),
            )
        } else if selected_candidate && !executable_known {
            (
                InstructionAvailability::CompatibilityUnknown,
                "Claude Code executable or version evidence is unavailable".to_string(),
            )
        } else if effective {
            (
                InstructionAvailability::Available,
                "Selected by Claude Code native instruction hierarchy".to_string(),
            )
        } else if source
            .preview
            .as_ref()
            .is_some_and(|preview| preview.markdown.trim().is_empty())
        {
            (
                InstructionAvailability::Shadowed,
                "Empty instruction file is not effective".to_string(),
            )
        } else {
            (
                InstructionAvailability::Shadowed,
                "A higher-precedence Claude instruction entrypoint is effective".to_string(),
            )
        };
        let mut references = Vec::new();
        if let Some(preview) = &source.preview {
            let mut visited = HashSet::from([source
                .canonical_path
                .clone()
                .unwrap_or_else(|| path.to_path_buf())]);
            collect_references(
                path,
                &preview.markdown,
                allowed_root,
                1,
                &mut visited,
                &mut references,
                result,
            );
        }
        result.rows.push(InstructionRow {
            id: format!("claude-code:{}", path_string(path)),
            adapter_id: Some(adapter_id),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "CLAUDE.md".to_string()),
            path: path_string(path),
            canonical_path: source.canonical_path.as_deref().map(path_string),
            owner: owner.clone(),
            source_kind,
            availability,
            reason: Some(reason),
            discovery: InstructionDiscovery {
                policy: InstructionDiscoveryPolicy::ClaudeHierarchy,
                directory_depth,
                precedence,
                effective,
            },
            preview: source.preview,
            references,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_references(
    source_path: &Path,
    markdown: &str,
    allowed_root: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    references: &mut Vec<InstructionReference>,
    result: &mut DiscoveryResult,
) {
    if depth > MAX_IMPORT_DEPTH || references.len() >= MAX_IMPORT_REFERENCES {
        return;
    }
    let import_pattern = Regex::new(r"(?m)(?:^|\s)@([^\s`]+)").expect("valid import regex");
    for capture in import_pattern.captures_iter(markdown) {
        if references.len() >= MAX_IMPORT_REFERENCES {
            result.diagnostics.push(diagnostic(
                source_path,
                Some(SupportedAdapterId::ClaudeCode),
                "claude_import_limit",
                format!("Claude import graph exceeded {MAX_IMPORT_REFERENCES} references"),
            ));
            break;
        }
        let Some(token) = capture
            .get(1)
            .map(|value| trim_import_token(value.as_str()))
        else {
            continue;
        };
        if token.is_empty() || token.contains("://") {
            continue;
        }
        let Some(candidate) = resolve_import_path(source_path, token) else {
            continue;
        };
        result.observed_project_paths.push(path_string(&candidate));
        if !candidate.starts_with(allowed_root) {
            references.push(InstructionReference {
                path: path_string(&candidate),
                canonical_path: None,
                depth,
                availability: InstructionAvailability::CompatibilityUnknown,
                reason: Some(
                    "External Claude import requires client approval and was not read".to_string(),
                ),
                preview: None,
            });
            result.diagnostics.push(diagnostic(
                source_path,
                Some(SupportedAdapterId::ClaudeCode),
                "claude_import_external",
                format!(
                    "Claude import {} is outside the allowed scan boundary and requires client approval",
                    candidate.display()
                ),
            ));
            continue;
        }
        let Some(mut inspected) = inspect(
            &candidate,
            allowed_root,
            PREVIEW_BYTES,
            Some(SupportedAdapterId::ClaudeCode),
        ) else {
            references.push(InstructionReference {
                path: path_string(&candidate),
                canonical_path: None,
                depth,
                availability: InstructionAvailability::CompatibilityUnknown,
                reason: Some("Claude import target does not exist or is unreadable".to_string()),
                preview: None,
            });
            continue;
        };
        if let Some(diagnostic) = inspected.diagnostic.take() {
            result.diagnostics.push(diagnostic);
        }
        let canonical = inspected
            .canonical_path
            .clone()
            .unwrap_or_else(|| candidate.clone());
        if !visited.insert(canonical.clone()) {
            references.push(InstructionReference {
                path: path_string(&candidate),
                canonical_path: Some(path_string(&canonical)),
                depth,
                availability: InstructionAvailability::CompatibilityUnknown,
                reason: Some("Claude import cycle was stopped".to_string()),
                preview: None,
            });
            result.diagnostics.push(diagnostic(
                source_path,
                Some(SupportedAdapterId::ClaudeCode),
                "claude_import_cycle",
                format!("Claude import cycle includes {}", candidate.display()),
            ));
            continue;
        }
        let availability = if inspected.compatibility_unknown || inspected.is_alias {
            InstructionAvailability::CompatibilityUnknown
        } else {
            InstructionAvailability::Available
        };
        let preview = inspected.preview.clone();
        references.push(InstructionReference {
            path: path_string(&candidate),
            canonical_path: inspected.canonical_path.as_deref().map(path_string),
            depth,
            availability,
            reason: (availability == InstructionAvailability::CompatibilityUnknown)
                .then(|| "Claude import alias compatibility could not be proven".to_string()),
            preview,
        });
        if depth < MAX_IMPORT_DEPTH {
            if let Some(preview) = inspected.preview {
                collect_references(
                    &candidate,
                    &preview.markdown,
                    allowed_root,
                    depth + 1,
                    visited,
                    references,
                    result,
                );
            }
        } else if inspected
            .preview
            .as_ref()
            .is_some_and(|preview| import_pattern.is_match(&preview.markdown))
        {
            result.diagnostics.push(diagnostic(
                &candidate,
                Some(SupportedAdapterId::ClaudeCode),
                "claude_import_depth",
                format!("Claude import graph reached maximum depth {MAX_IMPORT_DEPTH}"),
            ));
        }
    }
}

fn trim_import_token(token: &str) -> &str {
    token.trim_end_matches(|character: char| {
        matches!(character, '.' | ',' | ';' | ':' | ')' | ']' | '}')
    })
}

fn resolve_import_path(source_path: &Path, token: &str) -> Option<PathBuf> {
    if token.starts_with('~') || Path::new(token).is_absolute() {
        return lexical_normalize(Path::new(token));
    }
    lexical_normalize(&source_path.parent()?.join(token))
}

fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    Some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn root_precedence_and_external_import_stay_explicit() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::create_dir(project.path().join(".claude")).unwrap();
        std::fs::write(project.path().join("CLAUDE.md"), "root\n@../outside.md").unwrap();
        std::fs::write(project.path().join(".claude/CLAUDE.md"), "shadowed").unwrap();
        let home = TempDir::new().unwrap();
        let environment = RegistryEnvironment::for_tests(home.path().to_path_buf());
        let adapter =
            &crate::supported_adapters::SupportedAdapterRegistry.snapshots(&environment)[1];

        let result = discover(
            project.path(),
            project.path(),
            &[project.path().to_path_buf()],
            &environment,
            adapter,
        );
        let root = result
            .rows
            .iter()
            .find(|row| row.path.ends_with("/CLAUDE.md") && !row.path.contains("/.claude/"))
            .unwrap();
        let shadowed = result
            .rows
            .iter()
            .find(|row| row.path.contains("/.claude/CLAUDE.md"))
            .unwrap();

        assert_eq!(root.availability, InstructionAvailability::Available);
        assert_eq!(shadowed.availability, InstructionAvailability::Shadowed);
        assert_eq!(
            root.references[0].availability,
            InstructionAvailability::CompatibilityUnknown
        );
        assert!(root.references[0].preview.is_none());
    }
}
