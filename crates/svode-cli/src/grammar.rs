//! Command grammar: `svode [global] <noun> <verb> [--flags]`.

use clap::{Args, Parser, Subcommand, ValueEnum};

const HEADLESS: &str = "Mode: not served yet by the Svode headless runtime of this build; it answers MODE_UNAVAILABLE and runs nothing.";
const INDEXED: &str = "Index: the index of the Space is checked against the files before the answer (built on first use). The result carries `index` (status fresh or partial); INDEX_UNAVAILABLE means no answer could be prepared from it.";

const WRITE: &str = "Safe cycle: read the current source, edit it, then write the whole result. Bodies come from --body-file <path> or --body-file - (stdin); --body <text> is for short inline text. A command reads stdin at most once. The write does not commit to Git. If it fails, the code and target say why: reread the source and apply the intent again; never delete or hand-repair .svode metadata.";

const STRUCTURAL: &str = "Structural change through the shared operation: it applies the required link, relation, order and index effects and reports every changed path. The target must be exact; there is no confirmation prompt and no --force. The change does not commit to Git. If it fails, the code and target say why: reread the structure and apply the intent again; never delete or hand-repair .svode metadata.";

fn write_help(example: &str) -> String {
    format!("{WRITE}\n\n{HEADLESS}\n\nExample:\n  {example}")
}

fn structural_help(example: &str) -> String {
    format!("{STRUCTURAL}\n\n{HEADLESS}\n\nExample:\n  {example}")
}

const ROUTINE_OWNER: &str = "Owner: the selected Space (--space, or the Space containing the current directory), or one of its Collections with --collection.";

const ROUTINE_WRITE: &str = "The definition is a complete JSON object (name, description, enabled, trigger, action, body) from --definition-file <path> or - for stdin; unknown fields are rejected and nothing is written. Saving a definition never starts the Routine and never enables automatic execution on this device; an enabled schedule or event Routine additionally needs --confirm-automatic-execution. The change does not commit to Git.";

const ROUTINE_CAS: &str = "Pass the routineId and the fingerprint of your last read. If the definition changed since, the command fails with ROUTINE_FINGERPRINT_CONFLICT and currentFingerprint: run `svode routine get` again and reapply the intent.";

