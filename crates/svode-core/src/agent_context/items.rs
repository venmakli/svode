//! The "Context" set of a target (Stage 10 `05`): one item per canonical
//! source, whichever agents and paths find it, with its application by the
//! enabled agents.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};

use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};

use super::model::{
    AgentContextDiscovery, AgentContextSnapshotContent, ContextItem, ContextItemKind,
    ContextItemReader, ContextItemSource, ContextLocation, ContextLocationKind, ContextSkillFacts,
    InstructionReference, InstructionRow, SkillRow, SourceHealth, SourceLinkKind, SourceResolution,
    SourceSupport, UnappliedReason,
};

/// How one agent finds an item by one path.
struct Finding {
    agent: AgentAdapterKind,
    path: String,
    target: Option<String>,
    link_kind: SourceLinkKind,
    /// Set when the agent takes another file instead.
    superseded_by: Option<String>,
}

pub(super) fn snapshot(
    discovery: AgentContextDiscovery,
    environment: &SourceRegistryEnvironment,
    enabled_agents: &[AgentAdapterKind],
) -> AgentContextSnapshotContent {
    let enabled = enabled_agents.iter().copied().collect::<BTreeSet<_>>();
    let places = Places {
        target_root: PathBuf::from(&discovery.target_root),
        repository_root: PathBuf::from(&discovery.repository_root),
        home: environment
            .home_dir
            .canonicalize()
            .unwrap_or_else(|_| environment.home_dir.clone()),
    };
    let mut items = instruction_items(&discovery.instructions, &places, &enabled);
    items.extend(
        discovery
            .skills
            .iter()
            .map(|row| skill_item(row, &places, &enabled)),
    );
    items.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });

    AgentContextSnapshotContent {
        project_root: discovery.project_root,
        target_root: discovery.target_root,
        repository_root: discovery.repository_root,
        enabled_agents: enabled.into_iter().collect(),
        items,
        diagnostics: discovery.diagnostics,
        observed_project_paths: discovery.observed_project_paths,
        observed_personal_paths: discovery.observed_personal_paths,
    }
}

/// One item per canonical instruction file. Files only Svode recognizes are
/// read by no agent and are not items.
fn instruction_items(
    rows: &[InstructionRow],
    places: &Places,
    enabled: &BTreeSet<AgentAdapterKind>,
) -> Vec<ContextItem> {
    let mut groups = BTreeMap::<String, Vec<&InstructionRow>>::new();
    for row in rows {
        if row.support != SourceSupport::ClientNative
            || row.adapter_id.is_none()
            || row.preview.is_none()
        {
            continue;
        }
        let canonical = row
            .canonical_path
            .clone()
            .unwrap_or_else(|| row.path.clone());
        groups.entry(canonical).or_default().push(row);
    }

    groups
        .into_iter()
        .filter_map(|(canonical, rows)| {
            // Agents may read a different amount of the same file; the item
            // shows the fullest read.
            let preview = rows
                .iter()
                .filter_map(|row| row.preview.as_ref())
                .max_by_key(|preview| preview.bytes_read)?
                .clone();
            let canonical_path = Path::new(&canonical);
            let owner = &rows[0].owner.root;
            let owner_root = if canonical_path.starts_with(owner) {
                owner.clone()
            } else {
                path_string(&places.repository_root)
            };
            let mut references = Vec::<InstructionReference>::new();
            for reference in rows.iter().flat_map(|row| &row.references) {
                if !references
                    .iter()
                    .any(|known| known.path == reference.path && known.status == reference.status)
                {
                    references.push(reference.clone());
                }
            }
            let findings = rows
                .iter()
                .map(|row| Finding {
                    agent: row.adapter_id.expect("filtered to agent rows"),
                    path: row.path.clone(),
                    target: (row.link_kind != SourceLinkKind::Direct).then(|| canonical.clone()),
                    link_kind: row.link_kind,
                    superseded_by: superseded_by(row.resolution, &row.superseded_by),
                })
                .collect::<Vec<_>>();
            let (health, health_reasons) =
                merged_health(rows.iter().map(|row| (row.health, &row.health_reasons)));
            Some(item(
                ItemFacts {
                    id: format!("instruction:{canonical}"),
                    kind: ContextItemKind::Instruction,
                    name: canonical_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| canonical.clone()),
                    description: None,
                    location: places.location(canonical_path.parent().unwrap_or(canonical_path)),
                    modified_at: modified_at(canonical_path),
                    path: canonical.clone(),
                    owner_root,
                    health,
                    health_reasons,
                    preview,
                    references,
                    skill: None,
                },
                findings,
                enabled,
            ))
        })
        .collect()
}

