//! Instructions of agents whose source policy declares them as rules and
//! slots (Stage 10 `05`): every agent's declaration is read the same way.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::agent_adapters::{
    AgentAdapterKind, DeclaredInstructions, InstructionDirectories, InstructionNamesSetting,
    InstructionSelection, InstructionSlotFile, SourceRegistryEnvironment, SourceSwitch,
};
use crate::content_tree::policy::{TreeIgnorePolicy, TreePathKind};

use super::super::model::{
    InstructionDiscovery, InstructionDiscoveryPolicy, InstructionOwner, InstructionOwnerKind,
    InstructionRow, InstructionSourceKind, SourceHealth, SourceResolution, SourceSupport,
};
use super::io::{inspect, path_string};
use super::{DiscoveryResult, TargetPlaces, WalkDirectory};

const PREVIEW_BYTES: usize = 64 * 1024;

/// A file the agent may read, with the boundary its link must stay within.
struct Candidate {
    path: PathBuf,
    allowed_root: PathBuf,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
}

/// One group of candidates: the files of a rule in one directory, or the
/// files of a slot.
struct Group {
    candidates: Vec<Candidate>,
    selection: InstructionSelection,
    skip_empty: bool,
    policy: InstructionDiscoveryPolicy,
    directory_depth: usize,
}

/// `global` reads the files outside the repository boundary: the agent's
/// configuration and the directories of walks above the boundary. A rule
/// whose switch is in `switched_off` is not read.
pub(super) fn discover(
    agent: AgentAdapterKind,
    declared: &DeclaredInstructions,
    places: &TargetPlaces,
    environment: &SourceRegistryEnvironment,
    global: bool,
    switched_off: &BTreeSet<SourceSwitch>,
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let mut configured_names = None;
    let gitignore = places
        .repository_root
        .join(".git")
        .symlink_metadata()
        .is_ok()
        .then(|| TreeIgnorePolicy::system_only(&places.repository_root));
    // The rows of each group of alternative rules, rule by rule.
    let mut alternatives = BTreeMap::<usize, Vec<Vec<InstructionRow>>>::new();
    for rule in &declared.rules {
        if rule
            .switch
            .is_some_and(|switch| switched_off.contains(&switch))
        {
            continue;
        }
        let mut rule_result = DiscoveryResult::default();
        let names = match rule.names_setting {
            Some(InstructionNamesSetting::QwenContextFileName) => configured_names
                .get_or_insert_with(|| {
                    super::qwen::context_file_names(environment, places, global, &mut result)
                })
                .clone()
                .unwrap_or_else(|| rule.names.clone()),
            None => rule.names.clone(),
        };
        let directories = match &rule.directories {
            InstructionDirectories::Walk(walk) => places
                .walk(*walk)
                .into_iter()
                .map(|directory| walk_place(directory, places))
                .collect::<Vec<_>>(),
            InstructionDirectories::Personal(directory) => {
                vec![personal_place(
                    PathBuf::from(directory),
                    PathBuf::from(directory),
                )]
            }
        };
        let mut walk_candidates = Vec::new();
        for (directory_depth, place) in directories.into_iter().enumerate() {
            if place.source_kind == InstructionSourceKind::Personal && !global {
                continue;
            }
            let candidates = names
                .iter()
                .map(|name| place.candidate(name))
                .filter(|candidate| {
                    !rule.skip_gitignored
                        || candidate.source_kind != InstructionSourceKind::Project
                        || !gitignore.as_ref().is_some_and(|gitignore| {
                            gitignore.is_git_ignored_abs(&candidate.path, TreePathKind::File)
                        })
                })
                .collect::<Vec<_>>();
            if rule.selection == InstructionSelection::FirstInWalk {
                walk_candidates.extend(candidates);
                continue;
            }
            read_group(
                agent,
                Group {
                    candidates,
                    selection: rule.selection,
                    skip_empty: rule.skip_empty,
                    policy: InstructionDiscoveryPolicy::DirectoryChain,
                    directory_depth,
                },
                &mut rule_result,
            );
        }
        if rule.selection == InstructionSelection::FirstInWalk {
            read_group(
                agent,
                Group {
                    candidates: walk_candidates,
                    selection: InstructionSelection::FirstInWalk,
                    skip_empty: rule.skip_empty,
                    policy: InstructionDiscoveryPolicy::DirectoryChain,
                    directory_depth: 0,
                },
                &mut rule_result,
            );
        }
        match rule.alternatives {
            Some(group) => {
                let rows = std::mem::take(&mut rule_result.rows);
                alternatives.entry(group).or_default().push(rows);
                result.append(rule_result);
            }
            None => result.append(rule_result),
        }
    }
    for rules in alternatives.into_values() {
        result.rows.extend(resolve_alternatives(rules));
    }
    for slot in &declared.slots {
        let candidates = slot
            .files
            .iter()
            .filter_map(|file| match file {
                InstructionSlotFile::Project { walk, path } => {
                    let directory = places.walk(*walk).into_iter().next()?;
                    Some(walk_place(directory, places).candidate(path))
                }
                InstructionSlotFile::Personal(path) => {
                    let path = Path::new(path);
                    let directory = path.parent()?.to_path_buf();
                    let name = path.file_name()?.to_str()?;
                    Some(personal_place(directory.clone(), directory).candidate(name))
                }
            })
            .filter(|candidate| candidate.source_kind == InstructionSourceKind::Project || global)
            .collect();
        read_group(
            agent,
            Group {
                candidates,
                selection: InstructionSelection::First,
                skip_empty: false,
                policy: InstructionDiscoveryPolicy::FileSlot,
                directory_depth: 0,
            },
            &mut result,
        );
    }
    result
}