fn routine_help(parts: &[&str], example: &str) -> String {
    let mut help = String::from(ROUTINE_OWNER);
    for part in parts {
        help.push_str("\n\n");
        help.push_str(part);
    }
    format!("{help}\n\n{HEADLESS}\n\nExample:\n  {example}")
}

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
    #[command(after_help = "Example:\n  svode --project ~/Notes project info --json")]
    Project {
        #[command(subcommand)]
        verb: ProjectVerb,
    },
    /// Spaces of the Project.
    #[command(
        after_help = "Examples:\n  svode --project ~/Notes space list\n  svode --project ~/Notes space readme read --space research"
    )]
    Space {
        #[command(subcommand)]
        verb: SpaceVerb,
    },
    /// Standalone Pages.
    #[command(
        after_help = "Examples:\n  svode --project ~/Notes page list --path notes\n  svode --project ~/Notes page read --path notes/today.md --json"
    )]
    Page {
        #[command(subcommand)]
        verb: PageVerb,
    },
    /// Collections: schema, items query and README.
    #[command(
        after_help = "Examples:\n  svode --project ~/Notes collection list\n  svode --project ~/Notes collection schema --collection tasks --json"
    )]
    Collection {
        #[command(subcommand)]
        verb: CollectionVerb,
    },
    /// Collection items.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes item read --path tasks/fix-login.md --json"
    )]
    Item {
        #[command(subcommand)]
        verb: ItemVerb,
    },
    /// Structure of Pages, folders and Collections: rename, move, reorder
    /// and convert.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes content move --path notes/Plan.md --to-parent archive"
    )]
    Content {
        #[command(subcommand)]
        verb: ContentVerb,
    },
    /// Actors from Git history.
    #[command(after_help = "Example:\n  svode --project ~/Notes actor list --json")]
    Actor {
        #[command(subcommand)]
        verb: ActorVerb,
    },
    /// Full-text search of Pages in the selected Space.
    #[command(after_help = format!("{INDEXED}\n\nExample:\n  svode search \"release notes\" --limit 10 --json"))]
    Search(SearchArgs),
    /// Knowledge projection: search, nodes, neighbors, context and status.
    #[command(
        after_help = "Examples:\n  svode --project ~/Notes knowledge search \"onboarding\" --json\n  svode --project ~/Notes knowledge status"
    )]
    Knowledge {
        #[command(subcommand)]
        verb: KnowledgeVerb,
    },
    /// Git state of the selected Space.
    #[command(after_help = "Example:\n  svode --project ~/Notes git status --json")]
    Git {
        #[command(subcommand)]
        verb: GitVerb,
    },
    /// Managed file assets next to Markdown content.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes asset import --path notes/today.md --file chart.png --json"
    )]
    Asset {
        #[command(subcommand)]
        verb: AssetVerb,
    },
    /// Svode Apps.
    #[command(after_help = "Example:\n  svode app validate --file apps/board/app.yaml --json")]
    App {
        #[command(subcommand)]
        verb: AppVerb,
    },
    /// Routine definitions of a Space or Collection owner.
    #[command(
        after_help = "Examples:\n  svode --project ~/Notes routine list --space root --json\n  svode --project ~/Notes routine get --collection tasks --id routine:01j9… --json"
    )]
    Routine {
        #[command(subcommand)]
        verb: RoutineVerb,
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
    #[command(
        after_help = "Example:\n  svode --project ~/Notes space readme read --space research"
    )]
    Readme {
        #[command(subcommand)]
        verb: SpaceReadmeVerb,
    },
    /// Metadata of the Space README.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes space meta set --space research --description \"Research notes\""
    )]
    Meta {
        #[command(subcommand)]
        verb: MetaVerb<NoSelector>,
    },
    /// Set the complete order of the child Spaces of the Project.
    #[command(after_help = structural_help("svode --project ~/Notes space reorder --id research --id archive"))]
    Reorder(SpaceReorderArgs),
}

#[derive(Debug, Args)]
pub struct SpaceReorderArgs {
    /// Child Space id in the new order; repeat for every child Space. The
    /// pinned root Space is not listed.
    #[arg(long = "id", value_name = "SPACE-ID", required = true)]
    pub ids: Vec<String>,
}

/// Only verb of a `meta` noun: set metadata fields.
#[derive(Debug, Subcommand)]
pub enum MetaVerb<S: Args> {
    /// Set, keep or clear title, icon, description and cover.
    #[command(after_help = write_help("svode page meta set --path notes/today.md --icon 📝 --clear-description\n  svode item meta set --path tasks/fix-login.md --title \"Fix sign-in\"\n  svode collection meta set --collection tasks --cover-file cover.json\n  svode space meta set --space research --description \"Research notes\""))]
    Set {
        #[command(flatten)]
        selector: S,
        #[command(flatten)]
        patch: MetadataPatch,
    },
}

/// Selector of a command addressed by the target alone.
#[derive(Debug, Args)]
pub struct NoSelector {}

/// Metadata patch: a missing flag keeps the field, `--clear-*` clears it,
/// a value writes it. `--title` renames by the shared naming rules.
#[derive(Debug, Args)]
pub struct MetadataPatch {
    /// New title; the source is renamed by the shared naming rules.
    #[arg(long)]
    pub title: Option<String>,
    /// New icon.
    #[arg(long)]
    pub icon: Option<String>,
    /// Clear the icon.
    #[arg(long, conflicts_with = "icon")]
    pub clear_icon: bool,
    /// New description.
    #[arg(long)]
    pub description: Option<String>,
    /// Clear the description.
    #[arg(long, conflicts_with = "description")]
    pub clear_description: bool,
    /// Cover as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub cover_file: Option<String>,
    /// Clear the cover.
    #[arg(long, conflicts_with = "cover_file")]
    pub clear_cover: bool,
}

