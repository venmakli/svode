//! Agents running in terminals of Svode (DF-225). While a process of a
//! built-in agent whose terminal sessions the catalogue gets from its ACP
//! list runs in a terminal of Svode, that agent keeps its catalogue
//! connection as an open Sessions collection does (R1). The process is told
//! in the tree of the terminal's shell by the executable the registry knows,
//! also under an interpreter, at the read boundaries of the read-model:
//! list, refresh and hot status (R2). The list tells the terminals of the
//! project that no listed session of their agent runs in, so the catalogue
//! is polled faster until one does (R3); rows and links come from the
//! existing sources alone (R4).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use svode_agents::registry::{AdapterRuntimeRegistry, CatalogSource};
use svode_core::agent_adapters::AgentAdapterKind;
use tauri::async_runtime::JoinHandle;

use super::acp_list::{AcpListSources, CatalogLister};
use super::scope;
use super::types::AgentSession;
use crate::agent_runtime::connections::AgentConnections;
use crate::terminal::LivePtyProcesses;

/// A live terminal of Svode with the agents whose processes run under its
/// shell, the one nearest the shell first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AgentTerminal {
    pub pty_id: String,
    /// The directory the shell was started in.
    pub cwd: String,
    pub agents: Vec<AgentAdapterKind>,
}

/// The live terminals with a process of an agent whose terminal sessions
/// the catalogue gets from its ACP list.
pub(super) fn agent_terminals(ptys: &[LivePtyProcesses]) -> Vec<AgentTerminal> {
    let listing = AgentAdapterKind::ALL
        .into_iter()
        .filter(|agent| lists_terminal_sessions(*agent))
        .collect::<Vec<_>>();
    ptys.iter()
        .filter_map(|pty| {
            let mut agents = Vec::new();
            for process in &pty.processes {
                for agent in &listing {
                    if !agents.contains(agent) && process.runs(agent.executable()) {
                        agents.push(*agent);
                    }
                }
            }
            (!agents.is_empty()).then(|| AgentTerminal {
                pty_id: pty.pty_id.clone(),
                cwd: pty.cwd.clone(),
                agents,
            })
        })
        .collect()
}

/// Whether the catalogue gets the sessions of the agent's terminal CLI
/// from its ACP list alone: a native catalogue, as of Hermes and of the
/// terminal chats of Cursor, reads them without a connection.
fn lists_terminal_sessions(agent: AgentAdapterKind) -> bool {
    let sources = AdapterRuntimeRegistry.catalog_sources(agent);
    sources.contains(&CatalogSource::AcpList)
        && !sources
            .iter()
            .any(|source| matches!(source, CatalogSource::Native(_)))
}

/// The agents of the terminals hold their catalogue connections, and those
/// of agents no terminal runs any more are let go; an agent held from now
/// on is started unless its connection is open, and its list is read.
pub(super) fn hold_catalogs(
    sources: &Arc<AcpListSources>,
    connections: &Arc<AgentConnections>,
    lister: &impl CatalogLister,
    terminals: &[AgentTerminal],
) -> Vec<JoinHandle<()>> {
    let agents = terminals
        .iter()
        .flat_map(|terminal| &terminal.agents)
        .map(|agent| agent.as_str().to_string());
    let raised = connections.hold_terminal_agents(agents);
    sources.raise_agents(connections, lister, raised)
}

