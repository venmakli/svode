//! Commands mapped onto catalog tools of the shared surface: one command per
//! capability, flags derived from the tool arguments, the structured result
//! of the operation as the envelope payload.

use std::path::Path;

use serde_json::{Map, Value, json};
use svode_tools::catalog;
use svode_tools::dispatch::call_tool;
use svode_tools::host::ToolHost;

use crate::error::CliError;
use crate::grammar::{
    ActorVerb, AppVerb, AssetVerb, CollectionReadmeVerb, CollectionVerb, ColumnVerb, ContentVerb,
    ConvertTarget, GitVerb, ItemFieldsVerb, ItemVerb, KnowledgeScope, KnowledgeVerb, MetaVerb,
    MetadataPatch, NamedSelector, Noun, Pagination, ProjectVerb, SpaceReadmeVerb, SpaceVerb,
    ViewVerb,
};
use crate::host::mode_unavailable;
use crate::input;
use crate::output::Outcome;
use crate::render;
use crate::target::Target;

const RUNTIME_HINT: &str = "run `svode doctor` to see what this build can serve";

/// One command bound to its catalog tool.
pub struct ToolCommand {
    /// Public command name, e.g. `collection query`.
    pub name: &'static str,
    pub tool: &'static str,
    /// Tool arguments except `spaceId`, which comes from the target.
    pub args: Map<String, Value>,
    /// Command-specific selectors echoed in the envelope target.
    pub selectors: Map<String, Value>,
    pub render: fn(&Value) -> String,
    /// Whether the tool addresses a Space; a Project-level tool gets no
    /// `spaceId`.
    pub space_scoped: bool,
    /// Whether the tool runs without a Project, so no target is resolved.
    pub project_free: bool,
}

impl ToolCommand {
    fn new(name: &'static str, tool: &'static str, render: fn(&Value) -> String) -> Self {
        Self {
            name,
            tool,
            args: Map::new(),
            selectors: Map::new(),
            render,
            space_scoped: true,
            project_free: false,
        }
    }

    fn project_scoped(mut self) -> Self {
        self.space_scoped = false;
        self
    }

    fn project_free(mut self) -> Self {
        self.project_free = true;
        self
    }

    /// Collection and column/view name of a schema command.
    fn named(self, selector: NamedSelector, key: &str) -> Self {
        self.selector(
            "collectionPath",
            "collection",
            selector.collection.collection,
        )
        .selector(key, "name", selector.name)
    }

    fn arg(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.args.insert(key.into(), value.into());
        self
    }

    fn optional(self, key: &str, value: Option<impl Into<Value>>) -> Self {
        match value {
            Some(value) => self.arg(key, value),
            None => self,
        }
    }

    fn list(self, key: &str, values: Vec<String>) -> Self {
        if values.is_empty() {
            self
        } else {
            self.arg(key, values)
        }
    }

    fn scope(self, scope: Option<KnowledgeScope>) -> Self {
        self.optional("scope", scope.map(KnowledgeScope::as_str))
    }

    fn page(self, page: Pagination) -> Self {
        self.optional("limit", page.limit)
            .optional("offset", page.offset)
    }

    /// Metadata patch with the shared missing/null/value semantics:
    /// `--clear-*` sends `null`, a missing flag sends nothing.
    fn patch(self, cwd: &Path, patch: MetadataPatch) -> Result<Self, CliError> {
        let cover = json_input(cwd, "cover-file", patch.cover_file.as_deref())?;
        Ok(self
            .optional("title", patch.title)
            .field("icon", patch.icon, patch.clear_icon)
            .field("description", patch.description, patch.clear_description)
            .field("cover", cover, patch.clear_cover))
    }

    fn field(self, key: &str, value: Option<impl Into<Value>>, clear: bool) -> Self {
        if clear {
            self.arg(key, Value::Null)
        } else {
            self.optional(key, value)
        }
    }

    /// Argument that also selects the target, like `path` or `collection`.
    fn selector(mut self, key: &str, public: &str, value: impl Into<Value>) -> Self {
        let value = value.into();
        self.selectors.insert(public.into(), value.clone());
        self.arg(key, value)
    }
}