/// Required body of a write.
#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
pub struct Body {
    /// Body from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub body_file: Option<String>,
    /// Short inline body.
    #[arg(long, value_name = "TEXT")]
    pub body: Option<String>,
}

/// Optional initial body.
#[derive(Debug, Args)]
#[group(multiple = false)]
pub struct OptionalBody {
    /// Body from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub body_file: Option<String>,
    /// Short inline body.
    #[arg(long, value_name = "TEXT")]
    pub body: Option<String>,
}

#[derive(Debug, Args)]
pub struct ReadmeWriteArgs {
    #[command(flatten)]
    pub body: Body,
    /// New title of the owner README.
    #[arg(long)]
    pub title: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum SpaceReadmeVerb {
    /// Read the README of the selected Space.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes space readme read --space research"
    )]
    Read,
    /// Replace the README body of the selected Space.
    #[command(after_help = write_help("svode --project ~/Notes space readme write --space research --body-file README.draft.md"))]
    Write(ReadmeWriteArgs),
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
    /// Create a Page, or a Collection item when the parent is a Collection.
    #[command(after_help = write_help("svode --project ~/Notes page create --parent notes --title \"Weekly review\" --body-file review.md --json"))]
    Create(PageCreateArgs),
    /// Replace the body of a standalone Page.
    #[command(after_help = write_help("svode page read --path notes/today.md > today.md && $EDITOR today.md && svode page write --path notes/today.md --body-file today.md"))]
    Write(PageWriteArgs),
    /// Metadata of a standalone Page.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes page meta set --path notes/today.md --icon 📝"
    )]
    Meta {
        #[command(subcommand)]
        verb: MetaVerb<PathSelector>,
    },
    /// Delete one standalone Page.
    #[command(after_help = structural_help("svode --project ~/Notes page delete --path notes/old.md"))]
    Delete(PathSelector),
}

#[derive(Debug, Args)]
pub struct PathSelector {
    /// Markdown source relative to the selected Space.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
}

#[derive(Debug, Args)]
pub struct PageCreateArgs {
    /// Containing directory relative to the selected Space; `""` for the
    /// Space root. A Collection directory creates an item with its defaults.
    #[arg(long, value_name = "DIR")]
    pub parent: String,
    /// Title; the filename follows the shared naming rules.
    #[arg(long)]
    pub title: String,
    #[command(flatten)]
    pub body: OptionalBody,
    /// Icon.
    #[arg(long)]
    pub icon: Option<String>,
    /// Description.
    #[arg(long)]
    pub description: Option<String>,
    /// Cover as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub cover_file: Option<String>,
    /// Initial Collection properties as a JSON object from a file, or `-`.
    #[arg(long, value_name = "PATH|-")]
    pub properties_file: Option<String>,
}

#[derive(Debug, Args)]
pub struct PageWriteArgs {
    /// Existing standalone Page source relative to the selected Space.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
    #[command(flatten)]
    pub body: Body,
    /// New title; the source is renamed by the shared naming rules.
    #[arg(long)]
    pub title: Option<String>,
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
    #[command(after_help = format!("Filter and sort are JSON arrays of the shared query shape, read from a file or stdin (`-`).\n\n{INDEXED}\n\nExample:\n  svode --project ~/Notes collection query --collection tasks --filter-file filter.json --limit 20 --json"))]
    Query(CollectionQueryArgs),
    /// The Collection README.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes collection readme read --collection tasks"
    )]
    Readme {
        #[command(subcommand)]
        verb: CollectionReadmeVerb,
    },
    /// Metadata of the Collection README.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes collection meta set --collection tasks --clear-description"
    )]
    Meta {
        #[command(subcommand)]
        verb: MetaVerb<CollectionSelector>,
    },
    /// Create a Collection: a directory with its README and schema.
    #[command(after_help = structural_help("svode --project ~/Notes collection create --parent \"\" --title Tasks --columns-file columns.json --json"))]
    Create(CollectionCreateArgs),
    /// Delete one Collection with its items.
    #[command(after_help = structural_help("svode --project ~/Notes collection delete --collection old-tasks"))]
    Delete(CollectionSelector),
    /// Read-only check of relation targets, item references and order.
    #[command(
        after_help = "Without --collection every Collection of the selected Space is checked. Run it after a deliberate raw structural edit and fix every reported issue.\n\nExample:\n  svode --project ~/Notes collection check --collection tasks --json"
    )]
    Check(CollectionCheckArgs),
    /// Schema columns of one Collection.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes collection column add --collection tasks --column-file column.json"
    )]
    Column {
        #[command(subcommand)]
        verb: ColumnVerb,
    },
    /// Views of one Collection.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes collection view add --collection tasks --view-file board.json"
    )]
    View {
        #[command(subcommand)]
        verb: ViewVerb,
    },
}