/// The terminals in the folders of the project whose nearest agent no
/// listed session of that agent runs in.
pub(super) fn without_session(
    project: &Path,
    terminals: &[AgentTerminal],
    sessions: &[AgentSession],
) -> Vec<String> {
    if terminals.is_empty() {
        return Vec::new();
    }
    let folders = scope::project_folders(project);
    terminals
        .iter()
        .filter(|terminal| {
            let cwd = Path::new(&terminal.cwd);
            let cwd = cwd.canonicalize().unwrap_or_else(|_| PathBuf::from(cwd));
            folders.iter().any(|folder| cwd.starts_with(folder))
        })
        .filter(|terminal| {
            let agent = terminal.agents[0].id();
            !sessions.iter().any(|session| {
                session.source == agent
                    && session.runtime.as_ref().is_some_and(|runtime| {
                        runtime.live && runtime.pty_id.as_deref() == Some(&terminal.pty_id)
                    })
            })
        })
        .map(|terminal| terminal.pty_id.clone())
        .collect()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::terminal::PtyProcess;

    /// A process of a terminal tree with its name and the names its command
    /// line gives it, as the process tree reads them.
    pub(crate) fn process(pid: u32, depth: usize, name: &str, command: &[&str]) -> PtyProcess {
        PtyProcess {
            pid,
            depth,
            start_time: 1,
            name: name.to_string(),
            command_names: command.iter().map(|name| name.to_string()).collect(),
        }
    }

    pub(crate) fn pty(pty_id: &str, cwd: &str, processes: Vec<PtyProcess>) -> LivePtyProcesses {
        LivePtyProcesses {
            pty_id: pty_id.to_string(),
            cwd: cwd.to_string(),
            processes,
        }
    }

    fn session(id: &str, source: &str, pty_id: Option<&str>) -> AgentSession {
        let mut session = serde_json::json!({
            "id": id,
            "source": source,
            "sourceSessionId": id,
            "title": id,
            "titleSource": "session-id",
            "status": {
                "state": "idle",
                "stopReason": "end_turn",
                "source": "native_status_reader",
                "confidence": "approximate"
            },
            "scopeKind": "project",
            "scopeStatus": "ready",
            "scopeConfidence": "exact",
            "lastActivityAt": "2026-10-30T10:00:00Z",
            "capabilities": { "canResume": true }
        });
        if let Some(pty_id) = pty_id {
            session["runtime"] = serde_json::json!({ "ptyId": pty_id, "live": true });
        }
        serde_json::from_value(session).expect("a session")
    }

    #[test]
    fn a_terminal_is_told_by_the_agents_whose_terminal_sessions_their_acp_list_gives() {
        let terminals = agent_terminals(&[
            pty(
                "plain",
                "/w",
                vec![
                    process(1, 0, "zsh", &["-zsh"]),
                    process(2, 1, "vim", &["vim"]),
                ],
            ),
            pty(
                "claude-node",
                "/w",
                vec![
                    process(3, 0, "zsh", &["-zsh"]),
                    process(4, 1, "node", &["node", "claude"]),
                ],
            ),
            pty(
                "codex-npm",
                "/w",
                vec![
                    process(5, 0, "zsh", &["-zsh"]),
                    process(6, 1, "node", &["node", "codex.js"]),
                    process(7, 2, "codex", &["codex"]),
                    process(8, 3, "2.1.312", &["claude"]),
                ],
            ),
            pty(
                "native-catalogues",
                "/w",
                vec![
                    process(9, 0, "zsh", &["-zsh"]),
                    process(10, 1, "hermes", &["hermes"]),
                    process(11, 1, "cursor-agent", &["cursor-agent"]),
                    process(12, 1, "my-custom-agent", &["my-custom-agent"]),
                ],
            ),
            pty(
                "others",
                "/w",
                vec![
                    process(13, 0, "zsh", &["-zsh"]),
                    process(14, 1, "qwen", &["qwen"]),
                    process(15, 1, "opencode", &["opencode"]),
                    process(16, 1, "python3.12", &["python3", "kimi"]),
                    process(17, 1, "grok", &["grok"]),
                    process(18, 1, "pi", &["pi"]),
                ],
            ),
        ]);
        let agents = |pty_id: &str| {
            terminals
                .iter()
                .find(|terminal| terminal.pty_id == pty_id)
                .map(|terminal| terminal.agents.clone())
        };
        assert_eq!(agents("plain"), None);
        assert_eq!(
            agents("claude-node"),
            Some(vec![AgentAdapterKind::ClaudeCode])
        );
        assert_eq!(
            agents("codex-npm"),
            Some(vec![AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode]),
            "the agent nearest the shell first"
        );
        assert_eq!(agents("native-catalogues"), None);
        assert_eq!(
            agents("others"),
            Some(vec![
                AgentAdapterKind::QwenCode,
                AgentAdapterKind::Opencode,
                AgentAdapterKind::KimiCode,
                AgentAdapterKind::GrokBuild,
                AgentAdapterKind::Pi,
            ])
        );
    }

    #[test]
    fn the_list_tells_the_project_terminals_no_listed_session_of_their_agent_runs_in() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let other = temp.path().join("other");
        std::fs::create_dir_all(project.join("notes")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let project = project.canonicalize().unwrap();
        let cwd = |path: &Path| path.to_string_lossy().into_owned();
        let terminal = |pty_id: &str, cwd: String, agent| AgentTerminal {
            pty_id: pty_id.to_string(),
            cwd,
            agents: vec![agent],
        };
        let terminals = [
            terminal("claude-listed", cwd(&project), AgentAdapterKind::ClaudeCode),
            terminal(
                "claude-new",
                cwd(&project.join("notes")),
                AgentAdapterKind::ClaudeCode,
            ),
            terminal("codex-unbound", cwd(&project), AgentAdapterKind::Codex),
            terminal("codex-elsewhere", cwd(&other), AgentAdapterKind::Codex),
        ];
        let sessions = [
            session("claude-code:s1", "claude-code", Some("claude-listed")),
            session("claude-code:s2", "claude-code", None),
            // A session of another agent in the terminal is not this agent's.
            session("codex:t0", "codex", Some("claude-new")),
            session("codex:t1", "codex", None),
        ];
        assert_eq!(
            without_session(&project, &terminals, &sessions),
            ["claude-new", "codex-unbound"]
        );
        assert!(without_session(&project, &[], &sessions).is_empty());
    }
}