/// Body of a write from `--body-file <path|->` or inline `--body`.
fn body(
    cwd: &Path,
    file: Option<&str>,
    inline: Option<String>,
) -> Result<Option<String>, CliError> {
    match file {
        Some(source) => input::text(cwd, "body-file", source).map(Some),
        None => Ok(inline),
    }
}

fn json_input(cwd: &Path, flag: &str, source: Option<&str>) -> Result<Option<Value>, CliError> {
    source
        .map(|source| input::json(cwd, flag, source))
        .transpose()
}

/// Maps a data command to its tool; `None` for commands the CLI owns.
pub fn command(noun: Noun, cwd: &Path) -> Result<Option<ToolCommand>, CliError> {
    use crate::grammar::PageVerb;
    Ok(Some(match noun {
        Noun::Project {
            verb: ProjectVerb::Info,
        } => ToolCommand::new("project info", "get_project_info", render::project),
        Noun::Space {
            verb: SpaceVerb::List,
        } => ToolCommand::new("space list", "list_spaces", render::spaces),
        Noun::Space {
            verb: SpaceVerb::Readme {
                verb: SpaceReadmeVerb::Read,
            },
        } => ToolCommand::new("space readme read", "read_space_readme", |value| {
            render::source(&value["spaceReadme"])
        }),
        Noun::Space {
            verb:
                SpaceVerb::Readme {
                    verb: SpaceReadmeVerb::Write(args),
                },
        } => ToolCommand::new("space readme write", "write_space_readme", render::changes)
            .optional(
                "content",
                body(cwd, args.body.body_file.as_deref(), args.body.body)?,
            )
            .optional("title", args.title),
        Noun::Space {
            verb: SpaceVerb::Meta {
                verb: MetaVerb::Set { patch, .. },
            },
        } => ToolCommand::new("space meta set", "update_space_metadata", render::changes)
            .patch(cwd, patch)?,
        Noun::Space {
            verb: SpaceVerb::Reorder(args),
        } => ToolCommand::new("space reorder", "reorder_spaces", render::changes)
            .arg("orderedSpaceIds", args.ids)
            .project_scoped(),
        Noun::Page {
            verb: PageVerb::List(args),
        } => ToolCommand::new("page list", "list_pages", render::tree)
            .optional("path", args.path.clone())
            .page(args.page),
        Noun::Page {
            verb: PageVerb::Create(args),
        } => {
            input::one_stdin(&[
                ("body-file", args.body.body_file.as_deref()),
                ("cover-file", args.cover_file.as_deref()),
                ("properties-file", args.properties_file.as_deref()),
            ])?;
            ToolCommand::new("page create", "create_page", render::changes)
                .selector("parentPath", "parent", args.parent)
                .arg("title", args.title)
                .optional(
                    "content",
                    body(cwd, args.body.body_file.as_deref(), args.body.body)?,
                )
                .optional("icon", args.icon)
                .optional("description", args.description)
                .optional(
                    "cover",
                    json_input(cwd, "cover-file", args.cover_file.as_deref())?,
                )
                .optional(
                    "properties",
                    json_input(cwd, "properties-file", args.properties_file.as_deref())?,
                )
        }
        Noun::Page {
            verb: PageVerb::Write(args),
        } => ToolCommand::new("page write", "write_page", render::changes)
            .selector("path", "path", args.path)
            .optional(
                "content",
                body(cwd, args.body.body_file.as_deref(), args.body.body)?,
            )
            .optional("title", args.title),
        Noun::Page {
            verb:
                PageVerb::Meta {
                    verb: MetaVerb::Set { selector, patch },
                },
        } => ToolCommand::new("page meta set", "update_page_metadata", render::changes)
            .selector("path", "path", selector.path)
            .patch(cwd, patch)?,
        Noun::Page {
            verb: PageVerb::Delete(selector),
        } => ToolCommand::new("page delete", "delete_page", render::changes).selector(
            "path",
            "path",
            selector.path,
        ),
        Noun::Collection { verb } => match verb {
            CollectionVerb::List => {
                ToolCommand::new("collection list", "list_collections", |value| {
                    render::rows(&value["collections"])
                })
            }
            CollectionVerb::Schema(args) => {
                ToolCommand::new("collection schema", "get_collection_schema", |value| {
                    render::pretty(&value["schema"])
                })
                .selector("collectionPath", "collection", args.collection)
            }
            CollectionVerb::Query(args) => {
                input::one_stdin(&[
                    ("filter-file", args.filter_file.as_deref()),
                    ("sort-file", args.sort_file.as_deref()),
                ])?;
                let filter = args
                    .filter_file
                    .as_deref()
                    .map(|source| input::json(cwd, "filter-file", source))
                    .transpose()?;
                let sort = args
                    .sort_file
                    .as_deref()
                    .map(|source| input::json(cwd, "sort-file", source))
                    .transpose()?;
                ToolCommand::new("collection query", "query_collection_items", |value| {
                    render::rows(&value["items"])
                })
                .selector("collectionPath", "collection", args.collection.collection)
                .optional("filter", filter)
                .optional("sort", sort)
                .page(args.page)
            }
            CollectionVerb::Readme {
                verb: CollectionReadmeVerb::Read(args),
            } => ToolCommand::new(
                "collection readme read",
                "read_collection_readme",
                |value| render::source(&value["collectionReadme"]),
            )
            .selector("collectionPath", "collection", args.collection),
            CollectionVerb::Readme {
                verb: CollectionReadmeVerb::Write(args),
            } => ToolCommand::new(
                "collection readme write",
                "write_collection_readme",
                render::changes,
            )
            .selector("collectionPath", "collection", args.collection.collection)
            .optional(
                "content",
                body(
                    cwd,
                    args.readme.body.body_file.as_deref(),
                    args.readme.body.body,
                )?,
            )
            .optional("title", args.readme.title),
            CollectionVerb::Meta {
                verb: MetaVerb::Set { selector, patch },
            } => ToolCommand::new(
                "collection meta set",
                "update_collection_metadata",
                render::changes,
            )
            .selector("collectionPath", "collection", selector.collection)
            .patch(cwd, patch)?,
            CollectionVerb::Create(args) => {
                input::one_stdin(&[
                    ("body-file", args.body.body_file.as_deref()),
                    ("cover-file", args.cover_file.as_deref()),
                    ("columns-file", args.columns_file.as_deref()),
                    ("views-file", args.views_file.as_deref()),
                ])?;
                ToolCommand::new("collection create", "create_collection", render::changes)
                    .selector("parentPath", "parent", args.parent)
                    .arg("title", args.title)
                    .optional(
                        "body",
                        body(cwd, args.body.body_file.as_deref(), args.body.body)?,
                    )
                    .optional("icon", args.icon)
                    .optional("description", args.description)
                    .optional(
                        "cover",
                        json_input(cwd, "cover-file", args.cover_file.as_deref())?,
                    )
                    .optional(
                        "columns",
                        json_input(cwd, "columns-file", args.columns_file.as_deref())?,
                    )
                    .optional(
                        "views",
                        json_input(cwd, "views-file", args.views_file.as_deref())?,
                    )
            }
            CollectionVerb::Delete(args) => {
                ToolCommand::new("collection delete", "delete_collection", render::changes)
                    .selector("collectionPath", "collection", args.collection)
            }
            CollectionVerb::Check(args) => {
                let command = ToolCommand::new(
                    "collection check",
                    "validate_collection_integrity",
                    render::integrity,
                );
                match args.collection {
                    Some(collection) => {
                        command.selector("collectionPath", "collection", collection)
                    }
                    None => command,
                }
            }
            CollectionVerb::Column { verb } => match verb {
                ColumnVerb::Add(args) => ToolCommand::new(
                    "collection column add",
                    "add_collection_column",
                    render::changes,
                )
                .selector("collectionPath", "collection", args.collection.collection)
                .arg(
                    "column",
                    input::json(cwd, "column-file", &args.column_file)?,
                ),
                ColumnVerb::Update(args) => ToolCommand::new(
                    "collection column update",
                    "update_collection_column",
                    render::changes,
                )
                .named(args.selector, "columnName")
                .arg("patch", input::json(cwd, "patch-file", &args.patch_file)?),
                ColumnVerb::Delete(args) => ToolCommand::new(
                    "collection column delete",
                    "delete_collection_column",
                    render::changes,
                )
                .named(args.selector, "columnName")
                .optional("deleteValues", args.delete_values.then_some(true)),
            },
            CollectionVerb::View { verb } => match verb {
                ViewVerb::Add(args) => ToolCommand::new(
                    "collection view add",
                    "add_collection_view",
                    render::changes,
                )
                .selector("collectionPath", "collection", args.collection.collection)
                .arg("view", input::json(cwd, "view-file", &args.view_file)?)
                .optional("position", args.position),
                ViewVerb::Update(args) => ToolCommand::new(
                    "collection view update",
                    "update_collection_view",
                    render::changes,
                )
                .named(args.selector, "viewName")
                .arg("patch", input::json(cwd, "patch-file", &args.patch_file)?),
                ViewVerb::Delete(selector) => ToolCommand::new(
                    "collection view delete",
                    "delete_collection_view",
                    render::changes,
                )
                .named(selector, "viewName"),
            },
        },
        Noun::Item { verb } => {
            match verb {
                ItemVerb::Read(args) => {
                    ToolCommand::new("item read", "read_collection_item", |value| {
                        render::source(&value["item"])
                    })
                    .selector("path", "path", args.path)
                }
                ItemVerb::Write(args) => {
                    ToolCommand::new("item write", "update_collection_item_body", render::changes)
                        .selector("path", "path", args.path)
                        .optional(
                            "body",
                            body(cwd, args.body.body_file.as_deref(), args.body.body)?,
                        )
                }
                ItemVerb::Fields {
                    verb: ItemFieldsVerb::Set(args),
                } => ToolCommand::new(
                    "item fields set",
                    "update_collection_item_fields",
                    render::changes,
                )
                .selector("path", "path", args.path)
                .arg(
                    "fields",
                    input::json(cwd, "fields-file", &args.fields_file)?,
                ),
                ItemVerb::Meta {
                    verb: MetaVerb::Set { selector, patch },
                } => ToolCommand::new(
                    "item meta set",
                    "update_collection_item_metadata",
                    render::changes,
                )
                .selector("path", "path", selector.path)
                .patch(cwd, patch)?,
                ItemVerb::Delete(selector) => {
                    ToolCommand::new("item delete", "delete_collection_item", render::changes)
                        .selector("path", "path", selector.path)
                }
            }
        }
        Noun::Content { verb } => match verb {
            ContentVerb::Rename(args) => {
                ToolCommand::new("content rename", "rename_content", render::changes)
                    .selector("from", "path", args.path)
                    .arg("to", args.to)
            }
            ContentVerb::Move(args) => {
                ToolCommand::new("content move", "move_content", render::changes)
                    .selector("from", "path", args.path)
                    .arg("toParent", args.to_parent)
            }
            ContentVerb::Reorder(args) => {
                ToolCommand::new("content reorder", "reorder_content", render::changes)
                    .selector("parentPath", "parent", args.parent)
                    .arg("orderedChildren", args.children)
            }
            ContentVerb::Convert(args) => {
                let tool = match args.to {
                    ConvertTarget::Leaf => "convert_page_to_leaf",
                    ConvertTarget::Collection => "convert_to_collection",
                };
                ToolCommand::new("content convert", tool, render::changes)
                    .selector("path", "path", args.path)
            }
        },
        Noun::Actor {
            verb: ActorVerb::List(args),
        } => ToolCommand::new("actor list", "list_actors", render::actors)
            .optional("allTime", args.all_time.then_some(true)),
        Noun::Search(args) => ToolCommand::new("search", "search_pages", |value| {
            render::rows(&value["items"])
        })
        .arg("query", args.query)
        .page(args.page),
        Noun::Knowledge { verb } => match verb {
            KnowledgeVerb::Search(args) => {
                ToolCommand::new("knowledge search", "search_knowledge", render::pretty)
                    .arg("query", args.query)
                    .scope(args.scope)
                    .list("nodeKinds", args.kinds)
                    .optional("limit", args.limit)
            }
            KnowledgeVerb::Node(args) => {
                ToolCommand::new("knowledge node", "get_knowledge_node", render::pretty)
                    .selector("nodeId", "id", args.id)
                    .scope(args.scope)
            }
            KnowledgeVerb::Neighbors(args) => ToolCommand::new(
                "knowledge neighbors",
                "get_knowledge_neighbors",
                render::pretty,
            )
            .selector("nodeId", "id", args.id)
            .scope(args.scope)
            .list("edgeKinds", args.edge_kinds)
            .optional("limit", args.limit),
            KnowledgeVerb::Context(args) => {
                ToolCommand::new("knowledge context", "get_related_context", render::pretty)
                    .arg("query", args.query)
                    .scope(args.scope)
                    .optional("limit", args.limit)
                    .optional("textBudget", args.text_budget)
                    .list("nodeKinds", args.kinds)
            }
            KnowledgeVerb::Status(args) => {
                ToolCommand::new("knowledge status", "get_knowledge_status", render::pretty)
                    .scope(args.scope)
            }
        },
        Noun::Git {
            verb: GitVerb::Status,
        } => ToolCommand::new("git status", "get_git_status", |value| {
            render::pretty(&value["status"])
        }),
        Noun::Asset {
            verb: AssetVerb::Import(args),
        } => ToolCommand::new("asset import", "import_asset", render::import)
            .selector("contentPath", "path", args.path)
            // The shared operation takes an absolute source path; a relative
            // one is the caller's current directory.
            .arg(
                "sourcePath",
                cwd.join(&args.file).to_string_lossy().to_string(),
            )
            .optional("fileName", args.name),
        Noun::App {
            verb: AppVerb::Validate(args),
        } => ToolCommand::new("app validate", "validate_app_manifest", render::manifest)
            .arg("yaml", input::text(cwd, "file", &args.file)?)
            .project_free(),
        Noun::Page {
            verb: PageVerb::Read(_),
        }
        | Noun::Guide
        | Noun::Doctor => return Ok(None),
    }))
}