fn skill_item(
    row: &SkillRow,
    places: &Places,
    enabled: &BTreeSet<AgentAdapterKind>,
) -> ContextItem {
    let canonical = Path::new(&row.canonical_path);
    let findings = row
        .aliases
        .iter()
        .map(|alias| Finding {
            agent: alias.adapter_id,
            path: alias.path.clone(),
            target: (alias.link_kind != SourceLinkKind::Direct).then(|| row.canonical_path.clone()),
            link_kind: alias.link_kind,
            superseded_by: superseded_by(alias.resolution, &alias.superseded_by),
        })
        .collect();
    item(
        ItemFacts {
            id: row.id.clone(),
            kind: ContextItemKind::Skill,
            name: row.name.clone(),
            description: Some(row.description.clone()),
            location: places.location(canonical.parent().unwrap_or(canonical)),
            modified_at: modified_at(Path::new(&row.path)),
            path: row.path.clone(),
            owner_root: row.owner.root.clone(),
            health: row.health,
            health_reasons: row.health_reasons.clone(),
            preview: row.preview.clone(),
            references: Vec::new(),
            skill: Some(ContextSkillFacts {
                license: row.license.clone(),
                compatibility: row.compatibility.clone(),
                metadata: row.metadata.clone(),
                allowed_tools: row.allowed_tools.clone(),
            }),
        },
        findings,
        enabled,
    )
}

struct ItemFacts {
    id: String,
    kind: ContextItemKind,
    name: String,
    description: Option<String>,
    location: ContextLocation,
    modified_at: Option<String>,
    path: String,
    owner_root: String,
    health: SourceHealth,
    health_reasons: Vec<String>,
    preview: super::model::MarkdownPreview,
    references: Vec<InstructionReference>,
    skill: Option<ContextSkillFacts>,
}

/// "Providers" are the enabled agents that apply the item. Sources keep the
/// paths by which enabled agents find it; agents that do not are left out.
fn item(
    facts: ItemFacts,
    findings: Vec<Finding>,
    enabled: &BTreeSet<AgentAdapterKind>,
) -> ContextItem {
    let readers = findings
        .iter()
        .map(|finding| finding.agent)
        .collect::<BTreeSet<_>>();
    let enabled_findings = findings
        .into_iter()
        .filter(|finding| enabled.contains(&finding.agent))
        .collect::<Vec<_>>();
    let providers = enabled_findings
        .iter()
        .filter(|finding| finding.superseded_by.is_none())
        .map(|finding| finding.agent)
        .collect::<BTreeSet<_>>();
    let unapplied = if !providers.is_empty() {
        None
    } else if enabled_findings.is_empty() {
        Some(UnappliedReason::NotFound {
            readers: readers.into_iter().collect(),
        })
    } else {
        Some(UnappliedReason::Superseded {
            by: enabled_findings
                .iter()
                .filter_map(|finding| finding.superseded_by.clone())
                .filter(|by| !by.is_empty())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        })
    };

    let mut sources = BTreeMap::<String, ContextItemSource>::new();
    for finding in enabled_findings {
        let source = sources
            .entry(finding.path.clone())
            .or_insert_with(|| ContextItemSource {
                path: finding.path,
                target: finding.target,
                link_kind: finding.link_kind,
                readers: Vec::new(),
            });
        if source
            .readers
            .iter()
            .all(|reader| reader.agent != finding.agent)
        {
            source.readers.push(ContextItemReader {
                agent: finding.agent,
                superseded_by: finding.superseded_by,
            });
        }
    }
    for source in sources.values_mut() {
        source.readers.sort_by_key(|reader| reader.agent);
    }

    ContextItem {
        id: facts.id,
        kind: facts.kind,
        name: facts.name,
        description: facts.description,
        path: facts.path,
        owner_root: facts.owner_root,
        location: facts.location,
        modified_at: facts.modified_at,
        health: facts.health,
        health_reasons: facts.health_reasons,
        providers: providers.into_iter().collect(),
        unapplied,
        sources: sources.into_values().collect(),
        preview: facts.preview,
        references: facts.references,
        skill: facts.skill,
    }
}

