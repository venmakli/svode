//! MCP servers of the agents (Stage 10 `05`, «MCP-сервер»): the configs each
//! policy declares, one row per declaration in one file, and whether each
//! agent that reads the file takes the server — by its precedence of one
//! name and the switches of its configs. Servers are never started.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_adapters::{
    AgentAdapterKind, AgentSourcePolicy, McpConfigFormat, McpEnablement, McpPrecedence,
    McpProjectKey, McpSourceRule, SkillPlace, SourceRegistryEnvironment,
};

use super::super::model::{McpFinding, McpServerRow, SourceHealth, SourceLinkKind};
use super::io::{diagnostic, path_string};
use super::mcp_config::{self, McpConfig, McpDeclaration, McpSyntax};
use super::{DiscoveryResult, TargetPlaces, claude, cursor, grok, pi, qwen};

/// A config file a rule names, with the root it may resolve within.
struct Candidate {
    path: PathBuf,
    inside: bool,
    root: PathBuf,
}

/// One server an agent reads, in the agent's order.
struct Occurrence {
    name: String,
    row: String,
    /// The declared switch, when the agent honours it.
    switch: Option<bool>,
    complete: bool,
}

pub(super) fn discover(
    places: &TargetPlaces,
    adapters: &[AgentSourcePolicy],
    global_agents: &[AgentAdapterKind],
    environment: &SourceRegistryEnvironment,
    grok: &grok::Config,
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let svode_home = environment.svode_home.canonicalize().ok();
    let keys = ProjectKeys {
        main_repository: claude::project_key(places),
        target: places.target_root.clone(),
    };
    let mut configs = BTreeMap::<(PathBuf, McpSyntax), Option<McpConfig>>::new();
    let mut rows = BTreeMap::<String, McpServerRow>::new();
    // Rows that declare neither a command nor a URL, until a merge of their
    // name supplies one.
    let mut incomplete = BTreeMap::<String, (PathBuf, String)>::new();

    for adapter in adapters {
        let agent = adapter.id;
        let global = global_agents.contains(&agent);
        let capability = &adapter.capabilities.mcp;
        let mut order = Vec::<Occurrence>::new();
        let mut claude_disabled = Vec::<String>::new();
        for rule in &capability.sources {
            if rule
                .switch
                .is_some_and(|switch| grok.switched_off.contains(&switch))
            {
                continue;
            }
            for candidate in candidates(rule, places, global, &mut result) {
                let Some((canonical, link_kind)) =
                    resolve(&candidate, svode_home.as_deref(), agent, &mut result)
                else {
                    continue;
                };
                let syntax = McpSyntax::of(rule.format);
                let config = configs
                    .entry((canonical.clone(), syntax))
                    .or_insert_with(|| {
                        mcp_config::read(
                            &canonical,
                            syntax,
                            &keys.all(),
                            agent,
                            &mut result.diagnostics,
                        )
                    });
                let Some(config) = config else {
                    continue;
                };
                let project = match rule.format {
                    McpConfigFormat::ClaudeLocal(key) => {
                        let Some(project) = config.project(keys.of(key)) else {
                            continue;
                        };
                        if let McpEnablement::ClaudeProjectDisabled(disabled_key) =
                            capability.enablement
                            && disabled_key == key
                        {
                            claude_disabled.clone_from(&project.disabled);
                        }
                        Some(project)
                    }
                    _ => None,
                };
                let declarations = project.map_or(&config.servers, |project| &project.servers);
                let ignored = rule.whole_file
                    && declarations
                        .iter()
                        .any(|declaration| declaration.problem.is_some());
                for declaration in declarations {
                    let id = row_id(&canonical, project.map(|project| &project.key), declaration);
                    let row = rows.entry(id.clone()).or_insert_with(|| {
                        if let Some(problem) = declaration
                            .problem
                            .as_ref()
                            .filter(|_| declaration.incomplete)
                        {
                            incomplete.insert(id.clone(), (canonical.clone(), problem.clone()));
                        }
                        new_row(id.clone(), &canonical, project.is_some(), declaration)
                    });
                    if ignored {
                        let reason = format!(
                            "{} reads no server of {} while one of them is invalid",
                            agent.display_name(),
                            canonical.display()
                        );
                        if !row.health_reasons.contains(&reason) {
                            row.health = SourceHealth::Degraded;
                            row.health_reasons.push(reason);
                        }
                        continue;
                    }
                    if row
                        .findings
                        .iter()
                        .any(|finding| finding.adapter_id == agent)
                    {
                        continue;
                    }
                    row.findings.push(McpFinding {
                        adapter_id: agent,
                        path: path_string(&candidate.path),
                        link_kind,
                        disabled: rule.entry_switch && declaration.declared_off(),
                        superseded_by: None,
                    });
                    order.push(Occurrence {
                        name: declaration.name.clone(),
                        row: id,
                        switch: declaration.switch.filter(|_| rule.entry_switch),
                        complete: !declaration.incomplete,
                    });
                }
            }
        }

        let turned_off = turned_off(
            capability.enablement,
            claude_disabled,
            places,
            environment,
            global,
            grok,
            &mut result,
        );
        let winners = winners(capability.precedence, &order);
        let merged = (capability.precedence == McpPrecedence::MergeByFields)
            .then(|| merged_switches(&order));
        for occurrence in &order {
            let winner = winners
                .get(&occurrence.name)
                .filter(|winner| **winner != occurrence.row)
                .and_then(|winner| rows.get(*winner))
                .map(|winner| winner.path.clone());
            let Some(finding) = rows.get_mut(&occurrence.row).and_then(|row| {
                row.findings
                    .iter_mut()
                    .find(|finding| finding.adapter_id == agent)
            }) else {
                continue;
            };
            finding.superseded_by = winner;
            if let Some((switches, complete)) = &merged {
                finding.disabled = switches.get(occurrence.name.as_str()) == Some(&false);
                if complete.contains(occurrence.name.as_str()) {
                    incomplete.remove(&occurrence.row);
                }
            }
            if turned_off.turns_off(&occurrence.name) {
                finding.disabled = true;
            }
        }
    }

    for (id, (file, problem)) in incomplete {
        let Some(row) = rows.get_mut(&id) else {
            continue;
        };
        row.health = SourceHealth::Degraded;
        row.health_reasons.push(problem.clone());
        result.diagnostics.push(diagnostic(
            &file,
            row.findings.first().map(|finding| finding.adapter_id),
            "mcp_server_invalid",
            format!("{problem} in {}", file.display()),
        ));
    }
    result.mcp_servers = rows.into_values().collect();
    result.mcp_servers.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.id.cmp(&right.id))
    });
    result
}

