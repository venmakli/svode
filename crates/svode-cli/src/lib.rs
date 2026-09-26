//! The `svode` command over the shared tool surface. The binary runs it on
//! the shared standalone host of `svode-tools`; tests run the same frame on
//! a harness host with a prepared runtime.

mod access;
mod doctor;
mod error;
pub mod grammar;
mod input;
mod integration;
mod output;
mod render;
mod target;
mod tools;

use std::ffi::OsString;
use std::path::Path;

use clap::Parser;
use clap::error::ErrorKind;
use serde_json::json;
use svode_tools::dispatch::call_tool;
use svode_tools::host::ToolHost;

use error::CliError;
use grammar::{AccessVerb, Cli, GitVerb, Noun};
use output::Outcome;
pub use output::Rendered;
use target::Selectors;

const FILES_FIRST: &str = "\
Files-first rules for agents and scripts:
- Svode data are Markdown and YAML files in Git. Edit the text below the frontmatter of an existing Page, item or README with your own tools, keeping the frontmatter byte for byte, the line endings and the file location; a new plain Page in an existing folder without a schema can be created directly. Svode and the desktop app pick these edits up.
- Everything else goes through Svode commands, so its effects are applied: frontmatter (metadata, fields, relations), names and structure (items, Pages under a leaf Page, rename, move, delete, convert, order), Collection schema and views, attachments, Routine definitions and the .svode, .routines and .templates folders. A field changed directly records no Routine event.
- Never delete or hand-repair .svode metadata. A failed command reports its code and target; reread the source and apply the intent again.
- svode never commits to Git; commit separately when you decide to.
";

/// Parses the command line. Help and version render to stdout with exit 0;
/// every other parse failure is `INVALID_ARGUMENT` with exit 2.
pub fn parse(raw: &[OsString]) -> Result<Cli, Rendered> {
    Cli::try_parse_from(raw).map_err(|error| grammar_failure(error, raw))
}

/// Failure to start the command runtime itself.
pub fn runtime_failure(error: std::io::Error, json: bool) -> Rendered {
    output::failure(&CliError::operation("IO_ERROR", error.to_string()), json)
}

/// Runs a parsed command in `cwd` on `host`.
pub async fn run(host: &impl ToolHost, cli: Cli, cwd: &Path) -> Rendered {
    let json = cli.json;
    match execute(host, cli, cwd).await {
        Ok(outcome) => output::success(&outcome, json),
        Err(error) => output::failure(&error, json),
    }
}

async fn execute(host: &impl ToolHost, cli: Cli, cwd: &Path) -> Result<Outcome, CliError> {
    let selectors = Selectors {
        project: cli.project.as_deref(),
        space: cli.space.as_deref(),
        cwd,
    };
    match cli.command {
        Noun::Guide => guide(host).await,
        Noun::Doctor => Ok(doctor::run(host, selectors).await),
        Noun::Integration { verb } => integration::run(verb, &selectors),
        Noun::Git {
            verb: GitVerb::Access {
                verb: AccessVerb::Verify,
            },
        } => access::verify(host, selectors).await,
        noun => {
            let command = tools::command(noun, cwd)?.expect("CLI-owned commands are handled above");
            let target = if command.project_free {
                None
            } else {
                Some(selectors.resolve()?)
            };
            if let Some(target) = &target {
                target.open(host).await?;
            }
            tools::run(host, target.as_ref(), command).await
        }
    }
}

/// `svode guide`: the shared product guide plus the files-first rules.
async fn guide(host: &impl ToolHost) -> Result<Outcome, CliError> {
    let result = call_tool(host, None, "get_svode_guide", json!({})).await;
    let structured = result.structured_content.unwrap_or_default();
    let guide = structured["guide"].as_str().unwrap_or_default().to_string();
    Ok(Outcome {
        human: format!("{FILES_FIRST}\n{guide}\n"),
        envelope: tools::envelope(
            Default::default(),
            json!({ "guide": guide, "filesFirst": FILES_FIRST }),
        ),
        warnings: Vec::new(),
    })
}

fn grammar_failure(error: clap::Error, raw: &[OsString]) -> Rendered {
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        return Rendered {
            stdout: error.render().to_string(),
            stderr: String::new(),
            exit: 0,
        };
    }
    let json = raw.iter().skip(1).any(|arg| arg == "--json");
    let rendered = error.render().to_string();
    let message = rendered
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("invalid arguments")
        .trim_start_matches("error: ")
        .to_string();
    let failure = CliError::argument(message);
    Rendered {
        stdout: if json {
            format!("{}\n", failure.envelope())
        } else {
            String::new()
        },
        stderr: rendered,
        exit: failure.exit,
    }
}
