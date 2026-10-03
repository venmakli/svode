//! opencode, Qwen Code, pi, Kimi Code, Hermes, Grok Build and Cursor (Stage
//! 10 `03` A9, E03) on a temporary home: the agent commands are scripts that
//! log their arguments and write the config the real command would leave.

use std::fs;
use std::os::unix::fs::PermissionsExt;

use svode_core::agent_adapters::AgentAdapterKind;

use super::{Home, client};
use crate::{Client, MARKER, MARKER_ENV, Machine, connect, disconnect, reconcile, status};

struct Agent {
    kind: AgentAdapterKind,
    executable: &'static str,
    /// The user config, relative to the home directory.
    config: &'static str,
}

const OPENCODE: Agent = Agent {
    kind: AgentAdapterKind::Opencode,
    executable: "opencode",
    config: ".config/opencode/opencode.json",
};
const QWEN: Agent = Agent {
    kind: AgentAdapterKind::QwenCode,
    executable: "qwen",
    config: ".qwen/settings.json",
};
const PI: Agent = Agent {
    kind: AgentAdapterKind::Pi,
    executable: "pi",
    config: ".pi/agent/mcp.json",
};
const KIMI: Agent = Agent {
    kind: AgentAdapterKind::KimiCode,
    executable: "kimi",
    config: ".kimi-code/mcp.json",
};
const COMMAND_AGENTS: [Agent; 3] = [OPENCODE, QWEN, PI];
/// The agents with an MCP entry in their JSON config.
const JSON_AGENTS: [Agent; 4] = [OPENCODE, QWEN, PI, KIMI];

impl Agent {
    fn client(&self) -> Client {
        Client::of(self.kind)
    }

    /// The entry the agent's `mcp add` writes, inside the content it keeps.
    fn config_with_entry(&self, home: &Home) -> String {
        let launcher = home.launcher().display().to_string();
        match self.kind {
            AgentAdapterKind::Opencode => format!(
                "{{\n  // mine\n  \"theme\": \"dark\",\n  \"mcp\": {{\n    \"servers\": {{\n      \"other\": {{ \"type\": \"local\", \"command\": [\"other\"] }},\n      \"svode\": {{\n        \"type\": \"local\",\n        \"command\": [\"{launcher}\"],\n        \"environment\": {{ \"{MARKER_ENV}\": \"{MARKER}\" }}\n      }}\n    }}\n  }}, // trailing\n}}\n"
            ),
            _ => format!(
                "{{\n  // mine\n  \"model\": {{ \"name\": \"x\" }},\n  \"mcpServers\": {{\n    \"other\": {{ \"command\": \"other\" }},\n    \"svode\": {{\n      \"command\": \"{launcher}\",\n      \"args\": [],\n      \"env\": {{ \"{MARKER_ENV}\": \"{MARKER}\" }}\n    }}\n  }}\n}}\n"
            ),
        }
    }

    /// What stays once the Svode entry is gone.
    fn config_without_entry(&self) -> &'static str {
        match self.kind {
            AgentAdapterKind::Opencode => {
                "{\n  // mine\n  \"theme\": \"dark\",\n  \"mcp\": {\n    \"servers\": {\n      \"other\": { \"type\": \"local\", \"command\": [\"other\"] }\n    }\n  }, // trailing\n}\n"
            }
            _ => {
                "{\n  // mine\n  \"model\": { \"name\": \"x\" },\n  \"mcpServers\": {\n    \"other\": { \"command\": \"other\" }\n  }\n}\n"
            }
        }
    }
}