/// The `projects` keys of the global config of Claude Code the clients take.
struct ProjectKeys {
    main_repository: PathBuf,
    target: PathBuf,
}

impl ProjectKeys {
    fn of(&self, key: McpProjectKey) -> &Path {
        match key {
            McpProjectKey::MainRepository => &self.main_repository,
            McpProjectKey::Target => &self.target,
        }
    }

    fn all(&self) -> Vec<PathBuf> {
        vec![self.main_repository.clone(), self.target.clone()]
    }
}

/// The config files a rule names. Places outside the repository boundary
/// are read only when `global`.
fn candidates(
    rule: &McpSourceRule,
    places: &TargetPlaces,
    global: bool,
    result: &mut DiscoveryResult,
) -> Vec<Candidate> {
    let found = match &rule.place {
        SkillPlace::Walk { walk, relative } => places
            .walk(*walk)
            .into_iter()
            .filter(|directory| directory.inside || global)
            .map(|directory| Candidate {
                root: if directory.inside {
                    places.repository_root.clone()
                } else {
                    places.outside_root(&directory.path)
                },
                path: directory.path.join(relative),
                inside: directory.inside,
            })
            .collect::<Vec<_>>(),
        SkillPlace::Personal(path) if global => {
            let path = PathBuf::from(path);
            let parent = path.parent().unwrap_or(&path).to_path_buf();
            let parent = parent.canonicalize().unwrap_or(parent);
            vec![Candidate {
                root: places.outside_root(&parent),
                path,
                inside: false,
            }]
        }
        SkillPlace::Personal(_) => Vec::new(),
    };
    for candidate in &found {
        let observed = path_string(&candidate.path);
        if candidate.inside {
            result.observed_project_paths.push(observed);
        } else {
            result.observed_personal_paths.push(observed);
        }
    }
    found
}

