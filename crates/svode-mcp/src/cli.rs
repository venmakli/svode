use crate::config::{self, McpClient};
use crate::error::McpBusinessError;
use crate::{MCP_BRIDGE_PROTOCOL, MCP_VERSION, bridge, stdio};

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

async fn run_args(args: &[String]) -> Result<(), McpBusinessError> {
    match args.first().map(String::as_str) {
        Some("--app") if args.get(1).map(String::as_str) == Some("desktop") => {
            stdio::run_stdio().await
        }
        Some("--project") => Err(project_mode_unavailable()),
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
        _ => {
            eprintln!("{}", usage());
            Ok(())
        }
    }
}

fn project_mode_unavailable() -> McpBusinessError {
    McpBusinessError::new(
        "MODE_UNAVAILABLE",
        "svode-mcp --project is not available in this build; use --app desktop with a running Svode desktop",
    )
}

fn parse_client_arg(args: &[String]) -> Result<McpClient, McpBusinessError> {
    let client = args
        .windows(2)
        .find_map(|pair| (pair[0] == "--client").then(|| pair[1].as_str()))
        .ok_or_else(|| {
            McpBusinessError::new("INVALID_ARGS", "expected --client <claude-code|codex>")
        })?;
    McpClient::parse(client)
}

fn usage() -> &'static str {
    "Usage:
  svode-mcp --app desktop
  svode-mcp install --client <claude-code|codex>
  svode-mcp remove --client <claude-code|codex>
  svode-mcp print-config --client <claude-code|codex>
  svode-mcp doctor
  svode-mcp --bridge-protocol
  svode-mcp --version"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn project_mode_is_a_controlled_unavailable_error_outside_usage() {
        let args = ["--project".to_string(), "/tmp/project".to_string()];
        let error = run_args(&args)
            .await
            .expect_err("project mode is unavailable");

        assert_eq!(error.code, "MODE_UNAVAILABLE");
        assert!(!usage().contains("--project"));
    }
}
