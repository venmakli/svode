mod error;
mod grammar;
mod output;
mod page;
mod target;

use clap::error::ErrorKind;
use clap::{CommandFactory, Parser};

use error::CliError;
use grammar::{Cli, Noun, PageVerb};
use target::Selectors;

fn main() {
    let raw = std::env::args_os().collect::<Vec<_>>();
    let cli = match Cli::try_parse_from(&raw) {
        Ok(cli) => cli,
        Err(error) => std::process::exit(grammar_failure(error, &raw)),
    };
    let json = cli.json;
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| CliError::operation("IO_ERROR", error.to_string()))
        .and_then(|runtime| runtime.block_on(run(cli)));
    std::process::exit(match result {
        Ok(outcome) => {
            output::success(&outcome, json);
            0
        }
        Err(error) => {
            output::failure(&error, json);
            error.exit
        }
    });
}

async fn run(cli: Cli) -> Result<output::Outcome, CliError> {
    match cli.command {
        Noun::Page {
            verb: PageVerb::Read(args),
        } => {
            let selectors = required_selectors(&cli.project, &cli.space, &["page", "read"])?;
            page::read(selectors, args).await
        }
    }
}

/// Slice 4.1 accepts only explicit Project and Space selectors.
fn required_selectors<'a>(
    project: &'a Option<String>,
    space: &'a Option<String>,
    command: &[&str],
) -> Result<Selectors<'a>, CliError> {
    let missing = match (project, space) {
        (None, None) => Some("--project and --space are required"),
        (None, Some(_)) => Some("--project is required"),
        (Some(_), None) => Some("--space is required"),
        (Some(_), Some(_)) => None,
    };
    if let Some(message) = missing {
        return Err(CliError::argument(message, Some(usage(command))));
    }
    Ok(Selectors {
        project: project.as_deref().unwrap_or_default(),
        space: space.as_deref().unwrap_or_default(),
    })
}

fn usage(command: &[&str]) -> String {
    let mut cmd = Cli::command();
    cmd.build();
    let mut current = &mut cmd;
    for name in command {
        current = current
            .find_subcommand_mut(name)
            .expect("command path exists in the grammar");
    }
    current.render_help().to_string()
}

/// Help and version go to stdout with exit 0; every other parse failure is
/// `INVALID_ARGUMENT` with exit 2 and usage on stderr.
fn grammar_failure(error: clap::Error, raw: &[std::ffi::OsString]) -> i32 {
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        let _ = error.print();
        return 0;
    }
    let json = raw.iter().skip(1).any(|arg| arg == "--json");
    let rendered = error.render().to_string();
    let message = rendered
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("invalid arguments")
        .trim_start_matches("error: ")
        .to_string();
    let failure = CliError::argument(message, None);
    if json {
        println!("{}", failure.envelope());
    }
    eprint!("{rendered}");
    failure.exit
}