/// A shadowed path always names what shadows it, empty when unknown.
fn superseded_by(resolution: SourceResolution, by: &Option<String>) -> Option<String> {
    (resolution == SourceResolution::Superseded).then(|| by.clone().unwrap_or_default())
}

fn merged_health<'a>(
    rows: impl Iterator<Item = (SourceHealth, &'a Vec<String>)>,
) -> (SourceHealth, Vec<String>) {
    let mut health = SourceHealth::Normal;
    let mut reasons = Vec::<String>::new();
    for (row_health, row_reasons) in rows {
        if row_health == SourceHealth::Degraded {
            health = SourceHealth::Degraded;
        }
        for reason in row_reasons {
            if !reasons.contains(reason) {
                reasons.push(reason.clone());
            }
        }
    }
    (health, reasons)
}

struct Places {
    target_root: PathBuf,
    repository_root: PathBuf,
    home: PathBuf,
}

impl Places {
    /// A short path: inside the repository boundary from the target root, in
    /// the home directory from `~`, otherwise absolute.
    fn location(&self, directory: &Path) -> ContextLocation {
        if directory.starts_with(&self.repository_root) {
            return ContextLocation {
                kind: ContextLocationKind::Target,
                path: path_string(&relative_path(&self.target_root, directory)),
            };
        }
        if let Ok(rest) = directory.strip_prefix(&self.home) {
            return ContextLocation {
                kind: ContextLocationKind::Home,
                path: path_string(rest),
            };
        }
        ContextLocation {
            kind: ContextLocationKind::Absolute,
            path: path_string(directory),
        }
    }
}

/// `to` relative to `from`, going up with `..` where `to` lies above it.
fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from = from.components().collect::<Vec<_>>();
    let to = to.components().collect::<Vec<_>>();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = PathBuf::new();
    for _ in common..from.len() {
        relative.push(Component::ParentDir.as_os_str());
    }
    for component in &to[common..] {
        relative.push(component.as_os_str());
    }
    relative
}

