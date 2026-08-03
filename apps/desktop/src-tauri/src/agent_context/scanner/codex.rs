use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::supported_adapters::{
    RegistryEnvironment, SupportedAdapterId, SupportedAdapterSnapshot,
};

use super::super::model::{
    AgentContextDiagnostic, InstructionAvailability, InstructionDiscovery,
    InstructionDiscoveryPolicy, InstructionOwner, InstructionOwnerKind, InstructionRow,
    InstructionSourceKind,
};
use super::DiscoveryResult;
use super::io::{InspectedSource, diagnostic, inspect, path_string};

const DEFAULT_PROJECT_DOC_BYTES: usize = 32 * 1024;
const MAX_PROJECT_DOC_BYTES: usize = 256 * 1024;
const CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Debug, Default, Deserialize)]
struct CodexConfig {
    #[serde(default)]
    project_doc_fallback_filenames: Vec<String>,
    project_doc_max_bytes: Option<usize>,
}

pub(super) fn discover(
    repository_root: &Path,
    _target_root: &Path,
    directory_chain: &[PathBuf],
    environment: &RegistryEnvironment,
    adapter: &SupportedAdapterSnapshot,
) -> DiscoveryResult {
    let adapter_id = SupportedAdapterId::Codex;
    let (config, mut result) = read_config(environment, adapter_id);
    let max_bytes = config
        .project_doc_max_bytes
        .unwrap_or(DEFAULT_PROJECT_DOC_BYTES)
        .clamp(1, MAX_PROJECT_DOC_BYTES);
    let fallbacks = validated_fallbacks(
        &config.project_doc_fallback_filenames,
        &environment.codex_home,
        &mut result.diagnostics,
    );

    let personal_candidates = ["AGENTS.override.md", "AGENTS.md"]
        .into_iter()
        .map(|name| environment.codex_home.join(name))
        .collect::<Vec<_>>();
    result
        .observed_personal_paths
        .extend(personal_candidates.iter().map(|path| path_string(path)));
    discover_group(
        &personal_candidates,
        &environment.codex_home,
        InstructionSourceKind::Personal,
        InstructionOwner {
            kind: InstructionOwnerKind::ClientConfiguration,
            root: path_string(&environment.codex_home),
        },
        InstructionDiscoveryPolicy::CodexUserPrecedence,
        0,
        max_bytes,
        adapter,
        &mut result,
    );

    let mut active_budget = max_bytes;
    for (directory_depth, directory) in directory_chain.iter().enumerate() {
        let mut candidates = vec![
            directory.join("AGENTS.override.md"),
            directory.join("AGENTS.md"),
        ];
        candidates.extend(fallbacks.iter().map(|name| directory.join(name)));
        result
            .observed_project_paths
            .extend(candidates.iter().map(|path| path_string(path)));
        let before = result.rows.len();
        discover_group(
            &candidates,
            repository_root,
            InstructionSourceKind::Project,
            InstructionOwner {
                kind: InstructionOwnerKind::TargetSpace,
                root: path_string(directory),
            },
            InstructionDiscoveryPolicy::CodexDirectoryPrecedence,
            directory_depth,
            max_bytes,
            adapter,
            &mut result,
        );
        for row in &mut result.rows[before..] {
            if row.discovery.effective {
                apply_active_budget(row, &mut active_budget, &mut result.diagnostics);
            }
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn discover_group(
    candidates: &[PathBuf],
    allowed_root: &Path,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
    policy: InstructionDiscoveryPolicy,
    directory_depth: usize,
    max_bytes: usize,
    adapter: &SupportedAdapterSnapshot,
    result: &mut DiscoveryResult,
) {
    let adapter_id = SupportedAdapterId::Codex;
    let mut inspected = candidates
        .iter()
        .filter_map(|path| {
            inspect(path, allowed_root, max_bytes, Some(adapter_id)).map(|source| (path, source))
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
        let effective = selected == Some(precedence)
            && !source.compatibility_unknown
            && adapter.executable.path.is_some()
            && adapter.executable.version.is_some();
        let (availability, reason) = if source.compatibility_unknown {
            (
                InstructionAvailability::CompatibilityUnknown,
                "Source could not be proven safe inside the supported discovery boundary"
                    .to_string(),
            )
        } else if selected == Some(precedence) && !effective {
            (
                InstructionAvailability::CompatibilityUnknown,
                "Codex executable or version evidence is unavailable".to_string(),
            )
        } else if effective {
            (
                InstructionAvailability::Available,
                "Selected by Codex native instruction precedence".to_string(),
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
                "A higher-precedence Codex entrypoint is effective in this directory".to_string(),
            )
        };
        result.rows.push(instruction_row(
            path,
            source,
            source_kind,
            owner.clone(),
            policy,
            directory_depth,
            precedence,
            effective,
            availability,
            reason,
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn instruction_row(
    path: &Path,
    source: InspectedSource,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
    policy: InstructionDiscoveryPolicy,
    directory_depth: usize,
    precedence: usize,
    effective: bool,
    availability: InstructionAvailability,
    reason: String,
) -> InstructionRow {
    InstructionRow {
        id: format!("codex:{}", path_string(path)),
        adapter_id: Some(SupportedAdapterId::Codex),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "AGENTS.md".to_string()),
        path: path_string(path),
        canonical_path: source.canonical_path.as_deref().map(path_string),
        owner,
        source_kind,
        availability,
        reason: Some(reason),
        discovery: InstructionDiscovery {
            policy,
            directory_depth,
            precedence,
            effective,
        },
        preview: source.preview,
        references: Vec::new(),
    }
}

fn apply_active_budget(
    row: &mut InstructionRow,
    remaining: &mut usize,
    diagnostics: &mut Vec<AgentContextDiagnostic>,
) {
    let Some(preview) = &mut row.preview else {
        return;
    };
    if preview.bytes_read <= *remaining {
        *remaining -= preview.bytes_read;
        return;
    }
    let boundary = floor_char_boundary(&preview.markdown, *remaining);
    preview.markdown.truncate(boundary);
    preview.bytes_read = boundary;
    preview.truncated = true;
    *remaining = 0;
    diagnostics.push(diagnostic(
        Path::new(&row.path),
        row.adapter_id,
        "codex_project_doc_limit",
        "Codex active project instruction chain exceeded project_doc_max_bytes".to_string(),
    ));
}

fn floor_char_boundary(value: &str, requested: usize) -> usize {
    let mut boundary = requested.min(value.len());
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    boundary
}

fn read_config(
    environment: &RegistryEnvironment,
    adapter_id: SupportedAdapterId,
) -> (CodexConfig, DiscoveryResult) {
    let config_path = environment.codex_home.join("config.toml");
    let mut result = DiscoveryResult::default();
    result
        .observed_personal_paths
        .push(path_string(&config_path));
    let file = match std::fs::File::open(&config_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (CodexConfig::default(), result);
        }
        Err(error) => {
            result.diagnostics.push(diagnostic(
                &config_path,
                Some(adapter_id),
                "codex_config_read",
                format!("Could not read Codex config: {error}"),
            ));
            return (CodexConfig::default(), result);
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file.take(CONFIG_BYTES + 1).read_to_end(&mut bytes) {
        result.diagnostics.push(diagnostic(
            &config_path,
            Some(adapter_id),
            "codex_config_read",
            format!("Could not read Codex config: {error}"),
        ));
        return (CodexConfig::default(), result);
    }
    if bytes.len() > CONFIG_BYTES as usize {
        result.diagnostics.push(diagnostic(
            &config_path,
            Some(adapter_id),
            "codex_config_limit",
            "Codex config exceeds the supported 64 KiB scan limit".to_string(),
        ));
        return (CodexConfig::default(), result);
    }
    match toml::from_str(&String::from_utf8_lossy(&bytes)) {
        Ok(config) => (config, result),
        Err(error) => {
            result.diagnostics.push(diagnostic(
                &config_path,
                Some(adapter_id),
                "codex_config_parse",
                format!("Could not parse supported Codex config fields: {error}"),
            ));
            (CodexConfig::default(), result)
        }
    }
}

fn validated_fallbacks(
    configured: &[String],
    config_root: &Path,
    diagnostics: &mut Vec<AgentContextDiagnostic>,
) -> Vec<String> {
    let mut valid = Vec::new();
    for value in configured {
        let path = Path::new(value);
        let basename_only = path.components().count() == 1
            && path.file_name().is_some()
            && value != "AGENTS.md"
            && value != "AGENTS.override.md";
        if basename_only && !valid.contains(value) {
            valid.push(value.clone());
        } else if !basename_only {
            diagnostics.push(diagnostic(
                &config_root.join("config.toml"),
                Some(SupportedAdapterId::Codex),
                "codex_fallback_ignored",
                format!("Ignored unsafe Codex project doc fallback filename: {value}"),
            ));
        }
    }
    valid
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn override_shadows_agents_and_fallback_in_one_directory() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join("AGENTS.override.md"), "override").unwrap();
        std::fs::write(project.path().join("AGENTS.md"), "agents").unwrap();
        let home = TempDir::new().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::write(
            home.path().join(".codex/config.toml"),
            "project_doc_fallback_filenames = [\"GUIDE.md\"]",
        )
        .unwrap();
        std::fs::write(project.path().join("GUIDE.md"), "fallback").unwrap();
        let environment = RegistryEnvironment::for_tests(home.path().to_path_buf());
        let adapter =
            &crate::supported_adapters::SupportedAdapterRegistry.snapshots(&environment)[0];

        let result = discover(
            project.path(),
            project.path(),
            &[project.path().to_path_buf()],
            &environment,
            adapter,
        );
        let project_rows = result
            .rows
            .iter()
            .filter(|row| row.source_kind == InstructionSourceKind::Project)
            .collect::<Vec<_>>();

        assert_eq!(project_rows.len(), 3);
        assert_eq!(
            project_rows[0].availability,
            InstructionAvailability::Available
        );
        assert!(project_rows[0].discovery.effective);
        assert!(
            project_rows[1..]
                .iter()
                .all(|row| row.availability == InstructionAvailability::Shadowed)
        );
    }
}