#[derive(Debug, Args)]
pub struct CollectionSelector {
    /// Collection directory relative to the selected Space.
    #[arg(long, value_name = "DIR")]
    pub collection: String,
}

#[derive(Debug, Args)]
pub struct CollectionCheckArgs {
    /// Collection directory relative to the selected Space; every
    /// Collection of the Space by default.
    #[arg(long, value_name = "DIR")]
    pub collection: Option<String>,
}

#[derive(Debug, Args)]
pub struct CollectionCreateArgs {
    /// Containing directory or Page relative to the selected Space; `""`
    /// for the Space root. A leaf parent Page becomes directory-backed.
    #[arg(long, value_name = "DIR")]
    pub parent: String,
    /// Title; the directory name follows the shared naming rules.
    #[arg(long)]
    pub title: String,
    #[command(flatten)]
    pub body: OptionalBody,
    /// Icon.
    #[arg(long)]
    pub icon: Option<String>,
    /// Description.
    #[arg(long)]
    pub description: Option<String>,
    /// Cover as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub cover_file: Option<String>,
    /// Initial schema columns as a JSON array from a file, or `-`.
    #[arg(long, value_name = "PATH|-")]
    pub columns_file: Option<String>,
    /// Initial views as a JSON array from a file, or `-`.
    #[arg(long, value_name = "PATH|-")]
    pub views_file: Option<String>,
}

/// Collection and the name of one of its columns or views.
#[derive(Debug, Args)]
pub struct NamedSelector {
    #[command(flatten)]
    pub collection: CollectionSelector,
    /// Name of the column or view.
    #[arg(long)]
    pub name: String,
}

#[derive(Debug, Subcommand)]
pub enum ColumnVerb {
    /// Add a schema column.
    #[command(after_help = structural_help("svode --project ~/Notes collection column add --collection tasks --column-file column.json"))]
    Add(ColumnAddArgs),
    /// Patch the settings of an existing column.
    #[command(after_help = structural_help("svode --project ~/Notes collection column update --collection tasks --name Status --patch-file patch.json"))]
    Update(PatchArgs),
    /// Delete a column; stored values stay unless --delete-values is set.
    #[command(after_help = structural_help("svode --project ~/Notes collection column delete --collection tasks --name Estimate --delete-values"))]
    Delete(ColumnDeleteArgs),
}

#[derive(Debug, Args)]
pub struct ColumnAddArgs {
    #[command(flatten)]
    pub collection: CollectionSelector,
    /// Column as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub column_file: String,
}

#[derive(Debug, Args)]
pub struct PatchArgs {
    #[command(flatten)]
    pub selector: NamedSelector,
    /// Patch as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub patch_file: String,
}

#[derive(Debug, Args)]
pub struct ColumnDeleteArgs {
    #[command(flatten)]
    pub selector: NamedSelector,
    /// Also remove the stored values from the Collection items.
    #[arg(long)]
    pub delete_values: bool,
}

#[derive(Debug, Subcommand)]
pub enum ViewVerb {
    /// Add a table, board, calendar, list or gallery view.
    #[command(after_help = structural_help("svode --project ~/Notes collection view add --collection tasks --view-file board.json --position 0"))]
    Add(ViewAddArgs),
    /// Patch an existing view.
    #[command(after_help = structural_help("svode --project ~/Notes collection view update --collection tasks --name Board --patch-file patch.json"))]
    Update(PatchArgs),
    /// Delete a view.
    #[command(after_help = structural_help("svode --project ~/Notes collection view delete --collection tasks --name Board"))]
    Delete(NamedSelector),
}

