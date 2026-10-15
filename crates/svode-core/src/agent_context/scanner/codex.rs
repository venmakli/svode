use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};

use super::super::model::{
    AgentContextDiagnostic, InstructionDiscovery, InstructionDiscoveryPolicy, InstructionOwner,
    InstructionOwnerKind, InstructionRow, InstructionSourceKind, SourceHealth, SourceResolution,
    SourceSupport,
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
    #[serde(default)]
    plugins: BTreeMap<String, CodexPlugin>,
}

/// Only whether a plugin is on; its MCP overrides are not read.
#[derive(Debug, Default, Deserialize)]
struct CodexPlugin {
    enabled: Option<bool>,
}

/// `global` reads the Codex home: its config and personal instructions.
pub(super) fn discover(
    repository_root: &Path,
    _target_root: &Path,
    directory_chain: &[PathBuf],
    environment: &SourceRegistryEnvironment,
    global: bool,
) -> DiscoveryResult {
    let adapter_id = AgentAdapterKind::Codex;
    let (config, mut result) = if global {
        read_config(environment, adapter_id)
    } else {
        (CodexConfig::default(), DiscoveryResult::default())
    };
    let max_bytes = config
        .project_doc_max_bytes
        .unwrap_or(DEFAULT_PROJECT_DOC_BYTES)
        .clamp(1, MAX_PROJECT_DOC_BYTES);
    let fallbacks = validated_fallbacks(
        &config.project_doc_fallback_filenames,
        &environment.codex_home,
        &mut result.diagnostics,
    );

    if global {
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
            true,
            &mut result,
        );
    }

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
            false,
            &mut result,
        );
        for row in &mut result.rows[before..] {
            if row.resolution == SourceResolution::Selected {
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
    skip_blank: bool,
    result: &mut DiscoveryResult,
) {
    let adapter_id = AgentAdapterKind::Codex;
    // In the Codex home a blank file counts as missing: an empty
    // `AGENTS.override.md` there falls through to `AGENTS.md`. In a project
    // directory any existing file is the directory's one file.
    let mut inspected = candidates
        .iter()
        .filter_map(|path| {
            inspect(path, allowed_root, max_bytes, Some(adapter_id)).map(|source| (path, source))
        })
        .filter(|(_, source)| {
            !skip_blank
                || source
                    .preview
                    .as_ref()
                    .is_none_or(|preview| !preview.markdown.trim().is_empty())
        })
        .collect::<Vec<_>>();
    let selected = inspected
        .iter()
        .position(|(_, source)| source.preview.is_some());
    let selected_path = selected.map(|index| path_string(inspected[index].0));

    for (precedence, (path, mut source)) in inspected.drain(..).enumerate() {
        let mut health_reasons = Vec::new();
        if let Some(diagnostic) = source.diagnostic.take() {
            health_reasons.push(diagnostic.message.clone());
            result.diagnostics.push(diagnostic);
        }
        if source.preview.is_none() {
            continue;
        }
        let effective = selected == Some(precedence);
        result.rows.push(instruction_row(
            path,
            source,
            source_kind,
            owner.clone(),
            policy,
            directory_depth,
            precedence,
            if effective {
                SourceResolution::Selected
            } else {
                SourceResolution::Superseded
            },
            if effective {
                None
            } else {
                selected_path.clone()
            },
            health_reasons,
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
    resolution: SourceResolution,
    superseded_by: Option<String>,
    health_reasons: Vec<String>,
) -> InstructionRow {
    InstructionRow {
        id: format!("codex:{}", path_string(path)),
        adapter_id: Some(AgentAdapterKind::Codex),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "AGENTS.md".to_string()),
        path: path_string(path),
        canonical_path: source.canonical_path.as_deref().map(path_string),
        link_kind: source.link_kind,
        owner,
        source_kind,
        support: SourceSupport::ClientNative,
        resolution,
        health: if health_reasons.is_empty() {
            SourceHealth::Normal
        } else {
            SourceHealth::Degraded
        },
        health_reasons,
        discovery: InstructionDiscovery {
            policy,
            directory_depth,
            precedence,
        },
        superseded_by,
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
    let message = "Codex active project instruction chain exceeded project_doc_max_bytes";
    diagnostics.push(diagnostic(
        Path::new(&row.path),
        row.adapter_id,
        "codex_project_doc_limit",
        message.to_string(),
    ));
    row.health = SourceHealth::Degraded;
    row.health_reasons.push(message.to_string());
}

fn floor_char_boundary(value: &str, requested: usize) -> usize {
    let mut boundary = requested.min(value.len());
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    boundary
}

fn read_config(
    environment: &SourceRegistryEnvironment,
    adapter_id: AgentAdapterKind,
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
    let text = String::from_utf8_lossy(&bytes);
    match toml::from_str(&text) {
        Ok(config) => (config, result),
        Err(error) => {
            // The parser's own message may quote the file, which can hold
            // secrets; the diagnostic names only the line.
            let line = error
                .span()
                .and_then(|span| text.get(..span.start))
                .map(|prefix| prefix.matches('\n').count() + 1);
            result.diagnostics.push(diagnostic(
                &config_path,
                Some(adapter_id),
                "codex_config_parse",
                match line {
                    Some(line) => {
                        format!("Could not parse supported Codex config fields at line {line}")
                    }
                    None => "Could not parse supported Codex config fields".to_string(),
                },
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
                Some(AgentAdapterKind::Codex),
                "codex_fallback_ignored",
                format!("Ignored unsafe Codex project doc fallback filename: {value}"),
            ));
        }
    }
    valid
}

/// `[plugins."<plugin>@<marketplace>"] enabled` of the Codex config; a table
/// without `enabled` is on.
pub(super) fn plugin_switches(
    environment: &SourceRegistryEnvironment,
    result: &mut DiscoveryResult,
) -> BTreeMap<String, bool> {
    let (config, read) = read_config(environment, AgentAdapterKind::Codex);
    result.append(read);
    config
        .plugins
        .into_iter()
        .map(|(id, plugin)| (id, plugin.enabled.unwrap_or(true)))
        .collect()
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
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());

        let result = discover(
            project.path(),
            project.path(),
            &[project.path().to_path_buf()],
            &environment,
            true,
        );
        let project_rows = result
            .rows
            .iter()
            .filter(|row| row.source_kind == InstructionSourceKind::Project)
            .collect::<Vec<_>>();

        assert_eq!(project_rows.len(), 3);
        assert_eq!(project_rows[0].resolution, SourceResolution::Selected);
        assert!(
            project_rows[1..]
                .iter()
                .all(|row| row.resolution == SourceResolution::Superseded)
        );
    }

    #[test]
    fn empty_readable_override_remains_the_selected_source() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join("AGENTS.override.md"), "").unwrap();
        std::fs::write(project.path().join("AGENTS.md"), "agents").unwrap();
        let home = TempDir::new().unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());

        let result = discover(
            project.path(),
            project.path(),
            &[project.path().to_path_buf()],
            &environment,
            true,
        );
        let project_rows = result
            .rows
            .iter()
            .filter(|row| row.source_kind == InstructionSourceKind::Project)
            .collect::<Vec<_>>();

        assert_eq!(project_rows.len(), 2);
        assert_eq!(project_rows[0].resolution, SourceResolution::Selected);
        assert_eq!(project_rows[0].preview.as_ref().unwrap().markdown, "");
        assert_eq!(project_rows[0].health, SourceHealth::Normal);
        assert_eq!(project_rows[1].resolution, SourceResolution::Superseded);
    }

    fn personal_rows(home: &Path) -> DiscoveryResult {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.to_path_buf());
        discover(
            project.path(),
            project.path(),
            &[project.path().to_path_buf()],
            &environment,
            true,
        )
    }

    #[test]
    fn a_blank_home_override_falls_through_to_home_agents_md() {
        let home = TempDir::new().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::write(home.path().join(".codex/AGENTS.override.md"), " \n").unwrap();
        std::fs::write(home.path().join(".codex/AGENTS.md"), "home").unwrap();

        let result = personal_rows(home.path());

        assert_eq!(result.rows.len(), 1);
        assert!(result.rows[0].path.ends_with("/.codex/AGENTS.md"));
        assert_eq!(result.rows[0].resolution, SourceResolution::Selected);
    }

    #[test]
    fn a_home_override_with_text_shadows_home_agents_md() {
        let home = TempDir::new().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::write(home.path().join(".codex/AGENTS.override.md"), "override").unwrap();
        std::fs::write(home.path().join(".codex/AGENTS.md"), "home").unwrap();

        let result = personal_rows(home.path());

        let agents = result
            .rows
            .iter()
            .find(|row| row.path.ends_with("/.codex/AGENTS.md"))
            .unwrap();
        assert_eq!(agents.resolution, SourceResolution::Superseded);
        assert!(
            agents
                .superseded_by
                .as_deref()
                .unwrap()
                .ends_with("/AGENTS.override.md")
        );
    }

    #[test]
    fn an_unparseable_config_is_a_diagnostic_that_does_not_quote_the_file() {
        let home = TempDir::new().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::write(
            home.path().join(".codex/config.toml"),
            "model = \"m\"\n[mcp_servers.x.env]\nTOKEN = \"sk-do-not-show\n",
        )
        .unwrap();

        let result = personal_rows(home.path());

        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "codex_config_parse")
            .unwrap();
        assert!(
            diagnostic.message.ends_with("at line 3"),
            "{}",
            diagnostic.message
        );
        assert!(!format!("{:?}", result.diagnostics).contains("sk-do-not-show"));
    }
}
