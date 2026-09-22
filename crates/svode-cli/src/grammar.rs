//! Command grammar: `svode [global] <noun> <verb> [--flags]`.

use clap::{Args, Parser, Subcommand, ValueEnum};

const HEADLESS: &str = "Mode: needs the Svode headless runtime; until it is connected this build answers MODE_UNAVAILABLE and runs nothing.";

#[derive(Debug, Parser)]
#[command(
    name = "svode",
    version,
    about = "Read and change Svode project data without the desktop app.",
    after_help = "Without --project the nearest Svode project containing the current directory is used; without --space the most specific ready child Space containing it, otherwise root.\n\nExamples:\n  svode --project ~/Notes page read --space root --path notes/today.md --json\n  cd ~/Notes && svode page list"
)]
pub struct Cli {
    /// Project directory: absolute or relative to the current directory.
    /// Defaults to the nearest Svode project containing the current directory.
    #[arg(long, global = true, value_name = "PATH")]
    pub project: Option<String>,
    /// Space inside the Project: `root` or a registered child Space id.
    /// Defaults to the ready child Space containing the current directory,
    /// otherwise `root`.
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
    /// The Project and its Spaces.
    Project {
        #[command(subcommand)]
        verb: ProjectVerb,
    },
    /// Spaces of the Project.
    Space {
        #[command(subcommand)]
        verb: SpaceVerb,
    },
    /// Standalone Pages.
    Page {
        #[command(subcommand)]
        verb: PageVerb,
    },
    /// Collections: schema, items query and README.
    Collection {
        #[command(subcommand)]
        verb: CollectionVerb,
    },
    /// Collection items.
    Item {
        #[command(subcommand)]
        verb: ItemVerb,
    },
    /// Actors from Git history.
    Actor {
        #[command(subcommand)]
        verb: ActorVerb,
    },
    /// Full-text search of Pages in the selected Space.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode search \"release notes\" --limit 10 --json"))]
    Search(SearchArgs),
    /// Knowledge projection: search, nodes, neighbors, context and status.
    Knowledge {
        #[command(subcommand)]
        verb: KnowledgeVerb,
    },
    /// Git state of the selected Space.
    Git {
        #[command(subcommand)]
        verb: GitVerb,
    },
    /// Product guidance and files-first rules for agents and scripts.
    #[command(after_help = "Example:\n  svode guide")]
    Guide,
    /// Read-only diagnostics of the Project, Spaces, Git and runtime.
    #[command(
        after_help = "Opens no index or store. Target problems are reported in the result.\n\nExample:\n  svode doctor --project ~/Notes --json"
    )]
    Doctor,
}

#[derive(Debug, Subcommand)]
pub enum ProjectVerb {
    /// Project name, Spaces and addressing.
    #[command(after_help = "Example:\n  svode --project ~/Notes project info --json")]
    Info,
}

#[derive(Debug, Subcommand)]
pub enum SpaceVerb {
    /// Root and child Spaces with their status.
    #[command(after_help = "Example:\n  svode --project ~/Notes space list")]
    List,
    /// The Space README.
    Readme {
        #[command(subcommand)]
        verb: SpaceReadmeVerb,
    },
}

#[derive(Debug, Subcommand)]
pub enum SpaceReadmeVerb {
    /// Read the README of the selected Space.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes space readme read --space research"
    )]
    Read,
}

#[derive(Debug, Subcommand)]
pub enum PageVerb {
    /// Read one standalone Page from its Markdown source.
    #[command(
        after_help = "Examples:\n  svode --project ~/Notes page read --space root --path notes/today.md\n  \
svode --project ~/Notes page read --space research --path ideas/README.md --json"
    )]
    Read(PageReadArgs),
    /// List the Page tree of the selected Space.
    #[command(after_help = "Example:\n  svode --project ~/Notes page list --path notes --limit 20")]
    List(PageListArgs),
}

#[derive(Debug, Args)]
pub struct PageReadArgs {
    /// Markdown source relative to the selected Space, e.g. `notes/today.md`
    /// or `folder/README.md` for a directory-backed Page.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
}

#[derive(Debug, Args)]
pub struct PageListArgs {
    /// Directory inside the Space to list; the whole tree by default.
    #[arg(long, value_name = "DIR")]
    pub path: Option<String>,
    #[command(flatten)]
    pub page: Pagination,
}

#[derive(Debug, Args)]
pub struct Pagination {
    /// Maximum number of entries (default 50, max 200).
    #[arg(long, allow_negative_numbers = true)]
    pub limit: Option<i64>,
    /// Number of entries to skip.
    #[arg(long, allow_negative_numbers = true)]
    pub offset: Option<i64>,
}

#[derive(Debug, Subcommand)]
pub enum CollectionVerb {
    /// Collections of the selected Space.
    #[command(after_help = "Example:\n  svode --project ~/Notes collection list")]
    List,
    /// Schema of one Collection.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes collection schema --collection tasks --json"
    )]
    Schema(CollectionSelector),
    /// Query Collection items with optional filter and sort.
    #[command(after_help = format!("Filter and sort are JSON arrays of the shared query shape, read from a file or stdin (`-`).\n\n{HEADLESS}\n\nExample:\n  svode --project ~/Notes collection query --collection tasks --filter-file filter.json --limit 20 --json"))]
    Query(CollectionQueryArgs),
    /// The Collection README.
    Readme {
        #[command(subcommand)]
        verb: CollectionReadmeVerb,
    },
}