pub(super) fn modified_at(path: &Path) -> Option<String> {
    let time = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()?;
    let date: DateTime<Utc> = time.into();
    Some(date.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_context::scanner::scan;
    use tempfile::TempDir;

    const CODEX: AgentAdapterKind = AgentAdapterKind::Codex;
    const CLAUDE: AgentAdapterKind = AgentAdapterKind::ClaudeCode;

    struct Fixture {
        project: TempDir,
        _home: TempDir,
        environment: SourceRegistryEnvironment,
    }

    impl Fixture {
        fn new() -> Self {
            let project = TempDir::new().unwrap();
            fs::create_dir(project.path().join(".git")).unwrap();
            let home = TempDir::new().unwrap();
            let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
            Self {
                project,
                _home: home,
                environment,
            }
        }

        fn write(&self, root: &Path, relative: &str, text: &str) -> PathBuf {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path.canonicalize().unwrap()
        }

        fn home(&self) -> &Path {
            &self.environment.home_dir
        }

        fn items(&self, enabled: &[AgentAdapterKind]) -> Vec<ContextItem> {
            scan(
                self.project.path(),
                self.project.path(),
                &self.environment,
                enabled,
            )
            .unwrap()
            .items
        }
    }

    fn skill(name: &str) -> String {
        format!("---\nname: {name}\ndescription: {name} skill\n---\n# {name}\n")
    }

    fn by_path<'a>(items: &'a [ContextItem], path: &Path) -> &'a ContextItem {
        let path = path_string(path);
        items
            .iter()
            .find(|item| item.path == path)
            .unwrap_or_else(|| panic!("no item {path} in {items:#?}"))
    }

    #[test]
    fn project_items_stay_without_enabled_agents_and_name_their_readers() {
        let fixture = Fixture::new();
        let agents = fixture.write(fixture.project.path(), "AGENTS.md", "project");
        fixture.write(fixture.home(), ".codex/AGENTS.md", "personal");
        fixture.write(fixture.home(), ".claude/CLAUDE.md", "personal");

        let items = fixture.items(&[]);

        assert_eq!(items.len(), 1);
        let item = by_path(&items, &agents);
        assert_eq!(item.kind, ContextItemKind::Instruction);
        assert!(item.providers.is_empty());
        assert_eq!(
            item.unapplied,
            Some(UnappliedReason::NotFound {
                readers: vec![CODEX]
            })
        );
        assert!(item.sources.is_empty());
        assert_eq!(
            item.location,
            ContextLocation {
                kind: ContextLocationKind::Target,
                path: String::new()
            }
        );
        assert!(item.modified_at.is_some());
    }

    #[test]
    fn global_sources_appear_only_for_enabled_agents() {
        let fixture = Fixture::new();
        fixture.write(fixture.project.path(), "AGENTS.md", "project");
        let codex_personal = fixture.write(fixture.home(), ".codex/AGENTS.md", "personal");
        let claude_personal = fixture.write(fixture.home(), ".claude/CLAUDE.md", "personal");
        fixture.write(
            fixture.home(),
            ".agents/skills/global/SKILL.md",
            &skill("global"),
        );

        let codex_only = fixture.items(&[CODEX]);
        let personal = by_path(&codex_only, &codex_personal);
        assert_eq!(personal.providers, vec![CODEX]);
        assert_eq!(
            personal.location,
            ContextLocation {
                kind: ContextLocationKind::Home,
                path: ".codex".to_string()
            }
        );
        assert!(codex_only.iter().any(|item| item.name == "global"));
        assert!(
            codex_only
                .iter()
                .all(|item| item.path != path_string(&claude_personal))
        );

        let both = fixture.items(&[CODEX, CLAUDE]);
        assert_eq!(by_path(&both, &claude_personal).providers, vec![CLAUDE]);

        let none = fixture.items(&[]);
        assert_eq!(none.len(), 1);
    }

    #[test]
    fn a_file_shadowed_for_every_enabled_agent_has_no_providers_and_names_what_shadows_it() {
        let fixture = Fixture::new();
        let override_file = fixture.write(fixture.project.path(), "AGENTS.override.md", "override");
        let agents = fixture.write(fixture.project.path(), "AGENTS.md", "agents");

        let items = fixture.items(&[CODEX]);

        assert_eq!(by_path(&items, &override_file).providers, vec![CODEX]);
        let shadowed = by_path(&items, &agents);
        assert!(shadowed.providers.is_empty());
        let by = path_string(&override_file);
        assert_eq!(
            shadowed.unapplied,
            Some(UnappliedReason::Superseded {
                by: vec![by.clone()]
            })
        );
        assert_eq!(
            shadowed.sources[0].readers,
            vec![ContextItemReader {
                agent: CODEX,
                superseded_by: Some(by)
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_found_by_several_agents_is_one_item_with_a_source_per_path() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let agents = fixture.write(fixture.project.path(), "AGENTS.md", "shared");
        symlink(
            fixture.project.path().join("AGENTS.md"),
            fixture.project.path().join("CLAUDE.md"),
        )
        .unwrap();

        let items = fixture.items(&[CODEX, CLAUDE]);

        assert_eq!(items.len(), 1);
        let item = by_path(&items, &agents);
        assert_eq!(item.name, "AGENTS.md");
        assert_eq!(item.providers, vec![CODEX, CLAUDE]);
        assert_eq!(item.unapplied, None);
        let sources = item
            .sources
            .iter()
            .map(|source| {
                (
                    Path::new(&source.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    source.target.clone(),
                    source
                        .readers
                        .iter()
                        .map(|reader| reader.agent)
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            sources,
            vec![
                ("AGENTS.md".to_string(), None, vec![CODEX]),
                (
                    "CLAUDE.md".to_string(),
                    Some(path_string(&agents)),
                    vec![CLAUDE]
                ),
            ]
        );
    }

    #[test]
    fn a_project_skill_shadowed_by_a_personal_one_lists_only_enabled_readers() {
        let fixture = Fixture::new();
        fixture.write(
            fixture.project.path(),
            ".claude/skills/review/SKILL.md",
            &skill("review"),
        );
        fixture.write(
            fixture.home(),
            ".claude/skills/review/SKILL.md",
            &skill("review"),
        );

        let without_claude = fixture.items(&[CODEX]);
        assert_eq!(without_claude.len(), 1);
        assert_eq!(
            without_claude[0].unapplied,
            Some(UnappliedReason::NotFound {
                readers: vec![CLAUDE]
            })
        );
        assert_eq!(
            without_claude[0].location,
            ContextLocation {
                kind: ContextLocationKind::Target,
                path: path_string(Path::new(".claude/skills")),
            }
        );

        let with_claude = fixture.items(&[CLAUDE]);
        assert_eq!(with_claude.len(), 2);
        let personal_path = fixture.home().join(".claude/skills/review");
        let project = with_claude
            .iter()
            .find(|item| item.location.kind == ContextLocationKind::Target)
            .unwrap();
        assert_eq!(
            project.unapplied,
            Some(UnappliedReason::Superseded {
                by: vec![path_string(&personal_path)]
            })
        );
        let personal = with_claude
            .iter()
            .find(|item| item.location.kind == ContextLocationKind::Home)
            .unwrap();
        assert_eq!(personal.providers, vec![CLAUDE]);
        assert_eq!(personal.description.as_deref(), Some("review skill"));
        assert!(personal.skill.is_some());
    }

    #[test]
    fn svode_recognized_files_are_not_items_but_stay_in_discovery() {
        let fixture = Fixture::new();
        for name in ["GEMINI.md", "SOUL.md", "USER.md", "MEMORY.md"] {
            fixture.write(fixture.project.path(), name, "recognized");
        }

        assert!(fixture.items(&AgentAdapterKind::ALL).is_empty());
        let discovery = crate::agent_context::scanner::discover(
            fixture.project.path(),
            fixture.project.path(),
            &fixture.environment,
            &AgentAdapterKind::ALL,
        )
        .unwrap();
        assert_eq!(discovery.instructions.len(), 4);
    }

    #[test]
    fn an_inline_target_shows_inherited_project_sources_above_its_root() {
        let fixture = Fixture::new();
        let root = fixture.write(fixture.project.path(), "AGENTS.md", "root");
        let inline = fixture.project.path().join("docs");
        let own = fixture.write(&inline, "AGENTS.md", "inline");

        let items = scan(
            fixture.project.path(),
            &inline,
            &fixture.environment,
            &[CODEX],
        )
        .unwrap()
        .items;

        assert_eq!(by_path(&items, &own).location.path, "");
        assert_eq!(by_path(&items, &root).location.path, "..");
    }
}