#[derive(Debug, Args)]
pub struct ViewAddArgs {
    #[command(flatten)]
    pub collection: CollectionSelector,
    /// View as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub view_file: String,
    /// Position among the views; the end by default.
    #[arg(long)]
    pub position: Option<u64>,
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
    /// Replace the README body of one Collection.
    #[command(after_help = write_help("svode --project ~/Notes collection readme write --collection tasks --body-file tasks.md"))]
    Write(CollectionReadmeWriteArgs),
}

#[derive(Debug, Args)]
pub struct CollectionReadmeWriteArgs {
    #[command(flatten)]
    pub collection: CollectionSelector,
    #[command(flatten)]
    pub readme: ReadmeWriteArgs,
}

#[derive(Debug, Subcommand)]
pub enum ItemVerb {
    /// Read one Collection item.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes item read --path tasks/fix-login.md --json"
    )]
    Read(ItemReadArgs),
    /// Replace the body of one Collection item.
    #[command(after_help = write_help("svode --project ~/Notes item write --path tasks/fix-login.md --body-file - < body.md"))]
    Write(ItemWriteArgs),
    /// Fields of one Collection item.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes item fields set --path tasks/fix-login.md --fields-file fields.json"
    )]
    Fields {
        #[command(subcommand)]
        verb: ItemFieldsVerb,
    },
    /// Metadata of one Collection item.
    #[command(
        after_help = "Example:\n  svode --project ~/Notes item meta set --path tasks/fix-login.md --title \"Fix sign-in\""
    )]
    Meta {
        #[command(subcommand)]
        verb: MetaVerb<PathSelector>,
    },
    /// Delete one Collection item.
    #[command(after_help = structural_help("svode --project ~/Notes item delete --path tasks/fix-login.md"))]
    Delete(PathSelector),
}

#[derive(Debug, Subcommand)]
pub enum ContentVerb {
    /// Rename a Page, folder or Collection within its parent.
    #[command(after_help = structural_help("svode --project ~/Notes content rename --path notes/draft.md --to notes/Plan.md"))]
    Rename(ContentRenameArgs),
    /// Move a Page, folder or Collection under another parent.
    #[command(after_help = structural_help("svode --project ~/Notes content move --path notes/Plan.md --to-parent archive"))]
    Move(ContentMoveArgs),
    /// Set the complete order of the direct children of one parent.
    #[command(after_help = structural_help("svode --project ~/Notes content reorder --parent archive --child archive/b.md --child archive/a.md"))]
    Reorder(ContentReorderArgs),
    /// Convert a directory-backed Page to a leaf Page, or a Page or folder
    /// to a Collection in place.
    #[command(after_help = structural_help("svode --project ~/Notes content convert --path notes/ideas.md --to collection"))]
    Convert(ContentConvertArgs),
}

#[derive(Debug, Args)]
pub struct ContentRenameArgs {
    /// Existing Page, folder or Collection relative to the selected Space.
    #[arg(long, value_name = "RELATIVE")]
    pub path: String,
    /// New path in the same parent.
    #[arg(long, value_name = "RELATIVE")]
    pub to: String,
}

#[derive(Debug, Args)]
pub struct ContentMoveArgs {
    /// Existing Page, folder or Collection relative to the selected Space.
    #[arg(long, value_name = "RELATIVE")]
    pub path: String,
    /// Destination parent directory; `""` for the Space root.
    #[arg(long, value_name = "DIR")]
    pub to_parent: String,
}