#[derive(Debug, Args)]
pub struct CollectionSelector {
    /// Collection directory relative to the selected Space.
    #[arg(long, value_name = "DIR")]
    pub collection: String,
}

#[derive(Debug, Args)]
pub struct CollectionQueryArgs {
    #[command(flatten)]
    pub collection: CollectionSelector,
    /// JSON filter array from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub filter_file: Option<String>,
    /// JSON sort array from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub sort_file: Option<String>,
    #[command(flatten)]
    pub page: Pagination,
}

#[derive(Debug, Subcommand)]
pub enum CollectionReadmeVerb {
    /// Read the README of one Collection.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes collection readme read --collection tasks"
    )]
    Read(CollectionSelector),
}

#[derive(Debug, Subcommand)]
pub enum ItemVerb {
    /// Read one Collection item.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes item read --path tasks/fix-login.md --json"
    )]
    Read(ItemReadArgs),
}

#[derive(Debug, Args)]
pub struct ItemReadArgs {
    /// Markdown source of the item relative to the selected Space.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
}

#[derive(Debug, Subcommand)]
pub enum ActorVerb {
    /// Actor candidates for actor fields.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode --project ~/Notes actor list --json"))]
    List(ActorListArgs),
}

#[derive(Debug, Args)]
pub struct ActorListArgs {
    /// Scan all Git history instead of the recent catalog window.
    #[arg(long)]
    pub all_time: bool,
}

#[derive(Debug, Args)]
pub struct SearchArgs {
    /// Search query.
    pub query: String,
    #[command(flatten)]
    pub page: Pagination,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum KnowledgeScope {
    Space,
    Project,
}

impl KnowledgeScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Space => "space",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum KnowledgeVerb {
    /// Search the Knowledge projection.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode knowledge search \"onboarding\" --kind page --limit 10 --json"))]
    Search(KnowledgeSearchArgs),
    /// One Knowledge node.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode knowledge node --id page:root:notes/today.md --json"))]
    Node(KnowledgeNodeArgs),
    /// Direct explicit neighbors of one Knowledge node.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode knowledge neighbors --id page:root:notes/today.md --edge-kind links_to --json"))]
    Neighbors(KnowledgeNeighborsArgs),
    /// Related context for a query within a text budget.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode knowledge context \"release plan\" --text-budget 2000 --json"))]
    Context(KnowledgeContextArgs),
    /// Freshness and counts of the Knowledge projection.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode knowledge status --scope project --json"))]
    Status(KnowledgeStatusArgs),
}

#[derive(Debug, Args)]
pub struct KnowledgeSearchArgs {
    /// Search query.
    pub query: String,
    /// Space (default) or the whole Project.
    #[arg(long, value_enum)]
    pub scope: Option<KnowledgeScope>,
    /// Node kind to include; repeat for several.
    #[arg(long = "kind", value_name = "KIND")]
    pub kinds: Vec<String>,
    /// Maximum number of results (default 20, max 50).
    #[arg(long)]
    pub limit: Option<u64>,
}

#[derive(Debug, Args)]
pub struct KnowledgeNodeArgs {
    /// Knowledge node id.
    #[arg(long, value_name = "NODE-ID")]
    pub id: String,
    /// Space (default) or the whole Project.
    #[arg(long, value_enum)]
    pub scope: Option<KnowledgeScope>,
}

#[derive(Debug, Args)]
pub struct KnowledgeNeighborsArgs {
    /// Knowledge node id.
    #[arg(long, value_name = "NODE-ID")]
    pub id: String,
    /// Space (default) or the whole Project.
    #[arg(long, value_enum)]
    pub scope: Option<KnowledgeScope>,
    /// Edge kind to include; repeat for several.
    #[arg(long = "edge-kind", value_name = "KIND")]
    pub edge_kinds: Vec<String>,
    /// Maximum number of neighbors (default 20, max 100).
    #[arg(long)]
    pub limit: Option<u64>,
}

#[derive(Debug, Args)]
pub struct KnowledgeContextArgs {
    /// Query to collect context for.
    pub query: String,
    /// Space (default) or the whole Project.
    #[arg(long, value_enum)]
    pub scope: Option<KnowledgeScope>,
    /// Maximum number of context nodes (default 8, max 20).
    #[arg(long)]
    pub limit: Option<u64>,
    /// Text budget in characters (default 4000, max 16000).
    #[arg(long)]
    pub text_budget: Option<u64>,
    /// Node kind to include; repeat for several.
    #[arg(long = "kind", value_name = "KIND")]
    pub kinds: Vec<String>,
}

#[derive(Debug, Args)]
pub struct KnowledgeStatusArgs {
    /// Space (default) or the whole Project.
    #[arg(long, value_enum)]
    pub scope: Option<KnowledgeScope>,
}

#[derive(Debug, Subcommand)]
pub enum GitVerb {
    /// Read-only Git status of the selected Space.
    #[command(after_help = format!("{HEADLESS}\n\nExample:\n  svode --project ~/Notes git status --json"))]
    Status,
}
