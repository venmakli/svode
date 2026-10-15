//! Instructions of agents whose source policy declares them as rules and
//! slots (Stage 10 `05`): every agent's declaration is read the same way.

use std::path::{Path, PathBuf};

use crate::agent_adapters::{
    AgentAdapterKind, DeclaredInstructions, InstructionDirectories, InstructionNamesSetting,
    InstructionSelection, InstructionSlotFile, SourceRegistryEnvironment,
};

use super::super::model::{
    InstructionDiscovery, InstructionDiscoveryPolicy, InstructionOwner, InstructionOwnerKind,
    InstructionRow, InstructionSourceKind, SourceHealth, SourceResolution, SourceSupport,
};
use super::io::{inspect, path_string};
use super::{DiscoveryResult, TargetPlaces};

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
/// configuration and the directories of walks above the boundary.
pub(super) fn discover(
    agent: AgentAdapterKind,
    declared: &DeclaredInstructions,
    places: &TargetPlaces,
    environment: &SourceRegistryEnvironment,
    global: bool,
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let mut configured_names = None;
    for rule in &declared.rules {
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
                .map(|directory| {
                    if directory.inside {
                        project_place(&directory.path, places)
                    } else {
                        let root = places.outside_root(&directory.path);
                        personal_place(directory.path, root)
                    }
                })
                .collect::<Vec<_>>(),
            InstructionDirectories::Personal(directory) => {
                vec![personal_place(
                    PathBuf::from(directory),
                    PathBuf::from(directory),
                )]
            }
        };
        for (directory_depth, place) in directories.into_iter().enumerate() {
            if place.source_kind == InstructionSourceKind::Personal && !global {
                continue;
            }
            let candidates = names.iter().map(|name| place.candidate(name)).collect();
            read_group(
                agent,
                Group {
                    candidates,
                    selection: rule.selection,
                    skip_empty: rule.skip_empty,
                    policy: InstructionDiscoveryPolicy::DirectoryChain,
                    directory_depth,
                },
                &mut result,
            );
        }
    }
    for slot in &declared.slots {
        let candidates = slot
            .files
            .iter()
            .filter_map(|file| match file {
                InstructionSlotFile::Project { walk, path } => {
                    let directory = places.walk(*walk).into_iter().next()?;
                    let place = if directory.inside {
                        project_place(&directory.path, places)
                    } else {
                        let root = places.outside_root(&directory.path);
                        personal_place(directory.path, root)
                    };
                    Some(place.candidate(path))
                }
                InstructionSlotFile::Personal(path) => {
                    let path = PathBuf::from(path);
                    let directory = path.parent().unwrap_or(&path).to_path_buf();
                    Some(Candidate {
                        allowed_root: directory.clone(),
                        owner: InstructionOwner {
                            kind: InstructionOwnerKind::ClientConfiguration,
                            root: path_string(&directory),
                        },
                        source_kind: InstructionSourceKind::Personal,
                        path,
                    })
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

fn project_place(directory: &Path, places: &TargetPlaces) -> Place {
    Place {
        directory: directory.to_path_buf(),
        allowed_root: places.repository_root.clone(),
        source_kind: InstructionSourceKind::Project,
        owner: InstructionOwner {
            kind: InstructionOwnerKind::TargetSpace,
            root: path_string(directory),
        },
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
        InstructionSelection::First => inspected
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
            InstructionSelection::First if selected == Some(precedence) => {
                (SourceResolution::Selected, None)
            }
            InstructionSelection::First => (SourceResolution::Superseded, selected_path.clone()),
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