/// The canonical file of a candidate within its root or the stable Svode
/// folder.
fn resolve(
    candidate: &Candidate,
    svode_home: Option<&Path>,
    agent: AgentAdapterKind,
    result: &mut DiscoveryResult,
) -> Option<(PathBuf, SourceLinkKind)> {
    let metadata = fs::symlink_metadata(&candidate.path).ok()?;
    let canonical = match candidate.path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) => {
            result.diagnostics.push(diagnostic(
                &candidate.path,
                Some(agent),
                "mcp_config_unresolved",
                format!(
                    "Could not resolve MCP config {} (broken link or cycle): {}",
                    candidate.path.display(),
                    error.kind()
                ),
            ));
            return None;
        }
    };
    if !canonical.is_file() {
        return None;
    }
    let root = candidate
        .root
        .canonicalize()
        .unwrap_or_else(|_| candidate.root.clone());
    if !canonical.starts_with(&root)
        && !svode_home.is_some_and(|svode| canonical.starts_with(svode))
    {
        result.diagnostics.push(diagnostic(
            &candidate.path,
            Some(agent),
            "mcp_config_outside_boundary",
            format!(
                "MCP config {} resolves outside the project and the agents' homes and was not read",
                candidate.path.display()
            ),
        ));
        return None;
    }
    let link_kind = if metadata.file_type().is_symlink() {
        SourceLinkKind::SymbolicLink
    } else if canonical != candidate.path {
        SourceLinkKind::DirectoryAlias
    } else {
        SourceLinkKind::Direct
    };
    Some((canonical, link_kind))
}

/// One declaration in one file: a `projects` entry of the global config of
/// Claude Code is a declaration of its own.
fn row_id(file: &Path, project: Option<&PathBuf>, declaration: &McpDeclaration) -> String {
    match project {
        Some(project) => format!(
            "mcp:{}#projects:{}#{}",
            path_string(file),
            path_string(project),
            declaration.name
        ),
        None => format!("mcp:{}#{}", path_string(file), declaration.name),
    }
}

fn new_row(
    id: String,
    file: &Path,
    project_only: bool,
    declaration: &McpDeclaration,
) -> McpServerRow {
    let mut facts = declaration.facts.clone();
    facts.project_only = project_only;
    McpServerRow {
        id,
        name: declaration.name.clone(),
        path: path_string(file),
        facts,
        // An incomplete declaration is degraded only when no merge
        // completes it.
        health: if declaration.problem.is_some() && !declaration.incomplete {
            SourceHealth::Degraded
        } else {
            SourceHealth::Normal
        },
        health_reasons: declaration
            .problem
            .iter()
            .filter(|_| !declaration.incomplete)
            .cloned()
            .collect(),
        findings: Vec::new(),
    }
}

/// The row each name of an agent takes, by its precedence.
fn winners(precedence: McpPrecedence, order: &[Occurrence]) -> BTreeMap<String, &str> {
    let mut winners = BTreeMap::new();
    for occurrence in order {
        match precedence {
            McpPrecedence::Coexist | McpPrecedence::MergeByFields => {}
            McpPrecedence::FirstWinsByName => {
                winners
                    .entry(occurrence.name.clone())
                    .or_insert(occurrence.row.as_str());
            }
            McpPrecedence::LastWinsByName => {
                winners.insert(occurrence.name.clone(), occurrence.row.as_str());
            }
        }
    }
    winners
}