#[derive(Debug, Args)]
pub struct ContentReorderArgs {
    /// Parent directory; `""` for the Space root.
    #[arg(long, value_name = "DIR")]
    pub parent: String,
    /// Direct child path in the new order, as `page list` shows it; repeat
    /// for every child. Directory-backed Pages and Collections use their
    /// README.md path.
    #[arg(long = "child", value_name = "RELATIVE", required = true)]
    pub children: Vec<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ConvertTarget {
    /// Directory-backed Page at README.md into a leaf Page.
    Leaf,
    /// Leaf Page, directory-backed Page or folder into a Collection.
    Collection,
}

#[derive(Debug, Args)]
pub struct ContentConvertArgs {
    /// Page or folder relative to the selected Space.
    #[arg(long, value_name = "RELATIVE")]
    pub path: String,
    /// Shape to convert to.
    #[arg(long, value_enum)]
    pub to: ConvertTarget,
}

#[derive(Debug, Args)]
pub struct ItemWriteArgs {
    /// Markdown source of the item relative to the selected Space.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
    #[command(flatten)]
    pub body: Body,
}

#[derive(Debug, Subcommand)]
pub enum ItemFieldsVerb {
    /// Atomically set system and custom fields with schema validation.
    #[command(after_help = write_help("svode --project ~/Notes item fields set --path tasks/fix-login.md --fields-file fields.json"))]
    Set(ItemFieldsArgs),
}

#[derive(Debug, Args)]
pub struct ItemFieldsArgs {
    /// Markdown source of the item relative to the selected Space.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
    /// Fields as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub fields_file: String,
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
    #[command(after_help = "Example:\n  svode --project ~/Notes actor list --json")]
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
    #[command(after_help = format!("{INDEXED}\n\nExample:\n  svode knowledge search \"onboarding\" --kind page --limit 10 --json"))]
    Search(KnowledgeSearchArgs),
    /// One Knowledge node.
    #[command(after_help = format!("{INDEXED}\n\nExample:\n  svode knowledge node --id page:root:notes/today.md --json"))]
    Node(KnowledgeNodeArgs),
    /// Direct explicit neighbors of one Knowledge node.
    #[command(after_help = format!("{INDEXED}\n\nExample:\n  svode knowledge neighbors --id page:root:notes/today.md --edge-kind links_to --json"))]
    Neighbors(KnowledgeNeighborsArgs),
    /// Related context for a query within a text budget.
    #[command(after_help = format!("{INDEXED}\n\nExample:\n  svode knowledge context \"release plan\" --text-budget 2000 --json"))]
    Context(KnowledgeContextArgs),
    /// Freshness and counts of the Knowledge projection.
    #[command(after_help = format!("{INDEXED}\n\nExample:\n  svode knowledge status --scope project --json"))]
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
    #[command(after_help = "Example:\n  svode --project ~/Notes git status --json")]
    Status,
}

#[derive(Debug, Subcommand)]
pub enum AssetVerb {
    /// Copy one local file next to the Markdown content that owns it.
    #[command(after_help = format!("The source is copied, never moved, and stored by the asset routing of its Space (local, in Git or Git LFS); a Git LFS route that is not ready refuses the import before any write. A leaf Page becomes directory-backed first, so use the returned contentPath for the next command and insert markdownUrl (or pass coverPath as a cover) yourself: the import changes no body or cover. The import does not commit to Git.\n\n{HEADLESS}\n\nExample:\n  svode --project ~/Notes asset import --path notes/today.md --file ~/Pictures/chart.png --json"))]
    Import(AssetImportArgs),
}

#[derive(Debug, Args)]
pub struct AssetImportArgs {
    /// Existing Page, Collection item, Space README or Collection README
    /// relative to the selected Space.
    #[arg(long, value_name = "RELATIVE.md")]
    pub path: String,
    /// Local regular file to copy: absolute or relative to the current
    /// directory. Directories, symbolic links and stdin are not accepted.
    #[arg(long, value_name = "PATH")]
    pub file: String,
    /// File name of the copy; the source file name by default.
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum AppVerb {
    /// Validate a complete app.yaml candidate without a Project.
    #[command(
        after_help = "Read-only: uses the same safe parser as the Svode App host, writes nothing, launches no App and reads no Variable or Secret value. An invalid manifest is a result, not a failure: `valid` is false, `diagnostics` name each problem, and the exit status is 0. Validate the complete candidate before writing app.yaml and again after edits.\n\nExamples:\n  svode app validate --file apps/board/app.yaml --json\n  cat app.yaml | svode app validate --file -"
    )]
    Validate(AppValidateArgs),
}

