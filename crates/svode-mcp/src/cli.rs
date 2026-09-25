use svode_tools::error::ToolError;

use crate::config::{self, McpClient};
use crate::{MCP_BRIDGE_PROTOCOL, MCP_VERSION, bridge, headless, stdio};

pub async fn run() -> i32 {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match run_args(&args).await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            1
        }
    }
}

async fn run_args(args: &[String]) -> Result<(), ToolError> {
    match args.first().map(String::as_str) {
        None => automatic().await,
        Some("--app") if args.get(1).map(String::as_str) == Some("desktop") => {
            stdio::run_stdio().await
        }
        Some("--project" | "--space") => {
            let (project, space) = parse_project_args(args)?;
            headless::run(project, space).await
        }
        Some("install") => {
            let client = parse_client_arg(args)?;
            let result = config::install_client(client)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Some("remove") => {
            let client = parse_client_arg(args)?;
            let result = config::remove_client(client)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Some("print-config") => {
            let client = parse_client_arg(args)?;
            let result = config::print_config(client);
            println!("{}", result.manual_config);
            Ok(())
        }
        Some("doctor") => {
            let report = config::doctor(
                bridge::discovery_exists(),
                bridge::desktop_reachable().await,
            );
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("--bridge-protocol") => {
            println!("{MCP_BRIDGE_PROTOCOL}");
            Ok(())
        }
        Some("--version") | Some("-V") => {
            println!("{MCP_VERSION}");
            Ok(())
        }
        Some("--help") | Some("-h") => {
            println!("{}", usage());
            Ok(())
        }
        _ => {
            eprintln!("{}", usage());
            Ok(())
        }
    }
}

/// Mode of a session started without arguments, fixed for its lifetime:
/// the desktop bridge when a compatible desktop app answers at session
/// start, otherwise headless for the Project containing the launch
/// directory.
async fn automatic() -> Result<(), ToolError> {
    if bridge::desktop_reachable().await {
        stdio::run_stdio().await
    } else {
        headless::run_in_cwd().await
    }
}

/// `--project <path> [--space <root|space-id>]`, each given once.
fn parse_project_args(args: &[String]) -> Result<(&str, Option<&str>), ToolError> {
    let invalid = || {
        ToolError::new(
            "INVALID_ARGUMENT",
            "expected --project <path> [--space <root|space-id>]",
        )
    };
    let (mut project, mut space) = (None, None);
    let mut rest = args.iter().map(String::as_str);
    while let Some(flag) = rest.next() {
        let value = rest.next().filter(|value| !value.starts_with("--"));
        let slot = match flag {
            "--project" => &mut project,
            "--space" => &mut space,
            _ => return Err(invalid()),
        };
        if slot.is_some() {
            return Err(invalid());
        }
        *slot = Some(value.ok_or_else(invalid)?);
    }
    Ok((project.ok_or_else(invalid)?, space))
}

fn parse_client_arg(args: &[String]) -> Result<McpClient, ToolError> {
    let client = args
        .windows(2)
        .find_map(|pair| (pair[0] == "--client").then(|| pair[1].as_str()))
        .ok_or_else(|| ToolError::new("INVALID_ARGS", "expected --client <claude-code|codex>"))?;
    McpClient::parse(client)
}

fn usage() -> &'static str {
    "Usage:
  svode-mcp
      Automatic mode, chosen once at session start. With the Svode desktop
      app running: its bridge, targeting SVODE_MCP_PROJECT_PATH, else the
      project of the current directory, else the active window. Without it:
      the Svode project containing the current directory, served headless;
      outside a project, tool calls answer PROJECT_UNAVAILABLE.
  svode-mcp --app desktop
  svode-mcp --project <path> [--space <root|space-id>]
  svode-mcp install --client <claude-code|codex>
  svode-mcp remove --client <claude-code|codex>
  svode-mcp print-config --client <claude-code|codex>
  svode-mcp doctor
  svode-mcp --bridge-protocol
  svode-mcp --version
  svode-mcp --help"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_mode_takes_one_project_and_an_optional_space() {
        let args = |raw: &[&str]| raw.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert_eq!(
            parse_project_args(&args(&["--project", "/p"])).unwrap(),
            ("/p", None)
        );
        assert_eq!(
            parse_project_args(&args(&["--project", "p", "--space", "root"])).unwrap(),
            ("p", Some("root"))
        );
        for invalid in [
            &["--project"][..],
            &["--project", "--space", "root"],
            &["--project", "a", "--project", "b"],
            &["--project", "a", "--space"],
            &["--project", "a", "--other", "x"],
        ] {
            assert_eq!(
                parse_project_args(&args(invalid)).unwrap_err().code,
                "INVALID_ARGUMENT",
                "{invalid:?}"
            );
        }
        assert_eq!(
            parse_project_args(&args(&["--space", "child", "--project", "p"])).unwrap(),
            ("p", Some("child"))
        );
        assert_eq!(
            parse_project_args(&args(&["--space", "child"]))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        assert!(usage().contains("--project <path> [--space <root|space-id>]"));
    }
}
