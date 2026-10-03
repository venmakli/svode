//! opencode, Qwen Code, pi and Grok Build (Stage 10 `03` A9, E03) on a
//! temporary home: the agent commands are scripts that log their arguments
//! and write the config the real command would leave.

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
const COMMAND_AGENTS: [Agent; 3] = [OPENCODE, QWEN, PI];

impl Agent {
    fn client(&self) -> Client {
        Client::of(self.kind).unwrap()
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

fn grok_on_path(home: &Home) {
    home.write("bin/grok", "#!/bin/sh\n");
    fs::set_permissions(home.path("bin/grok"), fs::Permissions::from_mode(0o755)).unwrap();
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
    for agent in &COMMAND_AGENTS {
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
    for agent in &COMMAND_AGENTS {
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
    grok_on_path(&home);
    let grok = Client::of(AgentAdapterKind::GrokBuild).unwrap();
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
    ] {
        let text = crate::manual_config_text(&machine, Client::of(kind).unwrap());
        assert_eq!(text, expected);
        assert!(!text.contains(MARKER_ENV));
    }
}