#[derive(Debug, Args)]
pub struct AppValidateArgs {
    /// app.yaml candidate as UTF-8 text from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub file: String,
}

#[derive(Debug, Subcommand)]
pub enum RoutineVerb {
    /// Routine summaries of one owner, including invalid definitions.
    #[command(after_help = routine_help(&[], "svode --project ~/Notes routine list --space root --collection tasks --json"))]
    List(RoutineListArgs),
    /// One normalized Routine definition with its diagnostics and
    /// fingerprint.
    #[command(after_help = routine_help(&[], "svode --project ~/Notes routine get --collection tasks --id routine:01j9… --json"))]
    Get(RoutineGetArgs),
    /// Create one Routine in its owner under a canonical file name.
    #[command(after_help = routine_help(&[ROUTINE_WRITE], "svode --project ~/Notes routine create --collection tasks --definition-file review.json --json"))]
    Create(RoutineCreateArgs),
    /// Replace one Routine definition by fingerprint compare-and-set.
    #[command(after_help = routine_help(&[ROUTINE_WRITE, ROUTINE_CAS], "svode --project ~/Notes routine update --collection tasks --id routine:01j9… --fingerprint 3f2a… --definition-file review.json"))]
    Update(RoutineUpdateArgs),
    /// Delete one Routine definition by fingerprint compare-and-set; run
    /// history stays and an active run is not cancelled.
    #[command(after_help = routine_help(&[ROUTINE_CAS, "The change does not commit to Git."], "svode --project ~/Notes routine delete --collection tasks --id routine:01j9… --fingerprint 3f2a…"))]
    Delete(RoutineDeleteArgs),
}

/// Owner of a Routine command inside the selected Space.
#[derive(Debug, Args)]
pub struct RoutineOwner {
    /// Collection owner directory relative to the selected Space; the
    /// Space itself by default.
    #[arg(long, value_name = "DIR")]
    pub collection: Option<String>,
}

#[derive(Debug, Args)]
pub struct RoutineListArgs {
    #[command(flatten)]
    pub owner: RoutineOwner,
    #[command(flatten)]
    pub page: Pagination,
}

#[derive(Debug, Args)]
pub struct RoutineGetArgs {
    #[command(flatten)]
    pub owner: RoutineOwner,
    /// Routine id from `routine list`.
    #[arg(long, value_name = "ROUTINE-ID")]
    pub id: String,
}

#[derive(Debug, Args)]
pub struct RoutineCreateArgs {
    #[command(flatten)]
    pub owner: RoutineOwner,
    /// Complete definition as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub definition_file: String,
    /// Acknowledge that an enabled schedule or event Routine may run
    /// automatically once this device grants authority.
    #[arg(long)]
    pub confirm_automatic_execution: bool,
}

#[derive(Debug, Args)]
pub struct RoutineUpdateArgs {
    #[command(flatten)]
    pub owner: RoutineOwner,
    /// Routine id from `routine list`.
    #[arg(long, value_name = "ROUTINE-ID")]
    pub id: String,
    /// Fingerprint of the last read of this Routine.
    #[arg(long)]
    pub fingerprint: String,
    /// Complete definition as a JSON object from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-")]
    pub definition_file: String,
    /// Acknowledge that an enabled schedule or event Routine may run
    /// automatically once this device grants authority.
    #[arg(long)]
    pub confirm_automatic_execution: bool,
}

#[derive(Debug, Args)]
pub struct RoutineDeleteArgs {
    #[command(flatten)]
    pub owner: RoutineOwner,
    /// Routine id from `routine list`.
    #[arg(long, value_name = "ROUTINE-ID")]
    pub id: String,
    /// Fingerprint of the last read of this Routine.
    #[arg(long)]
    pub fingerprint: String,
}
