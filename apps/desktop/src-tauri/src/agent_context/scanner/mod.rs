mod claude;
mod codex;
mod io;
mod skills;

use std::path::{Path, PathBuf};

use crate::AppError;
use crate::agent_adapters::{AgentAdapterKind, AgentAdapterRegistry, SourceRegistryEnvironment};

use super::model::{
    AgentContextDiagnostic, AgentContextSnapshotContent, InstructionDiscovery,
    InstructionDiscoveryPolicy, InstructionOwner, InstructionOwnerKind, InstructionRow,
    InstructionSourceKind, SkillRow, SourceHealth, SourceResolution, SourceSupport,
};
use io::{inspect, path_string};

const RECOGNIZED_ROOT_FILES: &[&str] = &["GEMINI.md", "SOUL.md", "USER.md", "MEMORY.md"];
const DEFAULT_PREVIEW_BYTES: usize = 64 * 1024;

#[derive(Debug, Default)]
pub(super) struct DiscoveryResult {
    rows: Vec<InstructionRow>,
    skills: Vec<SkillRow>,
    diagnostics: Vec<AgentContextDiagnostic>,
    observed_project_paths: Vec<String>,
    observed_personal_paths: Vec<String>,
}

impl DiscoveryResult {
    fn append(&mut self, mut other: Self) {
        self.rows.append(&mut other.rows);
        self.skills.append(&mut other.skills);
        self.diagnostics.append(&mut other.diagnostics);
        self.observed_project_paths
            .append(&mut other.observed_project_paths);
        self.observed_personal_paths
            .append(&mut other.observed_personal_paths);
    }
}