/// Runs one tool command in the resolved target, or without one for a
/// Project-free command. A tool the host does not serve fails with
/// `MODE_UNAVAILABLE` before any effect.
pub async fn run(
    host: &impl ToolHost,
    target: Option<&Target>,
    command: ToolCommand,
) -> Result<Outcome, CliError> {
    let mut known = target.map(Target::envelope).unwrap_or_default();
    known.extend(command.selectors);
    if !host.serves_tool(command.tool) {
        let error = mode_unavailable(&format!("`svode {}`", command.name));
        return Err(CliError::operation(error.code, error.message)
            .with_target(known)
            .with_hint(RUNTIME_HINT));
    }
    let mut args = command.args;
    if let Some(target) = target.filter(|target| target.explicit_space && command.space_scoped) {
        args.insert("spaceId".into(), json!(target.space_id()));
    }
    let request = target.map(Target::request);
    let result = call_tool(host, request.as_ref(), command.tool, Value::Object(args)).await;
    let summary = result
        .content
        .first()
        .map(|block| block.text.clone())
        .unwrap_or_default();
    let structured = result.structured_content.unwrap_or_else(|| json!({}));
    if result.is_error {
        return Err(business_error(structured).with_target(known));
    }
    let mut human = (command.render)(&structured);
    let mut warnings = Vec::new();
    // A mutation prints its summary before the changed paths; warnings of
    // an applied outcome go to stderr and keep exit 0.
    if catalog::is_mutating_tool(command.tool) == Some(true) {
        human = format!("{summary}\n{human}");
        warnings = render::warnings(&structured["warnings"]);
    }
    Ok(Outcome {
        envelope: envelope(known, structured),
        human,
        warnings,
    })
}

/// Success envelope around the structured result of a shared operation.
pub fn envelope(target: Map<String, Value>, structured: Value) -> Value {
    let mut envelope = Map::new();
    envelope.insert("schemaVersion".into(), json!(1));
    envelope.insert("ok".into(), json!(true));
    envelope.insert("target".into(), Value::Object(target));
    if let Value::Object(result) = structured {
        envelope.extend(result);
    }
    Value::Object(envelope)
}

/// Business failure of the shared operation with its code and evidence.
fn business_error(structured: Value) -> CliError {
    let mut error = match structured {
        Value::Object(mut object) => match object.remove("error") {
            Some(Value::Object(error)) => error,
            _ => Map::new(),
        },
        _ => Map::new(),
    };
    let code = error
        .remove("code")
        .and_then(|code| code.as_str().map(str::to_string))
        .unwrap_or_else(|| "SVODE_ERROR".to_string());
    let message = error
        .remove("message")
        .and_then(|message| message.as_str().map(str::to_string))
        .unwrap_or_default();
    let mut failure = CliError::operation(code, message);
    failure.evidence = error;
    failure
}
