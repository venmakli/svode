//! Command grammar: `svode [global] <noun> <verb> [--flags]`.

use clap::{Args, Parser, Subcommand};

pub const ROOT_SPACE_ID: &str = "root";

#[derive(Debug, Parser)]
#[command(
    name = "svode",
    version,
    about = "Read and change Svode project data without the desktop app.",
    after_help = "Example:\n  svode --project ~/Notes page read --space root --path notes/today.md --json"
)]
pub struct Cli {
    /// Project directory: absolute or relative to the current directory.
    #[arg(long, global = true, value_name = "PATH")]
    pub project: Option<String>,
    /// Space inside the Project: `root` or a registered child Space id.
    #[arg(long, global = true, value_name = "root|SPACE-ID")]
    pub space: Option<String>,
    /// Print exactly one JSON object on stdout.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Noun,
}

#[derive(Debug, Subcommand)]
pub enum Noun {
    /// Standalone Pages.
    Page {
        #[command(subcommand)]
        verb: PageVerb,
    },
}

#[derive(Debug, Subcommand)]
pub enum PageVerb {
    /// Read one standalone Page from its Markdown source.
    #[command(
        after_help = "Selectors --project, --space and --path are required.\n\n\
Examples:\n  svode --project ~/Notes page read --space root --path notes/today.md\n  \
svode --project ~/Notes page read --space research --path ideas/README.md --json"
    )]
    Read(PageReadArgs),
}

#[derive(Debug, Args)]
pub struct PageReadArgs {
    /// Markdown source relative to the selected Space, e.g. `notes/today.md`
    /// or `folder/README.md` for a directory-backed Page.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
}