pub fn scan(
    project_path: &Path,
    space_path: &Path,
    environment: &SourceRegistryEnvironment,
) -> Result<AgentContextSnapshotContent, AppError> {
    let project_root = canonical_directory(project_path, "project")?;
    let target_root = canonical_directory(space_path, "target space")?;
    let repository_root = nearest_repository_root(&target_root, &project_root);
    let directory_chain = root_to_target_chain(&repository_root, &target_root);
    let adapters = AgentAdapterRegistry.source_policies(environment);
    let mut result = DiscoveryResult::default();
    result.append(codex::discover(
        &repository_root,
        &target_root,
        &directory_chain,
        environment,
    ));
    result.append(claude::discover(
        &repository_root,
        &target_root,
        &directory_chain,
        environment,
    ));
    result.append(discover_recognized(&target_root));
    result.append(skills::discover(
        &repository_root,
        &directory_chain,
        &adapters,
    ));

    result.rows.sort_by(|left, right| {
        row_sort_key(left)
            .cmp(&row_sort_key(right))
            .then_with(|| left.path.cmp(&right.path))
    });
    result.diagnostics.sort_by(|left, right| {
        left.adapter_id
            .map(AgentAdapterKind::as_str)
            .cmp(&right.adapter_id.map(AgentAdapterKind::as_str))
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.code.cmp(&right.code))
    });
    result.skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.canonical_path.cmp(&right.canonical_path))
    });
    sort_dedup(&mut result.observed_project_paths);
    sort_dedup(&mut result.observed_personal_paths);

    Ok(AgentContextSnapshotContent {
        project_root: path_string(&project_root),
        target_root: path_string(&target_root),
        repository_root: path_string(&repository_root),
        adapters,
        instructions: result.rows,
        skills: result.skills,
        diagnostics: result.diagnostics,
        observed_project_paths: result.observed_project_paths,
        observed_personal_paths: result.observed_personal_paths,
    })
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, AppError> {
    let canonical = path.canonicalize().map_err(|error| {
        AppError::PathNotAccessible(format!(
            "could not resolve {label} {}: {error}",
            path.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(AppError::PathNotAccessible(format!(
            "{label} is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn nearest_repository_root(target: &Path, project: &Path) -> PathBuf {
    let mut current = Some(target);
    while let Some(path) = current {
        if path.join(".git").symlink_metadata().is_ok() {
            return path.to_path_buf();
        }
        current = path.parent();
    }
    if target.starts_with(project) {
        project.to_path_buf()
    } else {
        target.to_path_buf()
    }
}

fn root_to_target_chain(repository_root: &Path, target_root: &Path) -> Vec<PathBuf> {
    if !target_root.starts_with(repository_root) {
        return vec![target_root.to_path_buf()];
    }
    let mut chain = target_root
        .ancestors()
        .take_while(|path| path.starts_with(repository_root))
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    chain.reverse();
    chain
}

fn discover_recognized(target_root: &Path) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    for (precedence, filename) in RECOGNIZED_ROOT_FILES.iter().enumerate() {
        let path = target_root.join(filename);
        result.observed_project_paths.push(path_string(&path));
        let Some(mut source) = inspect(&path, target_root, DEFAULT_PREVIEW_BYTES, None) else {
            continue;
        };
        if let Some(diagnostic) = source.diagnostic.take() {
            let reason = diagnostic.message.clone();
            result.diagnostics.push(diagnostic);
            if source.preview.is_none() {
                continue;
            }
            result.rows.push(InstructionRow {
                id: format!("recognized:{}", path_string(&path)),
                adapter_id: None,
                name: (*filename).to_string(),
                path: path_string(&path),
                canonical_path: source.canonical_path.as_deref().map(path_string),
                link_kind: source.link_kind,
                owner: InstructionOwner {
                    kind: InstructionOwnerKind::TargetSpace,
                    root: path_string(target_root),
                },
                source_kind: InstructionSourceKind::Recognized,
                support: SourceSupport::SvodeRecognized,
                resolution: SourceResolution::Included,
                health: SourceHealth::Degraded,
                health_reasons: vec![reason],
                discovery: InstructionDiscovery {
                    policy: InstructionDiscoveryPolicy::TargetRootRecognition,
                    directory_depth: 0,
                    precedence,
                },
                preview: source.preview,
                references: Vec::new(),
            });
            continue;
        }
        let Some(preview) = source.preview else {
            continue;
        };
        result.rows.push(InstructionRow {
            id: format!("recognized:{}", path_string(&path)),
            adapter_id: None,
            name: (*filename).to_string(),
            path: path_string(&path),
            canonical_path: source.canonical_path.as_deref().map(path_string),
            link_kind: source.link_kind,
            owner: InstructionOwner {
                kind: InstructionOwnerKind::TargetSpace,
                root: path_string(target_root),
            },
            source_kind: InstructionSourceKind::Recognized,
            support: SourceSupport::SvodeRecognized,
            resolution: SourceResolution::Included,
            health: SourceHealth::Normal,
            health_reasons: Vec::new(),
            discovery: InstructionDiscovery {
                policy: InstructionDiscoveryPolicy::TargetRootRecognition,
                directory_depth: 0,
                precedence,
            },
            preview: Some(preview),
            references: Vec::new(),
        });
    }
    result
}

fn row_sort_key(row: &InstructionRow) -> (&str, u8, usize, usize) {
    let adapter = row
        .adapter_id
        .map_or("recognized", AgentAdapterKind::as_str);
    let source = match row.source_kind {
        InstructionSourceKind::Personal => 0,
        InstructionSourceKind::Project => 1,
        InstructionSourceKind::Recognized => 2,
    };
    (
        adapter,
        source,
        row.discovery.directory_depth,
        row.discovery.precedence,
    )
}

fn sort_dedup(values: &mut Vec<String>) {
    values.sort();
    values.dedup();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn repository_chain_stops_at_nearest_nested_git_boundary() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        let child = project.path().join("child");
        std::fs::create_dir_all(child.join(".git")).unwrap();
        let nested = child.join("docs");
        std::fs::create_dir(&nested).unwrap();

        assert_eq!(nearest_repository_root(&nested, project.path()), child);
        assert_eq!(root_to_target_chain(&child, &nested), vec![child, nested]);
    }

    #[test]
    fn root_inline_and_independent_targets_keep_native_repository_boundaries() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join("AGENTS.md"), "root").unwrap();
        let inline = project.path().join("inline");
        std::fs::create_dir(&inline).unwrap();
        std::fs::write(inline.join("AGENTS.md"), "inline").unwrap();
        let independent = project.path().join("independent");
        std::fs::create_dir(&independent).unwrap();
        std::fs::create_dir(independent.join(".git")).unwrap();
        std::fs::write(independent.join("AGENTS.md"), "independent").unwrap();
        let home = TempDir::new().unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());

        let root = scan(project.path(), project.path(), &environment).unwrap();
        let inline_snapshot = scan(project.path(), &inline, &environment).unwrap();
        let independent_snapshot = scan(project.path(), &independent, &environment).unwrap();
        let codex_project_paths = |snapshot: &AgentContextSnapshotContent| {
            snapshot
                .instructions
                .iter()
                .filter(|row| {
                    row.adapter_id == Some(AgentAdapterKind::Codex)
                        && row.source_kind == InstructionSourceKind::Project
                })
                .map(|row| row.path.clone())
                .collect::<Vec<_>>()
        };

        assert_eq!(codex_project_paths(&root).len(), 1);
        let transport = serde_json::to_value(&root).unwrap();
        assert_eq!(transport["adapters"][0]["id"], "codex");
        assert_eq!(transport["adapters"][1]["id"], "claude-code");
        assert!(transport["targetRoot"].is_string());
        assert!(transport["instructions"].is_array());
        assert_eq!(transport["instructions"][0]["linkKind"], "direct");
        assert!(transport["skills"].is_array());
        assert!(transport["adapters"][0].get("executable").is_none());
        assert!(
            root.diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "adapter_executable")
        );
        assert_eq!(codex_project_paths(&inline_snapshot).len(), 2);
        let independent_paths = codex_project_paths(&independent_snapshot);
        assert_eq!(independent_paths.len(), 1);
        assert!(independent_paths[0].ends_with("/independent/AGENTS.md"));
        assert_eq!(
            independent_snapshot.repository_root,
            path_string(&independent.canonicalize().unwrap())
        );
    }

    #[test]
    fn recognized_files_are_exact_target_root_only() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join("GEMINI.md"), "root gemini").unwrap();
        let child = project.path().join("child");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("MEMORY.md"), "child memory").unwrap();
        let home = TempDir::new().unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());

        let snapshot = scan(project.path(), &child, &environment).unwrap();
        let recognized = snapshot
            .instructions
            .iter()
            .filter(|row| row.adapter_id.is_none())
            .collect::<Vec<_>>();

        assert_eq!(recognized.len(), 1);
        assert_eq!(recognized[0].name, "MEMORY.md");
        assert_eq!(recognized[0].support, SourceSupport::SvodeRecognized);
        assert!(recognized[0].path.ends_with("/child/MEMORY.md"));
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_alias_is_diagnostic_and_does_not_break_other_adapter_rows() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::write(project.path().join("CLAUDE.md"), "safe claude").unwrap();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.md");
        std::fs::write(&secret, "must not be previewed").unwrap();
        symlink(&secret, project.path().join("AGENTS.md")).unwrap();
        let home = TempDir::new().unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let claude = snapshot
            .instructions
            .iter()
            .find(|row| row.adapter_id == Some(AgentAdapterKind::ClaudeCode))
            .unwrap();

        assert_eq!(claude.health, SourceHealth::Normal);
        assert!(
            snapshot
                .instructions
                .iter()
                .all(|row| row.path != path_string(&project.path().join("AGENTS.md")))
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "instruction_outside_boundary")
        );
        assert!(!format!("{snapshot:?}").contains("must not be previewed"));
    }
}