/// For an agent that merges declarations by fields: the last declared
/// switch of each name, and the names some declaration gives a command or a
/// URL.
fn merged_switches(order: &[Occurrence]) -> (BTreeMap<&str, bool>, BTreeSet<&str>) {
    let mut switches = BTreeMap::new();
    let mut complete = BTreeSet::new();
    for occurrence in order {
        if let Some(switch) = occurrence.switch {
            switches.insert(occurrence.name.as_str(), switch);
        }
        if occurrence.complete {
            complete.insert(occurrence.name.as_str());
        }
    }
    (switches, complete)
}

/// The servers an agent turns off beside their declarations.
enum TurnedOff {
    Names(BTreeSet<String>),
    Qwen(qwen::McpFilters),
    All,
}

impl TurnedOff {
    fn turns_off(&self, name: &str) -> bool {
        match self {
            Self::Names(names) => names.contains(name),
            Self::Qwen(filters) => filters.turns_off(name),
            Self::All => true,
        }
    }
}

fn turned_off(
    enablement: McpEnablement,
    claude_disabled: Vec<String>,
    places: &TargetPlaces,
    environment: &SourceRegistryEnvironment,
    global: bool,
    grok: &grok::Config,
    result: &mut DiscoveryResult,
) -> TurnedOff {
    let names = |names: Vec<String>| TurnedOff::Names(names.into_iter().collect());
    match enablement {
        McpEnablement::Declarations => names(Vec::new()),
        McpEnablement::ClaudeProjectDisabled(_) => names(claude_disabled),
        McpEnablement::CursorDisabledFile if global => names(cursor::disabled_mcp_servers(
            &environment.home_dir,
            &places.repository_root,
            result,
        )),
        McpEnablement::CursorDisabledFile => names(Vec::new()),
        McpEnablement::GrokDisabledList => names(grok.mcp_disabled.clone()),
        McpEnablement::QwenFilters => {
            TurnedOff::Qwen(qwen::mcp_filters(environment, places, global, result))
        }
        McpEnablement::PiBuiltin => {
            if pi::builtin_mcp_off(environment, places, global, result) {
                TurnedOff::All
            } else {
                names(Vec::new())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};
    use crate::agent_context::model::{
        ContextItem, ContextItemKind, ContextLocationKind, SourceHealth, UnappliedReason,
    };
    use crate::agent_context::scanner::scan;

    use AgentAdapterKind::{
        ClaudeCode, Codex, Cursor, GrokBuild, Hermes, KimiCode, Opencode, Pi, QwenCode,
    };

    struct Fixture {
        project: TempDir,
        _home: TempDir,
        environment: SourceRegistryEnvironment,
    }

    impl Fixture {
        fn new() -> Self {
            let project = TempDir::new().unwrap();
            std::fs::create_dir(project.path().join(".git")).unwrap();
            let home = TempDir::new().unwrap();
            let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
            Self {
                project,
                _home: home,
                environment,
            }
        }

        fn home(&self) -> PathBuf {
            self.environment.home_dir.clone()
        }

        fn root(&self) -> PathBuf {
            self.project.path().canonicalize().unwrap()
        }

        fn write(&self, path: &Path, text: &str) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn scan(
            &self,
            enabled: &[AgentAdapterKind],
        ) -> crate::agent_context::model::AgentContextSnapshotContent {
            scan(
                self.project.path(),
                self.project.path(),
                &self.environment,
                enabled,
            )
            .unwrap()
        }

        fn servers(&self, enabled: &[AgentAdapterKind]) -> Vec<ContextItem> {
            self.scan(enabled)
                .items
                .into_iter()
                .filter(|item| item.kind == ContextItemKind::McpServer)
                .collect()
        }
    }

    fn named<'a>(items: &'a [ContextItem], name: &str, file: &str) -> &'a ContextItem {
        items
            .iter()
            .find(|item| item.name == name && item.path.ends_with(file))
            .unwrap_or_else(|| panic!("no server {name} in {file}: {items:#?}"))
    }

    fn reader_superseded(item: &ContextItem, agent: AgentAdapterKind) -> Option<String> {
        item.sources
            .iter()
            .flat_map(|source| &source.readers)
            .find(|reader| reader.agent == agent)
            .and_then(|reader| reader.superseded_by.clone())
    }

    const CLAUDE_GLOBAL: &str = r#"{
  "oauthAccount": {"emailAddress": "neighbour-secret@example.com"},
  "mcpServers": {
    "github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "env-secret"}},
    "docs": {"type": "http", "url": "https://user:pw@docs.example.com/mcp?token=query-secret", "headers": {"Authorization": "Bearer header-secret"}, "headersHelper": "helper-secret"}
  },
  "projects": {
    "PROJECT": {
      "mcpServers": {"github": {"command": "gh-mcp", "args": ["--token", "arg-secret"]}},
      "disabledMcpServers": ["docs"]
    },
    "/elsewhere": {"mcpServers": {"other": {"command": "other-mcp"}}}
  }
}"#;

    #[test]
    fn the_claude_global_config_is_one_row_per_declaration_for_claude_and_grok() {
        let fixture = Fixture::new();
        let root = fixture.root();
        fixture.write(
            &fixture.home().join(".claude.json"),
            &CLAUDE_GLOBAL.replace("PROJECT", &root.to_string_lossy()),
        );
        fixture.write(
            &fixture.home().join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_API_KEY":"settings-secret"},"mcpServers":{"ignored":{"command":"ignored-mcp"}}}"#,
        );

        let snapshot = fixture.scan(&[ClaudeCode, GrokBuild]);
        let servers = snapshot
            .items
            .iter()
            .filter(|item| item.kind == ContextItemKind::McpServer)
            .cloned()
            .collect::<Vec<_>>();

        let names = servers
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>();
        // `settings.json` declares no servers; another project's entry is not
        // this target's.
        assert_eq!(names, vec!["docs", "github", "github"]);
        let user = servers
            .iter()
            .find(|item| item.name == "github" && !item.mcp.as_ref().unwrap().project_only)
            .unwrap();
        let local = servers
            .iter()
            .find(|item| item.name == "github" && item.mcp.as_ref().unwrap().project_only)
            .unwrap();
        assert_eq!(user.location.kind, ContextLocationKind::Home);
        assert_eq!(user.location.path, ".claude.json");
        assert_eq!(
            user.mcp.as_ref().unwrap().command,
            vec!["npx", "-y", "@modelcontextprotocol/server-github"]
        );
        // Both agents shadow the user server by the project's.
        assert!(user.providers.is_empty());
        assert_eq!(
            reader_superseded(user, ClaudeCode).as_deref(),
            Some(user.path.as_str())
        );
        assert_eq!(local.providers, vec![ClaudeCode, GrokBuild]);
        assert_eq!(
            local.mcp.as_ref().unwrap().command,
            vec!["gh-mcp", "--token", "••••"]
        );
        let docs = named(&servers, "docs", ".claude.json");
        assert_eq!(
            docs.mcp.as_ref().unwrap().url.as_deref(),
            Some("https://docs.example.com/mcp")
        );
        // `disabledMcpServers` turns it off for Claude Code only.
        assert_eq!(docs.providers, vec![GrokBuild]);
        assert!(
            docs.sources[0]
                .readers
                .iter()
                .any(|reader| reader.agent == ClaudeCode && reader.disabled)
        );

        let transport = serde_json::to_string(&snapshot).unwrap();
        for secret in [
            "env-secret",
            "GITHUB_TOKEN",
            "header-secret",
            "helper-secret",
            "query-secret",
            "user:pw",
            "arg-secret",
            "neighbour-secret",
            "settings-secret",
            "ANTHROPIC_API_KEY",
        ] {
            assert!(!transport.contains(secret), "{secret} leaked");
        }
        assert!(transport.contains(r#""kind":"mcp_server""#));
        assert!(transport.contains(r#""projectOnly":true"#));

        // Without the agents that read it, the personal config is not read.
        assert!(fixture.servers(&[Codex]).is_empty());
        // Grok's compatibility cell keeps it out for Grok.
        fixture.write(
            &fixture.home().join(".grok/config.toml"),
            "[compat.claude]\nmcps = false\n",
        );
        assert!(fixture.servers(&[GrokBuild]).is_empty());
    }

    #[test]
    fn a_project_mcp_json_names_its_readers_without_enabled_agents() {
        let fixture = Fixture::new();
        fixture.write(
            &fixture.project.path().join(".mcp.json"),
            r#"{"mcpServers":{"db":{"command":"db-mcp","env":{"PASSWORD":"x"}}}}"#,
        );

        let servers = fixture.servers(&[]);

        let db = named(&servers, "db", ".mcp.json");
        assert_eq!(db.location.kind, ContextLocationKind::Target);
        assert_eq!(db.location.path, ".mcp.json");
        assert_eq!(db.unapplied, Some(UnappliedReason::NotFound));
        assert_eq!(
            db.idle_readers,
            vec![ClaudeCode, QwenCode, KimiCode, GrokBuild]
        );
        assert!(db.modified_at.is_some());
        assert_eq!(db.owner_root, fixture.root().to_string_lossy());

        let servers = fixture.servers(&[ClaudeCode, QwenCode, KimiCode, GrokBuild]);
        assert_eq!(
            named(&servers, "db", ".mcp.json").providers,
            vec![ClaudeCode, QwenCode, KimiCode, GrokBuild]
        );
    }

    #[test]
    fn the_svode_integration_is_a_row_per_agent_config_managed_by_svode() {
        let fixture = Fixture::new();
        let home = fixture.home();
        let launcher = home.join(".svode/bin/svode-mcp");
        fixture.write(&launcher, "#!/bin/sh\n");
        let launcher = launcher.to_string_lossy().into_owned();
        let json = format!(
            r#"{{"mcpServers":{{"svode":{{"command":"{launcher}","env":{{"SVODE_MCP_MANAGED":"svode-connection-v1"}}}}}}}}"#
        );
        fixture.write(
            &home.join(".codex/config.toml"),
            &format!(
                "[mcp_servers.svode]\ncommand = \"{launcher}\"\nenv_vars = [\"SVODE_MCP_ROUTINE_CALLER_TOKEN\"]\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED = \"svode-connection-v1\"\n"
            ),
        );
        fixture.write(&home.join(".qwen/settings.json"), &json);
        fixture.write(&home.join(".kimi-code/mcp.json"), &json);
        fixture.write(&home.join(".pi/agent/mcp.json"), &json);
        fixture.write(
            &home.join(".config/opencode/opencode.json"),
            &format!(
                r#"{{"mcp":{{"servers":{{"svode":{{"type":"local","command":["{launcher}"]}}}}}}}}"#
            ),
        );

        let servers = fixture.servers(&[Codex, QwenCode, KimiCode, Pi, Opencode]);

        let rows = servers
            .iter()
            .map(|item| (item.location.path.clone(), item.providers.clone()))
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![
                (".codex/config.toml".to_string(), vec![Codex]),
                (".config/opencode/opencode.json".to_string(), vec![Opencode]),
                (".kimi-code/mcp.json".to_string(), vec![KimiCode]),
                (".pi/agent/mcp.json".to_string(), vec![Pi]),
                (".qwen/settings.json".to_string(), vec![QwenCode]),
            ]
        );
        assert!(servers.iter().all(|item| item.name == "svode"
            && item.managed_by_svode
            && item.mcp.as_ref().unwrap().command == vec![launcher.clone()]));
        let transport = serde_json::to_string(&servers).unwrap();
        assert!(!transport.contains("SVODE_MCP_MANAGED"));
        assert!(!transport.contains("SVODE_MCP_ROUTINE_CALLER_TOKEN"));
    }

    #[test]
    fn declared_switches_turn_servers_off_for_the_agents_that_honour_them() {
        let fixture = Fixture::new();
        let home = fixture.home();
        let project = fixture.project.path();
        fixture.write(
            &home.join(".codex/config.toml"),
            "[mcp_servers.off]\ncommand = \"off-mcp\"\nenabled = false\n",
        );
        fixture.write(
            &home.join(".hermes/config.yaml"),
            "api_key: yaml-secret\nmcp_servers:\n  notes:\n    command: notes-mcp\n    enabled: false\n",
        );
        fixture.write(
            &project.join("opencode.json"),
            r#"{"mcp":{"servers":{"web":{"type":"remote","url":"https://web.example.com","disabled":true}}}}"#,
        );
        fixture.write(
            &home.join(".qwen/settings.json"),
            "{ // user\n \"env\": { \"QWEN_CUSTOM_API_KEY\": \"qwen-secret\" }, \"mcp\": { \"excluded\": [\"lint*\"] }, \"mcpServers\": { \"lint-mcp\": { \"command\": \"lint\" }, \"keep\": { \"command\": \"keep\" } } }",
        );
        fixture.write(
            &home.join(".pi/agent/mcp.json"),
            r#"{"mcpServers":{"pi-server":{"command":"pi-mcp"}}}"#,
        );
        fixture.write(
            &home.join(".grok/config.toml"),
            "disabled_mcp_servers = [\"grokked\"]\n[mcp_servers.grokked]\ncommand = \"g\"\n",
        );

        let servers = fixture.servers(&[Codex, Hermes, Opencode, QwenCode, Pi, GrokBuild]);

        for (name, file) in [
            ("off", "config.toml"),
            ("notes", "config.yaml"),
            ("web", "opencode.json"),
            ("lint-mcp", "settings.json"),
            ("grokked", "config.toml"),
        ] {
            let server = named(&servers, name, file);
            assert!(server.providers.is_empty(), "{name}");
            assert_eq!(server.unapplied, Some(UnappliedReason::Disabled), "{name}");
        }
        assert_eq!(
            named(&servers, "keep", "settings.json").providers,
            vec![QwenCode]
        );
        assert_eq!(named(&servers, "pi-server", "mcp.json").providers, vec![Pi]);
        let transport = serde_json::to_string(&servers).unwrap();
        for secret in ["qwen-secret", "QWEN_CUSTOM_API_KEY", "yaml-secret"] {
            assert!(!transport.contains(secret), "{secret} leaked");
        }

        fixture.write(
            &home.join(".pi/agent/settings.json"),
            r#"{"extensions":["-builtin:mcp"]}"#,
        );
        let servers = fixture.servers(&[Pi]);
        assert_eq!(
            named(&servers, "pi-server", "mcp.json").unapplied,
            Some(UnappliedReason::Disabled)
        );
    }

    #[test]
    fn one_name_follows_each_agents_precedence() {
        let fixture = Fixture::new();
        let home = fixture.home();
        let project = fixture.project.path();
        let inline = project.join("docs");
        fixture.write(
            &home.join(".kimi-code/mcp.json"),
            r#"{"mcpServers":{"x":{"command":"user"}}}"#,
        );
        fixture.write(
            &project.join(".mcp.json"),
            r#"{"mcpServers":{"x":{"command":"repo"}}}"#,
        );
        fixture.write(
            &inline.join(".mcp.json"),
            r#"{"mcpServers":{"x":{"command":"nearer"}}}"#,
        );
        fixture.write(
            &inline.join(".grok/config.toml"),
            "[mcp_servers.x]\ncommand = \"grok\"\n",
        );

        let servers = scan(
            project,
            &inline,
            &fixture.environment,
            &[ClaudeCode, KimiCode, GrokBuild],
        )
        .unwrap()
        .items
        .into_iter()
        .filter(|item| item.kind == ContextItemKind::McpServer)
        .collect::<Vec<_>>();
        let command = |item: &ContextItem| item.mcp.as_ref().unwrap().command[0].clone();
        let by_command = |name: &str| servers.iter().find(|item| command(item) == name).unwrap();

        // Claude Code: the deeper `.mcp.json` wins.
        assert_eq!(by_command("nearer").providers, vec![ClaudeCode]);
        // Kimi Code: user < repository `.mcp.json`.
        assert_eq!(by_command("repo").providers, vec![KimiCode]);
        assert!(by_command("user").providers.is_empty());
        // Grok Build: its TOML wins over `.mcp.json`.
        assert_eq!(by_command("grok").providers, vec![GrokBuild]);
        assert_eq!(
            reader_superseded(by_command("nearer"), GrokBuild),
            Some(by_command("grok").path.clone())
        );
    }

    #[test]
    fn codex_merges_its_layers_by_fields() {
        let fixture = Fixture::new();
        let home = fixture.home();
        let project = fixture.project.path();
        fixture.write(
            &home.join(".codex/config.toml"),
            "[mcp_servers.merged]\ncommand = \"merged-mcp\"\n",
        );
        fixture.write(
            &project.join(".codex/config.toml"),
            "[mcp_servers.merged]\nenabled = false\n[mcp_servers.lonely]\nenabled = true\n",
        );

        let snapshot = fixture.scan(&[Codex]);
        let servers = snapshot
            .items
            .iter()
            .filter(|item| item.kind == ContextItemKind::McpServer)
            .cloned()
            .collect::<Vec<_>>();

        // The project turns the user's server off; its override is complete
        // with the user's command.
        let merged = |kind| {
            servers
                .iter()
                .find(|item| item.name == "merged" && item.location.kind == kind)
                .unwrap()
        };
        for layer in [
            merged(ContextLocationKind::Home),
            merged(ContextLocationKind::Target),
        ] {
            assert_eq!(layer.unapplied, Some(UnappliedReason::Disabled));
            assert_eq!(layer.health, SourceHealth::Normal);
        }
        // A declaration no layer completes starts no server.
        assert_eq!(
            named(&servers, "lonely", "config.toml").health,
            SourceHealth::Degraded
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "mcp_server_invalid")
        );
    }

    #[test]
    fn cursor_reads_no_server_of_a_file_with_an_invalid_one_and_follows_its_switches() {
        let fixture = Fixture::new();
        let home = fixture.home();
        let project = fixture.project.path();
        fixture.write(
            &project.join(".cursor/mcp.json"),
            "{ // project\n \"mcpServers\": { \"ok\": { \"command\": \"ok\" }, \"bad\": { \"type\": \"stdio\" } } }",
        );
        fixture.write(
            &home.join(".cursor/mcp.json"),
            r#"{"mcpServers":{"mine":{"url":"https://mine.example.com/mcp"}}}"#,
        );

        let servers = fixture.servers(&[Cursor]);
        let ok = named(&servers, "ok", "mcp.json");
        assert!(ok.providers.is_empty());
        assert_eq!(ok.health, SourceHealth::Degraded);
        assert_eq!(named(&servers, "mine", "mcp.json").providers, vec![Cursor]);

        let root = fixture
            .root()
            .to_string_lossy()
            .replace(|c: char| !c.is_ascii_alphanumeric(), "-");
        fixture.write(
            &home
                .join(".cursor/projects")
                .join(root.trim_start_matches('-'))
                .join("mcp-disabled.json"),
            r#"["mine"]"#,
        );
        let servers = fixture.servers(&[Cursor]);
        assert_eq!(
            named(&servers, "mine", "mcp.json").unapplied,
            Some(UnappliedReason::Disabled)
        );
    }

    #[test]
    fn a_broken_config_is_a_diagnostic_that_does_not_quote_it() {
        let fixture = Fixture::new();
        fixture.write(
            &fixture.project.path().join(".mcp.json"),
            r#"{"mcpServers":{"x":{"command":"x","env":{"KEY":"broken-secret"}}"#,
        );

        let snapshot = fixture.scan(&[ClaudeCode]);

        assert!(snapshot.items.is_empty());
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "mcp_config_parse")
        );
        assert!(!format!("{snapshot:?}").contains("broken-secret"));
    }
}