struct Place {
    directory: PathBuf,
    allowed_root: PathBuf,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
}

impl Place {
    fn candidate(&self, relative: &str) -> Candidate {
        Candidate {
            path: self.directory.join(relative),
            allowed_root: self.allowed_root.clone(),
            source_kind: self.source_kind,
            owner: self.owner.clone(),
        }
    }
}

/// A directory inside the repository boundary is the project's; one above
/// it belongs to the device.
fn walk_place(directory: WalkDirectory, places: &TargetPlaces) -> Place {
    if !directory.inside {
        let root = places.outside_root(&directory.path);
        return personal_place(directory.path, root);
    }
    Place {
        owner: InstructionOwner {
            kind: InstructionOwnerKind::TargetSpace,
            root: path_string(&directory.path),
        },
        directory: directory.path,
        allowed_root: places.repository_root.clone(),
        source_kind: InstructionSourceKind::Project,
    }
}

fn personal_place(directory: PathBuf, allowed_root: PathBuf) -> Place {
    Place {
        owner: InstructionOwner {
            kind: InstructionOwnerKind::ClientConfiguration,
            root: path_string(&allowed_root),
        },
        directory,
        allowed_root,
        source_kind: InstructionSourceKind::Personal,
    }
}

fn read_group(agent: AgentAdapterKind, group: Group, result: &mut DiscoveryResult) {
    for candidate in &group.candidates {
        let observed = path_string(&candidate.path);
        match candidate.source_kind {
            InstructionSourceKind::Personal => result.observed_personal_paths.push(observed),
            _ => result.observed_project_paths.push(observed),
        }
    }
    let mut seen = Vec::<PathBuf>::new();
    let mut inspected = Vec::new();
    for candidate in group.candidates {
        let Some(source) = inspect(
            &candidate.path,
            &candidate.allowed_root,
            PREVIEW_BYTES,
            Some(agent),
        ) else {
            continue;
        };
        // On a case-insensitive file system `AGENTS.md` and `agents.md` are
        // one file: the agent reads it once.
        if let Some(canonical) = &source.canonical_path {
            if seen.contains(canonical) {
                continue;
            }
            seen.push(canonical.clone());
        }
        if group.skip_empty
            && source
                .preview
                .as_ref()
                .is_some_and(|preview| preview.markdown.trim().is_empty() && !preview.truncated)
        {
            continue;
        }
        inspected.push((candidate, source));
    }
    let selected = match group.selection {
        InstructionSelection::All => None,
        InstructionSelection::First | InstructionSelection::FirstInWalk => inspected
            .iter()
            .position(|(_, source)| source.preview.is_some()),
    };
    let selected_path = selected.map(|index| path_string(&inspected[index].0.path));

    for (precedence, (candidate, mut source)) in inspected.into_iter().enumerate() {
        let mut health_reasons = Vec::new();
        if let Some(diagnostic) = source.diagnostic.take() {
            health_reasons.push(diagnostic.message.clone());
            result.diagnostics.push(diagnostic);
        }
        if source.preview.is_none() {
            continue;
        }
        let (resolution, superseded_by) = match group.selection {
            InstructionSelection::All => (SourceResolution::Included, None),
            _ if selected == Some(precedence) => (SourceResolution::Selected, None),
            _ => (SourceResolution::Superseded, selected_path.clone()),
        };
        let path = path_string(&candidate.path);
        result.rows.push(InstructionRow {
            id: format!("{}:{path}", agent.as_str()),
            adapter_id: Some(agent),
            name: candidate
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone()),
            path,
            canonical_path: source.canonical_path.as_deref().map(path_string),
            link_kind: source.link_kind,
            owner: candidate.owner,
            source_kind: candidate.source_kind,
            support: SourceSupport::ClientNative,
            resolution,
            health: if health_reasons.is_empty() {
                SourceHealth::Normal
            } else {
                SourceHealth::Degraded
            },
            health_reasons,
            discovery: InstructionDiscovery {
                policy: group.policy,
                directory_depth: group.directory_depth,
                precedence,
            },
            superseded_by,
            preview: source.preview,
            references: Vec::new(),
        });
    }
}