/// A home with the desktop runtime and fake agent commands on `bin`: each
/// logs its arguments to `~/<executable>.log`, fails with
/// `~/<executable>.stderr` when present and otherwise copies
/// `~/<executable>.next` over its config.
fn home_with_agents(agents: &[&Agent]) -> (Home, Machine) {
    let home = Home::with_desktop();
    for agent in agents {
        let script = format!(
            "#!/bin/sh\necho \"$*\" >> \"$HOME/{exe}.log\"\nif [ -f \"$HOME/{exe}.stderr\" ]; then cat \"$HOME/{exe}.stderr\" >&2; exit 1; fi\nif [ -f \"$HOME/{exe}.next\" ]; then mkdir -p \"$(dirname \"$HOME/{config}\")\"; cp \"$HOME/{exe}.next\" \"$HOME/{config}\"; fi\n",
            exe = agent.executable,
            config = agent.config,
        );
        let path = format!("bin/{}", agent.executable);
        home.write(&path, &script);
        fs::set_permissions(home.path(&path), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let machine = home.machine().with_search_path(Some(&search_path(&home)));
    (home, machine)
}

/// The PATH of a login shell: the agents first, then the system tools
/// their scripts use.
fn search_path(home: &Home) -> std::ffi::OsString {
    format!("{}:/usr/bin:/bin", home.path("bin").display()).into()
}

/// An agent executable that does nothing, so the agent is found.
fn on_path(home: &Home, executable: &str) {
    let path = format!("bin/{executable}");
    home.write(&path, "#!/bin/sh\n");
    fs::set_permissions(home.path(&path), fs::Permissions::from_mode(0o755)).unwrap();
}

fn runs(home: &Home, agent: &Agent) -> Vec<String> {
    home.read(&format!("{}.log", agent.executable))
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn each_agent_gets_its_entry_by_its_own_command_and_one_shared_skill() {
    for agent in &COMMAND_AGENTS {
        let (home, machine) = home_with_agents(&[agent]);
        home.write(
            &format!("{}.next", agent.executable),
            &agent.config_with_entry(&home),
        );

        assert!(
            connect(&machine, agent.client()).unwrap(),
            "{}",
            agent.executable
        );

        let launcher = home.launcher().display().to_string();
        let marker = format!("{MARKER_ENV}={MARKER}");
        let expected = match agent.kind {
            AgentAdapterKind::Opencode => {
                format!("mcp add --global --env {marker} svode -- {launcher}")
            }
            AgentAdapterKind::QwenCode => format!("mcp add -s user -e {marker} svode {launcher}"),
            _ => format!("mcp add svode --env {marker} -- {launcher}"),
        };
        assert_eq!(runs(&home, agent), [expected]);
        // One copy of the skill: the shared one, no skill of the agent's own.
        assert_eq!(
            home.link(".agents/skills/svode").unwrap(),
            home.path(".svode/current/plugins/svode/skills/svode")
        );
        assert!(home.link(".claude/skills/svode").is_none());

        let status = status(&machine, &[], None);
        let own = client(&status, agent.client());
        assert!(own.installed && own.complete, "{own:?}");
        assert_eq!(own.status, "installed");
        let part = own.own_part.as_ref().unwrap();
        assert_eq!(
            (part.kind.as_str(), part.state.as_str()),
            ("mcp-entry", "managed")
        );
        assert_eq!(part.path, home.path(agent.config).display().to_string());
        assert_eq!(own.limitation, None);
        assert_eq!(status.shared_skill.readers, [agent.kind.as_str()]);
        assert_eq!(status.shared_skill.required_by, [agent.kind.as_str()]);

        // Connecting again runs nothing and changes nothing.
        assert!(!connect(&machine, agent.client()).unwrap());
        assert_eq!(runs(&home, agent).len(), 1);
    }
}

#[test]
fn reconcile_completes_only_agents_with_their_own_part_without_rerunning_them() {
    for agent in &JSON_AGENTS {
        let (home, machine) = home_with_agents(&[agent]);
        home.write(agent.config, &agent.config_with_entry(&home));

        // The entry is there, the shared skill is not: drift, restored.
        assert_eq!(reconcile(&machine), (true, Vec::new()));
        assert!(home.link(".agents/skills/svode").is_some());
        assert!(runs(&home, agent).is_empty(), "{}", agent.executable);

        // The shared skill alone connects nobody: nothing is written back.
        home.write(agent.config, agent.config_without_entry());
        assert_eq!(reconcile(&machine), (false, Vec::new()));
        assert_eq!(home.read(agent.config), agent.config_without_entry());
        assert!(runs(&home, agent).is_empty());
        assert!(!client(&status(&machine, &[], None), agent.client()).installed);
    }
}

#[test]
fn an_entry_svode_did_not_write_in_full_is_written_again_by_the_agent() {
    let (home, machine) = home_with_agents(&[&QWEN]);
    home.write(
        QWEN.config,
        &format!(
            r#"{{ "mcpServers": {{ "svode": {{ "command": "/old/svode-mcp", "env": {{ "{MARKER_ENV}": "{MARKER}" }} }} }} }}"#
        ),
    );
    home.write("qwen.next", &QWEN.config_with_entry(&home));
    connect(&machine, QWEN.client()).unwrap();
    assert!(runs(&home, &QWEN)[0].starts_with("mcp add"));
    assert!(client(&status(&machine, &[], None), QWEN.client()).complete);
}

#[test]
fn removing_an_agent_takes_off_its_marked_entry_only_and_keeps_the_rest() {
    for agent in &COMMAND_AGENTS {
        let (home, machine) = home_with_agents(&[agent]);
        home.write(
            &format!("{}.next", agent.executable),
            &agent.config_with_entry(&home),
        );
        connect(&machine, agent.client()).unwrap();
        home.write(".agents/skills/other/SKILL.md", "other");

        assert!(
            disconnect(&machine, agent.client()).unwrap(),
            "{}",
            agent.executable
        );

        // Comments, trailing commas and foreign servers stay byte for byte.
        assert_eq!(home.read(agent.config), agent.config_without_entry());
        assert!(home.link(".agents/skills/svode").is_some());
        assert_eq!(home.read(".agents/skills/other/SKILL.md"), "other");
        // No agent command removes anything.
        assert_eq!(runs(&home, agent).len(), 1);
        assert!(!disconnect(&machine, agent.client()).unwrap());
        assert_eq!(reconcile(&machine), (false, Vec::new()));
        assert!(!client(&status(&machine, &[], None), agent.client()).installed);
    }
}

#[test]
fn a_custom_entry_is_a_conflict_that_refuses_before_any_write_or_run() {
    for agent in &JSON_AGENTS {
        let (home, machine) = home_with_agents(&[agent]);
        let custom = match agent.kind {
            AgentAdapterKind::Opencode => {
                "{ \"mcp\": { \"servers\": { \"svode\": { \"type\": \"local\", \"command\": [\"my-wrapper\"] } } } }\n"
            }
            _ => "{ \"mcpServers\": { \"svode\": { \"command\": \"my-wrapper\" } } }\n",
        };
        home.write(agent.config, custom);

        let error = connect(&machine, agent.client()).unwrap_err();
        assert_eq!(error.code, "CUSTOM_CONFIG_CONFLICT", "{}", agent.executable);
        assert!(runs(&home, agent).is_empty());
        assert!(home.link(".agents/skills/svode").is_none());
        let own = client(&status(&machine, &[], None), agent.client());
        assert_eq!(own.attention_code.as_deref(), Some("custom_conflict"));
        assert!(!disconnect(&machine, agent.client()).unwrap());
        assert_eq!(home.read(agent.config), custom);
    }
}

#[test]
fn opencode_entries_of_its_other_config_and_its_previous_form_are_not_svodes() {
    let (home, machine) = home_with_agents(&[&OPENCODE]);
    home.write(".config/opencode/opencode.json", "{}");
    home.write(
        ".config/opencode/opencode.jsonc",
        "{ \"mcp\": { \"servers\": { \"svode\": { \"type\": \"local\", \"command\": [\"x\"] } } } }",
    );
    assert_eq!(
        connect(&machine, OPENCODE.client()).unwrap_err().code,
        "CUSTOM_CONFIG_CONFLICT"
    );
    fs::remove_file(home.path(".config/opencode/opencode.jsonc")).unwrap();
    home.write(
        ".config/opencode/opencode.json",
        "{ \"mcp\": { \"svode\": { \"type\": \"local\", \"command\": [\"x\"] } } }",
    );
    assert_eq!(
        connect(&machine, OPENCODE.client()).unwrap_err().code,
        "CUSTOM_CONFIG_CONFLICT"
    );
    assert!(runs(&home, &OPENCODE).is_empty());
}

#[test]
fn opencode_with_only_a_jsonc_config_is_read_and_edited_there() {
    let (home, machine) = home_with_agents(&[&OPENCODE]);
    let jsonc = ".config/opencode/opencode.jsonc";
    home.write(jsonc, &OPENCODE.config_with_entry(&home));
    let status = status(&machine, &[], None);
    let own = client(&status, OPENCODE.client());
    assert!(own.installed);
    assert_eq!(
        own.config_path,
        Some(home.path(jsonc).display().to_string())
    );
    assert!(disconnect(&machine, OPENCODE.client()).unwrap());
    assert_eq!(home.read(jsonc), OPENCODE.config_without_entry());
}

#[test]
fn a_project_entry_that_overrides_the_user_one_is_a_conflict() {
    for (agent, project_config) in [
        (&OPENCODE, "work/notes/opencode.json"),
        (&QWEN, "work/notes/.qwen/settings.json"),
        (&PI, "work/notes/.pi/mcp.json"),
        (&KIMI, "work/notes/.mcp.json"),
        (&KIMI, "work/notes/.kimi-code/mcp.json"),
    ] {
        let (home, _) = home_with_agents(&[agent]);
        let servers = match agent.kind {
            AgentAdapterKind::Opencode => {
                "{ \"mcp\": { \"servers\": { \"svode\": { \"type\": \"local\", \"command\": [\"x\"] } } } }"
            }
            _ => "{ \"mcpServers\": { \"svode\": { \"command\": \"x\" } } }",
        };
        home.write(project_config, servers);
        let machine = home
            .machine_for(Some(&home.path("work/notes")))
            .with_search_path(Some(&search_path(&home)));
        assert_eq!(
            connect(&machine, agent.client()).unwrap_err().code,
            "HIGHER_PRECEDENCE_CONFLICT",
            "{}",
            agent.executable
        );
        assert!(runs(&home, agent).is_empty());
        assert_eq!(
            client(&status(&machine, &[], None), agent.client())
                .attention_code
                .as_deref(),
            Some("higher_precedence_conflict")
        );
    }
}

#[test]
fn a_failing_or_silent_agent_command_is_reported() {
    let (home, machine) = home_with_agents(&[&PI]);
    home.write("pi.stderr", "something\nError: mcp.json is locked\n");
    let error = connect(&machine, PI.client()).unwrap_err();
    assert_eq!(error.code, "AGENT_COMMAND_FAILED");
    assert!(error.message.contains("pi mcp add"), "{error}");
    assert!(error.message.contains("mcp.json is locked"), "{error}");

    fs::remove_file(home.path("pi.stderr")).unwrap();
    let error = connect(&machine, PI.client()).unwrap_err();
    assert_eq!(error.code, "AGENT_COMMAND_FAILED");
    assert!(error.message.contains("did not write"), "{error}");
    assert!(!client(&status(&machine, &[], None), PI.client()).installed);
}

#[test]
fn an_agent_that_is_not_found_is_refused_before_any_write() {
    let (home, machine) = home_with_agents(&[]);
    let error = connect(&machine, QWEN.client()).unwrap_err();
    assert_eq!(error.code, "AGENT_NOT_FOUND");
    assert!(home.link(".agents/skills/svode").is_none());
}

#[test]
fn grok_build_reads_the_shared_skill_only_and_has_nothing_of_its_own() {
    let (home, machine) = home_with_agents(&[&QWEN]);
    on_path(&home, "grok");
    let grok = Client::of(AgentAdapterKind::GrokBuild);
    assert!(!grok.has_own_part());

    let error = connect(&machine, grok).unwrap_err();
    assert_eq!(error.code, "NO_OWN_PART");
    assert!(home.link(".agents/skills/svode").is_none());
    assert!(!disconnect(&machine, grok).unwrap());

    // Connecting Qwen Code brings the shared skill that Grok Build reads too.
    home.write("qwen.next", &QWEN.config_with_entry(&home));
    connect(&machine, QWEN.client()).unwrap();
    let status = status(&machine, &[], None);
    assert_eq!(status.shared_skill.readers, ["qwen-code", "grok-build"]);
    assert_eq!(status.shared_skill.required_by, ["qwen-code"]);
    let grok_status = client(&status, grok);
    assert!(grok_status.found && !grok_status.installed);
    assert!(grok_status.own_part.is_none());
    assert_eq!(grok_status.config_path, None);
    assert!(
        grok_status
            .limitation
            .as_deref()
            .unwrap()
            .contains("own directory")
    );
    assert!(grok_status.issues.is_empty(), "{grok_status:?}");
    assert_eq!(
        grok_status
            .artifacts
            .iter()
            .map(|artifact| (artifact.kind.as_str(), artifact.state.as_str()))
            .collect::<Vec<_>>(),
        [("skill", "managed")]
    );
    let json = serde_json::to_value(&grok_status).unwrap();
    assert!(json["ownPart"].is_null());
    assert_eq!(reconcile(&machine), (false, Vec::new()));
}

#[test]
fn qwen_code_and_pi_settings_that_keep_the_entry_from_working_are_reported() {
    let (home, machine) = home_with_agents(&[&QWEN, &PI]);
    home.write(
        ".qwen/settings.json",
        "{\n  // mine\n  \"mcp\": { \"excluded\": [\"svode\"] },\n}\n",
    );
    home.write(
        "policy/qwen-settings.json",
        "{ \"mcp\": { \"allowed\": [\"docs\"] } }",
    );
    home.write(
        ".pi/agent/settings.json",
        "{ \"packages\": [\"npm:pi-mcp-adapter\"], \"extensions\": [\"-builtin:mcp\"] }",
    );
    let status = status(&machine, &[], None);
    let messages = |agent: &Agent| {
        let own = client(&status, agent.client());
        assert_eq!(own.attention_code.as_deref(), Some("client_policy_blocked"));
        own.issues
            .iter()
            .map(|issue| issue.message.clone())
            .collect::<Vec<_>>()
    };
    let qwen = messages(&QWEN);
    assert!(qwen[0].contains("mcp.excluded"), "{qwen:?}");
    assert!(qwen[1].contains("mcp.allowed"), "{qwen:?}");
    let pi = messages(&PI);
    assert!(pi[0].contains("pi-mcp-adapter"), "{pi:?}");
    assert!(pi[1].contains("-builtin:mcp"), "{pi:?}");

    home.write(
        ".qwen/settings.json",
        "{ \"mcp\": { \"allowed\": [\"svode\"] } }",
    );
    home.write("policy/qwen-settings.json", "{}");
    home.write(
        ".pi/agent/settings.json",
        "{ \"packages\": [{ \"source\": \"npm:other\" }] }",
    );
    let status = crate::status(&machine, &[], None);
    assert!(client(&status, QWEN.client()).issues.is_empty());
    assert!(client(&status, PI.client()).issues.is_empty());
}

#[test]
fn the_manual_config_of_each_agent_is_its_own_command_without_the_marker() {
    let (home, machine) = home_with_agents(&[]);
    let launcher = format!("'{}'", home.launcher().display());
    for (kind, expected) in [
        (
            AgentAdapterKind::Opencode,
            format!("opencode mcp add --global svode -- {launcher}"),
        ),
        (
            AgentAdapterKind::QwenCode,
            format!("qwen mcp add -s user svode {launcher}"),
        ),
        (
            AgentAdapterKind::Pi,
            format!("pi mcp add svode -- {launcher}"),
        ),
        (
            AgentAdapterKind::GrokBuild,
            format!("grok mcp add svode {launcher}"),
        ),
        (
            AgentAdapterKind::Hermes,
            format!("mcp_servers:\n  svode:\n    command: {launcher}\n"),
        ),
    ] {
        let text = crate::manual_config_text(&machine, Client::of(kind));
        assert_eq!(text, expected);
        assert!(!text.contains(MARKER_ENV));
    }
    for kind in [AgentAdapterKind::KimiCode, AgentAdapterKind::Cursor] {
        let text = crate::manual_config_text(&machine, Client::of(kind));
        let config: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            config["mcpServers"]["svode"]["command"],
            home.launcher().display().to_string()
        );
        assert!(!text.contains(MARKER_ENV));
    }
}

#[test]
fn kimi_code_gets_its_entry_written_into_its_json_and_the_rest_kept() {
    let (home, machine) = home_with_agents(&[&KIMI]);
    let before = "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"other\"\n    }\n  },\n  \"theme\": \"dark\"\n}\n";
    home.write(KIMI.config, before);

    assert!(connect(&machine, KIMI.client()).unwrap());

    let launcher = home.launcher().display().to_string();
    let after = format!(
        "{{\n  \"mcpServers\": {{\n    \"other\": {{\n      \"command\": \"other\"\n    }},\n    \"svode\": {{\n      \"command\": \"{launcher}\",\n      \"args\": [],\n      \"env\": {{\n        \"{MARKER_ENV}\": \"{MARKER}\"\n      }}\n    }}\n  }},\n  \"theme\": \"dark\"\n}}\n"
    );
    assert_eq!(home.read(KIMI.config), after);
    // Kimi Code reads strict JSON, and no Kimi command ran.
    serde_json::from_str::<serde_json::Value>(&after).unwrap();
    assert!(runs(&home, &KIMI).is_empty());
    assert_eq!(
        home.link(".agents/skills/svode").unwrap(),
        home.path(".svode/current/plugins/svode/skills/svode")
    );
    assert!(home.link(".claude/skills/svode").is_none());

    let status = status(&machine, &[], None);
    let own = client(&status, KIMI.client());
    assert!(own.installed && own.complete, "{own:?}");
    let part = own.own_part.as_ref().unwrap();
    assert_eq!(
        (part.kind.as_str(), part.state.as_str()),
        ("mcp-entry", "managed")
    );
    assert_eq!(part.path, home.path(KIMI.config).display().to_string());
    assert_eq!(own.limitation, None);
    assert_eq!(status.shared_skill.readers, ["kimi-code"]);
    assert_eq!(status.shared_skill.required_by, ["kimi-code"]);

    assert!(!connect(&machine, KIMI.client()).unwrap());
    assert_eq!(home.read(KIMI.config), after);

    assert!(disconnect(&machine, KIMI.client()).unwrap());
    assert_eq!(home.read(KIMI.config), before);
    assert!(home.link(".agents/skills/svode").is_some());
    assert_eq!(reconcile(&machine), (false, Vec::new()));
}

#[test]
fn kimi_code_without_a_config_gets_one_with_its_entry_only() {
    let (home, machine) = home_with_agents(&[&KIMI]);
    assert!(connect(&machine, KIMI.client()).unwrap());
    let config: serde_json::Value = serde_json::from_str(&home.read(KIMI.config)).unwrap();
    assert_eq!(
        config,
        serde_json::json!({ "mcpServers": { "svode": {
            "command": home.launcher().display().to_string(),
            "args": [],
            "env": { MARKER_ENV: MARKER },
        } } })
    );
    assert!(client(&status(&machine, &[], None), KIMI.client()).complete);
}

const HERMES_CONFIG: &str = ".hermes/config.yaml";
/// A config in the form Hermes writes it.
const HERMES_BEFORE: &str = "model:\n  default: gpt-6.1\n# skills\nskills:\n  creation_nudge_interval: 15\n  disabled: []\n_config_version: 49\n";

fn hermes() -> Client {
    Client::of(AgentAdapterKind::Hermes)
}

#[test]
fn hermes_lists_the_shared_skill_directory_by_its_own_marked_item() {
    let (home, machine) = home_with_agents(&[]);
    on_path(&home, "hermes");
    home.write(HERMES_CONFIG, HERMES_BEFORE);
    assert!(status(&machine, &[], None).shared_skill.readers.is_empty());

    assert!(connect(&machine, hermes()).unwrap());

    let after = format!(
        "model:\n  default: gpt-6.1\n# skills\nskills:\n  external_dirs:\n    - ~/.agents/skills  # {MARKER}\n  creation_nudge_interval: 15\n  disabled: []\n_config_version: 49\n"
    );
    assert_eq!(home.read(HERMES_CONFIG), after);
    assert!(home.link(".agents/skills/svode").is_some());
    assert!(home.link(".claude/skills/svode").is_none());

    let status = status(&machine, &[], None);
    let own = client(&status, hermes());
    assert!(own.installed && own.complete, "{own:?}");
    assert_eq!(own.status, "installed");
    let part = own.own_part.as_ref().unwrap();
    assert_eq!(
        (part.kind.as_str(), part.state.as_str()),
        ("skills-entry", "managed")
    );
    assert_eq!(part.path, home.path(HERMES_CONFIG).display().to_string());
    assert_eq!(own.config_path, Some(part.path.clone()));
    assert!(own.limitation.as_deref().unwrap().contains("own directory"));
    assert_eq!(
        own.artifacts
            .iter()
            .map(|artifact| artifact.kind.as_str())
            .collect::<Vec<_>>(),
        ["skill", "skills-entry"]
    );
    assert_eq!(status.shared_skill.readers, ["hermes"]);
    assert_eq!(status.shared_skill.required_by, ["hermes"]);

    assert!(!connect(&machine, hermes()).unwrap());
    // Drift of the shared part is repaired; the own part is not rewritten.
    fs::remove_file(home.path(".agents/skills/svode")).unwrap();
    assert_eq!(reconcile(&machine), (true, Vec::new()));
    assert!(home.link(".agents/skills/svode").is_some());
    assert_eq!(home.read(HERMES_CONFIG), after);

    assert!(disconnect(&machine, hermes()).unwrap());
    assert_eq!(home.read(HERMES_CONFIG), HERMES_BEFORE);
    assert!(home.link(".agents/skills/svode").is_some());
    let status = crate::status(&machine, &[], None);
    assert!(!client(&status, hermes()).installed);
    assert!(status.shared_skill.readers.is_empty());
    assert_eq!(reconcile(&machine), (false, Vec::new()));
    assert!(!disconnect(&machine, hermes()).unwrap());
}

#[test]
fn hermes_reading_the_shared_skill_by_an_item_of_its_own_is_not_connected() {
    let (home, machine) = home_with_agents(&[]);
    on_path(&home, "hermes");
    let mine = "skills:\n  external_dirs:\n    - ~/.agents/skills\n";
    home.write(HERMES_CONFIG, mine);

    let status = status(&machine, &[], None);
    assert_eq!(status.shared_skill.readers, ["hermes"]);
    assert!(status.shared_skill.required_by.is_empty());
    assert!(!client(&status, hermes()).installed);
    assert_eq!(reconcile(&machine), (false, Vec::new()));
    assert_eq!(home.read(HERMES_CONFIG), mine);

    // Svode adds its own item next to the user's; Hermes drops the
    // directory it lists twice.
    connect(&machine, hermes()).unwrap();
    assert_eq!(
        home.read(HERMES_CONFIG),
        format!("{mine}    - ~/.agents/skills  # {MARKER}\n")
    );
    disconnect(&machine, hermes()).unwrap();
    assert_eq!(home.read(HERMES_CONFIG), mine);
}

#[test]
fn hermes_configs_svode_does_not_edit_and_settings_that_turn_the_skill_off_are_reported() {
    let (home, machine) = home_with_agents(&[]);
    on_path(&home, "hermes");
    let inline = "skills: {external_dirs: [/team/skills]}\n";
    home.write(HERMES_CONFIG, inline);
    let error = connect(&machine, hermes()).unwrap_err();
    assert_eq!(error.code, "CONFIG_UNSUPPORTED_FORM");
    assert!(error.message.contains("skills.external_dirs"), "{error}");
    assert_eq!(home.read(HERMES_CONFIG), inline);

    home.write(HERMES_CONFIG, "skills: [\n");
    assert_eq!(
        connect(&machine, hermes()).unwrap_err().code,
        "CONFIG_UNREADABLE"
    );
    assert_eq!(
        client(&status(&machine, &[], None), hermes())
            .attention_code
            .as_deref(),
        Some("config_unreadable")
    );

    for disabled in ["[svode]", "\"['svode', 'other']\""] {
        home.write(HERMES_CONFIG, &format!("skills:\n  disabled: {disabled}\n"));
        let own = client(&status(&machine, &[], None), hermes());
        assert_eq!(
            own.attention_code.as_deref(),
            Some("client_policy_blocked"),
            "{disabled}"
        );
        assert!(own.issues[0].message.contains("skills.disabled"));
    }
}

#[test]
fn cursor_reads_the_shared_skill_only_and_its_mcp_json_is_never_written() {
    let (home, machine) = home_with_agents(&[&QWEN]);
    on_path(&home, "cursor-agent");
    let cursor_mcp = "{\n  // the IDE's\n  \"mcpServers\": { \"docs\": { \"url\": \"https://example.com\" } }\n}\n";
    home.write(".cursor/mcp.json", cursor_mcp);
    let cursor = Client::of(AgentAdapterKind::Cursor);
    assert!(!cursor.has_own_part());

    let error = connect(&machine, cursor).unwrap_err();
    assert_eq!(error.code, "NO_OWN_PART");
    assert!(error.message.contains("approved"), "{error}");
    assert!(home.link(".agents/skills/svode").is_none());

    home.write("qwen.next", &QWEN.config_with_entry(&home));
    connect(&machine, QWEN.client()).unwrap();
    assert_eq!(reconcile(&machine), (false, Vec::new()));
    assert!(!disconnect(&machine, cursor).unwrap());

    let status = status(&machine, &[], None);
    assert_eq!(status.shared_skill.readers, ["cursor", "qwen-code"]);
    assert_eq!(status.shared_skill.required_by, ["qwen-code"]);
    let own = client(&status, cursor);
    assert!(own.found && !own.installed);
    assert!(own.own_part.is_none());
    assert_eq!(own.config_path, None);
    assert!(own.issues.is_empty(), "{own:?}");
    assert!(own.limitation.as_deref().unwrap().contains("approved"));
    assert_eq!(home.read(".cursor/mcp.json"), cursor_mcp);
}