/// The agent loads the first of the alternative rules that yields a
/// non-empty file. Files of the other rules are shadowed by that rule's
/// first loaded file; an empty file it selected loads nothing and is no
/// row, though it still shadows the files after it.
fn resolve_alternatives(rules: Vec<Vec<InstructionRow>>) -> Vec<InstructionRow> {
    let applied = |row: &InstructionRow| row.resolution != SourceResolution::Superseded;
    let loaded = |row: &InstructionRow| {
        applied(row)
            && row
                .preview
                .as_ref()
                .is_some_and(|preview| !preview.markdown.trim().is_empty())
    };
    let winner = rules.iter().position(|rows| rows.iter().any(&loaded));
    let winner_path = winner.and_then(|index| {
        rules[index]
            .iter()
            .find(|row| loaded(row))
            .map(|row| row.path.clone())
    });
    let mut resolved = Vec::new();
    for (index, rows) in rules.into_iter().enumerate() {
        for mut row in rows {
            if applied(&row) && !loaded(&row) {
                continue;
            }
            if winner != Some(index) && applied(&row) {
                row.resolution = SourceResolution::Superseded;
                row.superseded_by = winner_path.clone();
            }
            resolved.push(row);
        }
    }
    resolved
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::super::discover;
    use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};
    use crate::agent_context::model::{
        AgentContextDiscovery, InstructionSourceKind, SourceResolution,
    };

    use AgentAdapterKind::{KimiCode, Opencode, Pi, QwenCode};

    /// A repository at `~/work/repo` with an inline target `docs`.
    struct Fixture {
        home: TempDir,
        environment: SourceRegistryEnvironment,
    }

    impl Fixture {
        fn new() -> Self {
            let home = TempDir::new().unwrap();
            let home_path = home.path().canonicalize().unwrap();
            fs::create_dir_all(home_path.join("work/repo/.git")).unwrap();
            fs::create_dir_all(home_path.join("work/repo/docs")).unwrap();
            Self {
                environment: SourceRegistryEnvironment::for_tests(home_path),
                home,
            }
        }

        fn home(&self) -> &std::path::Path {
            &self.environment.home_dir
        }

        fn repo(&self) -> std::path::PathBuf {
            self.home().join("work/repo")
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.home().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn discover(&self, target: &str, enabled: &[AgentAdapterKind]) -> AgentContextDiscovery {
            let _ = &self.home;
            discover(
                &self.repo(),
                &self.repo().join(target),
                &self.environment,
                enabled,
            )
            .unwrap()
        }

        /// The files `agent` reads, from `~`, with how it reads them.
        fn read_by(
            &self,
            discovery: &AgentContextDiscovery,
            agent: AgentAdapterKind,
        ) -> Vec<(String, SourceResolution)> {
            let mut read = discovery
                .instructions
                .iter()
                .filter(|row| row.adapter_id == Some(agent))
                .map(|row| {
                    (
                        std::path::Path::new(&row.path)
                            .strip_prefix(self.home())
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        row.resolution,
                    )
                })
                .collect::<Vec<_>>();
            read.sort_by(|left, right| left.0.cmp(&right.0));
            read
        }
    }

    use SourceResolution::{Included, Selected, Superseded};

    fn files(entries: &[(&str, SourceResolution)]) -> Vec<(String, SourceResolution)> {
        let mut files = entries
            .iter()
            .map(|(path, resolution)| ((*path).to_string(), *resolution))
            .collect::<Vec<_>>();
        files.sort_by(|left, right| left.0.cmp(&right.0));
        files
    }

    #[test]
    fn opencode_reads_agents_md_from_the_target_up_to_home_and_its_config() {
        let fixture = Fixture::new();
        fixture.write(".config/opencode/AGENTS.md", "global");
        fixture.write("AGENTS.md", "home");
        fixture.write("work/AGENTS.md", "above the repository");
        fixture.write("work/repo/AGENTS.md", "repository");
        fixture.write("work/repo/CLAUDE.md", "claude");
        fixture.write("work/repo/docs/AGENTS.md", "target");

        let disabled = fixture.discover("docs", &[]);
        assert_eq!(
            fixture.read_by(&disabled, Opencode),
            files(&[
                ("work/repo/AGENTS.md", Included),
                ("work/repo/docs/AGENTS.md", Included),
            ])
        );

        let enabled = fixture.discover("docs", &[Opencode]);
        assert_eq!(
            fixture.read_by(&enabled, Opencode),
            files(&[
                (".config/opencode/AGENTS.md", Included),
                ("AGENTS.md", Included),
                ("work/AGENTS.md", Included),
                ("work/repo/AGENTS.md", Included),
                ("work/repo/docs/AGENTS.md", Included),
            ])
        );
        let above = enabled
            .instructions
            .iter()
            .find(|row| row.path.ends_with("work/AGENTS.md"))
            .unwrap();
        assert_eq!(above.source_kind, InstructionSourceKind::Personal);
    }

    #[test]
    fn pi_reads_one_context_file_per_directory_from_the_filesystem_root() {
        let fixture = Fixture::new();
        fixture.write(".pi/agent/AGENTS.md", "agent dir");
        fixture.write(".pi/agent/CLAUDE.md", "agent dir claude");
        fixture.write("work/CLAUDE.md", "above the repository");
        fixture.write("work/repo/AGENTS.md", "repository");
        fixture.write("work/repo/CLAUDE.md", "repository claude");
        fixture.write("work/repo/docs/AGENTS.override.md", "override");
        fixture.write("work/repo/docs/AGENTS.md", "target");

        let disabled = fixture.discover("docs", &[]);
        assert_eq!(
            fixture.read_by(&disabled, Pi),
            files(&[
                ("work/repo/AGENTS.md", Selected),
                ("work/repo/CLAUDE.md", Superseded),
                ("work/repo/docs/AGENTS.override.md", Selected),
                ("work/repo/docs/AGENTS.md", Superseded),
            ])
        );

        let enabled = fixture.discover("docs", &[Pi]);
        assert_eq!(
            fixture.read_by(&enabled, Pi),
            files(&[
                (".pi/agent/AGENTS.md", Selected),
                (".pi/agent/CLAUDE.md", Superseded),
                ("work/CLAUDE.md", Selected),
                ("work/repo/AGENTS.md", Selected),
                ("work/repo/CLAUDE.md", Superseded),
                ("work/repo/docs/AGENTS.override.md", Selected),
                ("work/repo/docs/AGENTS.md", Superseded),
            ])
        );
        let shadowed = enabled
            .instructions
            .iter()
            .find(|row| row.adapter_id == Some(Pi) && row.path.ends_with("repo/CLAUDE.md"))
            .unwrap();
        assert!(
            shadowed
                .superseded_by
                .as_deref()
                .is_some_and(|by| by.ends_with("repo/AGENTS.md"))
        );
    }

    #[test]
    fn pi_takes_system_prompt_files_of_the_target_before_its_agent_dir() {
        let fixture = Fixture::new();
        fixture.write(".pi/agent/SYSTEM.md", "personal system");
        fixture.write(".pi/agent/APPEND_SYSTEM.md", "personal append");
        fixture.write("work/repo/docs/.pi/SYSTEM.md", "project system");

        let enabled = fixture.discover("docs", &[Pi]);
        assert_eq!(
            fixture.read_by(&enabled, Pi),
            files(&[
                ("work/repo/docs/.pi/SYSTEM.md", Selected),
                (".pi/agent/SYSTEM.md", Superseded),
                (".pi/agent/APPEND_SYSTEM.md", Selected),
            ])
        );
        assert_eq!(
            fixture.read_by(&fixture.discover("docs", &[]), Pi),
            files(&[("work/repo/docs/.pi/SYSTEM.md", Selected)])
        );
    }

    #[test]
    fn qwen_code_reads_its_names_from_above_the_git_root_with_local_and_language_files() {
        let fixture = Fixture::new();
        fixture.write(".qwen/QWEN.md", "personal");
        fixture.write(".qwen/output-language.md", "personal language");
        fixture.write("work/QWEN.md", "above the repository");
        fixture.write("work/repo/QWEN.md", "repository");
        fixture.write("work/repo/AGENTS.md", "repository agents");
        fixture.write("work/repo/.qwen/QWEN.local.md", "local");
        fixture.write("work/repo/docs/QWEN.md", "target");
        fixture.write("work/repo/docs/.qwen/output-language.md", "language");

        let enabled = fixture.discover("docs", &[QwenCode]);
        assert_eq!(
            fixture.read_by(&enabled, QwenCode),
            files(&[
                (".qwen/QWEN.md", Included),
                ("work/QWEN.md", Included),
                ("work/repo/QWEN.md", Included),
                ("work/repo/AGENTS.md", Included),
                ("work/repo/docs/QWEN.md", Included),
                ("work/repo/.qwen/QWEN.local.md", Included),
                ("work/repo/docs/.qwen/output-language.md", Selected),
                (".qwen/output-language.md", Superseded),
            ])
        );
        // The parent of the git root lies outside the repository boundary.
        assert_eq!(
            fixture.read_by(&fixture.discover("docs", &[]), QwenCode),
            files(&[
                ("work/repo/QWEN.md", Included),
                ("work/repo/AGENTS.md", Included),
                ("work/repo/docs/QWEN.md", Included),
                ("work/repo/.qwen/QWEN.local.md", Included),
                ("work/repo/docs/.qwen/output-language.md", Selected),
            ])
        );
    }

    #[test]
    fn qwen_code_context_file_name_replaces_its_names_and_keeps_nothing_else() {
        let fixture = Fixture::new();
        fixture.write(
            ".qwen/settings.json",
            "{\n  // user settings\n  \"env\": { \"QWEN_KEY\": \"secret-value-of-the-user\" },\n  \"context\": { \"fileName\": \"QWEN.md\" }\n}",
        );
        fixture.write(
            "work/repo/.qwen/settings.json",
            "{ \"context\": { \"fileName\": [\"CLAUDE.md\", \"../escape.md\"] }, \"apiKey\": \"secret-value-of-the-workspace\", }",
        );
        fixture.write("work/repo/QWEN.md", "qwen");
        fixture.write("work/repo/AGENTS.md", "agents");
        fixture.write("work/repo/CLAUDE.md", "claude");

        let workspace = fixture.discover("", &[QwenCode]);
        assert_eq!(
            fixture.read_by(&workspace, QwenCode),
            files(&[("work/repo/CLAUDE.md", Included)])
        );
        assert!(
            workspace
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "qwen_context_file_name_ignored")
        );
        assert!(!format!("{workspace:?}").contains("secret-value"));

        fs::remove_file(fixture.repo().join(".qwen/settings.json")).unwrap();
        let user = fixture.discover("", &[QwenCode]);
        assert_eq!(
            fixture.read_by(&user, QwenCode),
            files(&[("work/repo/QWEN.md", Included)])
        );
        let disabled = fixture.discover("", &[]);
        assert_eq!(
            fixture.read_by(&disabled, QwenCode),
            files(&[
                ("work/repo/QWEN.md", Included),
                ("work/repo/AGENTS.md", Included),
            ])
        );

        fixture.write(
            ".qwen/settings.json",
            "{ \"env\": { \"KEY\": \"secret-value\" ",
        );
        let broken = fixture.discover("", &[QwenCode]);
        let parse = broken
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "qwen_settings_parse")
            .unwrap();
        assert!(!parse.message.contains("secret-value"));
        assert!(!format!("{broken:?}").contains("secret-value"));
    }

    #[test]
    fn kimi_code_reads_both_files_of_a_directory_and_skips_empty_ones() {
        let fixture = Fixture::new();
        fixture.write(".kimi-code/AGENTS.md", "brand");
        fixture.write(".kimi-code/SYSTEM.md", "system");
        fixture.write(".agents/AGENTS.md", "generic");
        fixture.write("work/AGENTS.md", "above the repository");
        fixture.write("work/repo/.kimi-code/AGENTS.md", "kimi repository");
        fixture.write("work/repo/AGENTS.md", "repository");
        fixture.write("work/repo/docs/AGENTS.md", "  \n");

        let enabled = fixture.discover("docs", &[KimiCode]);
        assert_eq!(
            fixture.read_by(&enabled, KimiCode),
            files(&[
                (".kimi-code/AGENTS.md", Included),
                (".agents/AGENTS.md", Selected),
                ("work/repo/.kimi-code/AGENTS.md", Included),
                ("work/repo/AGENTS.md", Selected),
                (".kimi-code/SYSTEM.md", Included),
            ])
        );
        // Codex reads the empty file that Kimi Code skips.
        assert!(enabled.instructions.iter().any(|row| {
            row.adapter_id == Some(AgentAdapterKind::Codex) && row.path.ends_with("docs/AGENTS.md")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn one_file_under_two_names_is_read_once() {
        let fixture = Fixture::new();
        fixture.write("work/repo/AGENTS.md", "repository");
        // A case-insensitive file system already finds it as `agents.md`.
        if !fixture.repo().join("agents.md").exists() {
            std::os::unix::fs::symlink(
                fixture.repo().join("AGENTS.md"),
                fixture.repo().join("agents.md"),
            )
            .unwrap();
        }

        let discovery = fixture.discover("", &[]);
        assert_eq!(
            fixture.read_by(&discovery, KimiCode),
            files(&[("work/repo/AGENTS.md", Selected)])
        );
    }
}
