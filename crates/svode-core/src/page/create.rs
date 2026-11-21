use std::path::{Path, PathBuf};

use indexmap::IndexMap;

use crate::collections::engine as collections;
use crate::index::state::IndexRuntimeState;
use crate::index::update::IndexUpdateState;
use crate::page::dates::GitDateExecutor;
use crate::page::store::{self, PageWarning};
use crate::page::write::SourceSnapshot;
use crate::page::{PageError, disk_spelling, ensure_path_in_space};

pub struct PageCreate {
    pub space: String,
    pub parent_path: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<store::Cover>,
    pub properties: Option<IndexMap<String, serde_json::Value>>,
    pub contextual_defaults: bool,
    pub allocate_unique_title: bool,
    pub as_readme: bool,
    pub project: Option<String>,
    pub publish_projection: bool,
}

pub struct PageCreateOutcome {
    pub page: store::Page,
    pub changed_paths: Vec<PathBuf>,
}

/// Create a Page with its initial metadata, schema defaults/counters and
/// body as one action under an existing parent directory; any handled
/// failure restores the full touched-set. A leaf Page parent is refused:
/// `structure::create_page` turns it into a folder Page first.
pub async fn create<E, F, Fut, Err>(
    request: PageCreate,
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    authorize: F,
) -> Result<PageCreateOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    create_with_source_names(
        request,
        store::SourceNames::File,
        state,
        updates,
        git_dates,
        authorize,
    )
    .await
}

/// [`create`] whose source filename also keeps the other `names` free.
pub(crate) async fn create_with_source_names<E, F, Fut, Err>(
    request: PageCreate,
    names: store::SourceNames,
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    authorize: F,
) -> Result<PageCreateOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    ensure_path_in_space(
        &request.space,
        request.parent_path.as_deref().unwrap_or_default(),
    )
    .map_err(Err::from)?;
    // Authorization runs before any source change; its failure is returned
    // to the caller exactly as the caller produced it.
    let mut denied = None;
    let denied_slot = &mut denied;
    let result = create_page(
        request,
        names,
        state,
        updates,
        git_dates,
        move |paths| async move {
            authorize(paths).await.map_err(|error| {
                *denied_slot = Some(error);
                PageError::General("Page create authorization failed".into())
            })
        },
    )
    .await;
    match (result, denied) {
        (_, Some(error)) => Err(error),
        (result, None) => result.map_err(Err::from),
    }
}

/// What a create under a resolved parent directory plans before its first
/// write.
struct CreatePlan {
    paths: Vec<PathBuf>,
    properties: IndexMap<String, serde_json::Value>,
    contextual_values: Option<crate::page::frontmatter::FrontmatterFields>,
}

/// Every path a create of `request` under the directory `parent` may write,
/// planned without writing; `parent` may be a folder an earlier step of the
/// same operation creates.
pub(crate) fn mutation_paths(
    request: &PageCreate,
    parent: Option<&str>,
) -> Result<Vec<PathBuf>, PageError> {
    Ok(plan(request, parent)?.paths)
}

/// The refusal of a create without a title, before anything else.
pub(crate) fn ensure_title(request: &PageCreate) -> Result<(), PageError> {
    if request.title.trim().is_empty() {
        return Err(PageError::General("title must not be empty".into()));
    }
    Ok(())
}

fn plan(request: &PageCreate, parent: Option<&str>) -> Result<CreatePlan, PageError> {
    let probe = parent
        .map(|parent| format!("{parent}/.svode-create-probe.md"))
        .unwrap_or_else(|| ".svode-create-probe.md".to_string());
    let properties = request.properties.clone().unwrap_or_default();
    for key in properties.keys() {
        if request.contextual_defaults {
            continue;
        }
        if matches!(
            key.as_str(),
            "title" | "icon" | "description" | "cover" | "created" | "updated"
        ) {
            return Err(PageError::General(format!(
                "system metadata '{key}' must not be passed in properties"
            )));
        }
    }

    let mut candidate = store::PageMeta::new_persisted(request.title.clone());
    if let Some(icon) = request.icon.clone() {
        store::apply_item_field_update(&mut candidate, "icon", icon.into())?;
    }
    if let Some(description) = request.description.clone() {
        store::apply_item_field_update(&mut candidate, "description", description.into())?;
    }
    if let Some(cover) = request.cover.clone() {
        store::apply_item_field_update(&mut candidate, "cover", serde_json::to_value(cover)?)?;
    }

    let schema_root = collections::resolve_collection_schema_result(&request.space, &probe)?
        .map(|(_, root)| root.to_string_lossy().replace('\\', "/"));
    let mut paths = vec![
        Path::new(&request.space).join(".svode/order.json"),
        PathBuf::from(&request.space),
    ];
    paths.extend(collections::unique_id_mutation_paths_for_item(
        &request.space,
        &probe,
    )?);
    let contextual_values = request
        .contextual_defaults
        .then(|| {
            properties
                .iter()
                .map(|(field, value)| {
                    serde_norway::to_value(value)
                        .map(|value| (field.clone(), value))
                        .map_err(|error| {
                            PageError::General(format!(
                                "invalid contextual default '{field}': {error}"
                            ))
                        })
                })
                .collect::<Result<crate::page::frontmatter::FrontmatterFields, _>>()
        })
        .transpose()?;
    for (field, value) in &properties {
        if request.contextual_defaults {
            continue;
        }
        collections::ensure_item_field_writable(&request.space, &probe, field)?;
        let yaml = serde_norway::to_value(value)
            .map_err(|error| PageError::General(format!("invalid property '{field}': {error}")))?;
        let normalized =
            collections::normalize_item_field_value(&request.space, &probe, field, yaml)?;
        collections::validate_item_field_value(&request.space, &probe, field, &normalized)?;
        if let Some(collection) = schema_root.as_deref() {
            paths.extend(
                collections::relation_field_target_mutation_paths_for_value_with_project(
                    &request.space,
                    request.project.as_deref(),
                    collection,
                    field,
                    normalized,
                )?,
            );
        }
    }
    paths.sort();
    paths.dedup();
    Ok(CreatePlan {
        paths,
        properties,
        contextual_values,
    })
}

async fn create_page<E, F, Fut>(
    request: PageCreate,
    names: store::SourceNames,
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    authorize: F,
) -> Result<PageCreateOutcome, PageError>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, PageError>>,
{
    ensure_title(&request)?;
    let requested_parent = request
        .parent_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let parent = resolve_parent(&request.space, requested_parent)?;
    let CreatePlan {
        paths: planned_paths,
        properties,
        contextual_values,
    } = plan(&request, parent.as_deref())?;
    let authorized = authorize(planned_paths.clone()).await?;
    let sources = planned_paths
        .into_iter()
        .filter(|path| !path.is_dir())
        .collect::<Vec<_>>();
    let mut snapshot = SourceSnapshot::capture(&sources, None)?;

    let operation = crate::git::access::scope_authorized_mutation_paths(
        authorized,
        async {
            let created = store::create_source_with_options(
                &request.space,
                parent.as_deref(),
                &request.title,
                request.allocate_unique_title,
                request.as_readme,
                names,
            )?;
            snapshot.track_created(Path::new(&request.space).join(&created.path));
            checkpoint("create")?;
            let warnings = created.warnings.clone();
            let mut page = created;
            let mut initial_metadata = page.meta.clone();
            collections::apply_schema_defaults_for_path(
                &request.space,
                &page.path,
                &mut initial_metadata,
            )?;
            if let Some(contextual_values) = contextual_values.as_ref() {
                collections::apply_contextual_defaults_for_path(
                    &request.space,
                    &page.path,
                    &mut initial_metadata,
                    contextual_values,
                )?;
            }
            collections::assign_unique_id_to_meta_for_path(
                &request.space,
                &page.path,
                &mut initial_metadata,
            )?;
            store::write_under_name_lock(
                &request.space,
                &page.path,
                &page.body,
                None,
                None,
                None,
                Some(initial_metadata),
                None,
                None,
                true,
                request.project.as_deref(),
                None,
            )?;
            page = store::read(&request.space, &page.path)?;

            let mut fields = std::collections::BTreeMap::new();
            if !request.contextual_defaults {
                fields.extend(properties);
            }
            if let Some(icon) = request.icon.clone() {
                fields.insert("icon".to_string(), icon.into());
            }
            if let Some(description) = request.description.clone() {
                fields.insert("description".to_string(), description.into());
            }
            if let Some(cover) = request.cover.clone() {
                fields.insert("cover".to_string(), serde_json::to_value(cover)?);
            }
            if !fields.is_empty() {
                let batch = collections::prepare_item_field_batch(
                    &request.space,
                    request.project.as_deref(),
                    &page.path,
                    &fields,
                    collections::ItemFieldBatchIntent::Literal,
                )?;
                collections::apply_prepared_item_field_relations(&batch)?;
                store::write_under_name_lock(
                    &request.space,
                    &page.path,
                    &page.body,
                    None,
                    None,
                    None,
                    Some(batch.into_metadata()),
                    None,
                    None,
                    true,
                    request.project.as_deref(),
                    None,
                )?;
                page = store::read(&request.space, &page.path)?;
            }
            checkpoint("properties")?;
            if let Some(body) = request.body.as_deref() {
                page = store::replace_created_body(&request.space, &page.path, body)?;
            }
            checkpoint("body")?;
            page.warnings.extend(warnings);
            page.source_version = Some(crate::page::current_source_version(
                Path::new(&request.space),
                &page.path,
            )?);
            Ok(page)
        },
        PageError::from,
    )
    .await;
    let mut page = match operation {
        Ok(page) => page,
        Err(error) => return Err(snapshot.rollback(error)),
    };
    let changed_paths = snapshot.changes()?;
    let markdown = changed_paths
        .iter()
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        })
        .cloned()
        .collect();
    let projection_errors = if request.publish_projection {
        match checkpoint("projection") {
            Ok(()) => {
                crate::index::update::publish_paths_or_repair(
                    state,
                    updates,
                    git_dates,
                    request.project.as_deref(),
                    &request.space,
                    markdown,
                    "create_page",
                )
                .await
            }
            Err(error) => vec![error.to_string()],
        }
    } else {
        Vec::new()
    };
    if !projection_errors.is_empty() {
        page.warnings.push(PageWarning {
            kind: "projection_update_failed".into(),
            message: format!(
                "Page was created, but derived projection needs refresh: {}",
                projection_errors.join("; ")
            ),
            path: Some(page.path.clone()),
            ..PageWarning::default()
        });
    }
    let warnings = page.warnings;
    page = store::read(&request.space, &page.path)?;
    page.warnings = warnings;
    Ok(PageCreateOutcome {
        page,
        changed_paths,
    })
}

/// The existing parent directory of a create. A leaf Page parent becomes a
/// folder Page through the structural create, which converts it before it
/// creates in the folder.
fn resolve_parent(space: &str, requested: Option<&str>) -> Result<Option<String>, PageError> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    match resolve_page_parent(space, requested)? {
        PageParent::Directory(directory) => Ok(Some(directory)),
        PageParent::Leaf { leaf, .. } => Err(PageError::General(format!(
            "parent Page {leaf} must be a folder Page; create through structure::create_page"
        ))),
        PageParent::NotPage(_) => Err(not_a_markdown_parent()),
    }
}

/// Parent directory a Page operation puts content under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PageParent {
    /// An existing directory; empty for the Space root.
    Directory(String),
    /// The leaf Page `leaf` that first becomes the folder Page `folder`.
    Leaf { leaf: String, folder: String },
    /// An existing file that is not a Markdown Page.
    NotPage(String),
}

/// The refusal of a create under a file that is not a Markdown Page.
pub(crate) fn not_a_markdown_parent() -> PageError {
    PageError::General("parent Page must be Markdown".into())
}

/// Resolve the requested parent of a create or a move: an existing directory
/// is the parent as is; a leaf Page `X.md`, or `X` when only `X.md` exists,
/// becomes the folder Page `X`. The parent and the leaf take the spelling
/// the file system stores them in, so everything derived from them matches
/// the disk. A leaf whose folder name a sibling takes portably is refused
/// before any write, and a path that names nothing is `FileNotFound`.
pub(crate) fn resolve_page_parent(space: &str, requested: &str) -> Result<PageParent, PageError> {
    if requested.is_empty() {
        return Ok(PageParent::Directory(String::new()));
    }
    let root = Path::new(space);
    let spelled = disk_spelling(root, requested);
    let direct = root.join(&spelled);
    if direct.is_dir() {
        return Ok(PageParent::Directory(spelled));
    }
    let leaf = if direct.is_file() {
        spelled
    } else if Path::new(requested).extension().is_none() {
        let candidate = disk_spelling(root, &format!("{requested}.md"));
        if root.join(&candidate).is_file() {
            candidate
        } else {
            return Err(PageError::FileNotFound(requested.to_string()));
        }
    } else {
        return Err(PageError::FileNotFound(requested.to_string()));
    };
    if !Path::new(&leaf)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Ok(PageParent::NotPage(leaf));
    }
    let stem = Path::new(&leaf)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| PageError::General("parent Page has an invalid filename".into()))?;
    let base = Path::new(&leaf).parent().unwrap_or(Path::new(""));
    let folder = if base.as_os_str().is_empty() {
        stem.to_string()
    } else {
        format!("{}/{stem}", base.to_string_lossy())
    };
    // The leaf becomes a directory of this name: a sibling that takes it
    // portably refuses the operation before its first write.
    if store::name_taken_portably(&root.join(&folder), None)? {
        return Err(PageError::FileAlreadyExists(folder));
    }
    Ok(PageParent::Leaf { leaf, folder })
}

#[cfg(not(test))]
fn checkpoint(_: &str) -> Result<(), PageError> {
    Ok(())
}

#[cfg(test)]
thread_local! { static FAILURE: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) }; }

/// Make `checkpoint(stage)` of a Page create fail on this thread.
#[cfg(test)]
pub(crate) fn inject_failure(stage: Option<&'static str>) {
    FAILURE.with(|failure| *failure.borrow_mut() = stage);
}

#[cfg(test)]
fn checkpoint(stage: &str) -> Result<(), PageError> {
    if FAILURE.with(|failure| *failure.borrow() == Some(stage)) {
        Err(PageError::General(format!("injected {stage} failure")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::state::IndexRuntimeState;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::page::test_support::{scaffold_space, update_state};
    use serde_json::json;
    use std::fs;

    fn request(root: &Path) -> PageCreate {
        fs::create_dir_all(root.join(".git")).unwrap();
        PageCreate {
            space: root.to_string_lossy().to_string(),
            parent_path: None,
            title: "Budget".into(),
            body: Some("Initial body".into()),
            icon: Some("wallet".into()),
            description: Some("  keep whitespace  ".into()),
            cover: None,
            properties: Some(IndexMap::from([("id".into(), json!("custom"))])),
            contextual_defaults: false,
            allocate_unique_title: false,
            as_readme: false,
            project: None,
            publish_projection: true,
        }
    }

    #[tokio::test]
    async fn standalone_create_uses_managed_name_and_preserves_initial_data() {
        let temp = tempfile::tempdir().unwrap();
        scaffold_space(temp.path(), "Test");
        let outcome = create(
            request(temp.path()),
            &IndexRuntimeState::default(),
            update_state(),
            None::<&SystemGitDateExecutor>,
            |paths| async move { Ok::<_, PageError>(paths) },
        )
        .await
        .unwrap();
        assert_eq!(outcome.page.path, "Budget.md");
        assert_eq!(outcome.page.body, "Initial body");
        assert_eq!(outcome.page.meta.icon.as_deref(), Some("wallet"));
        assert_eq!(
            outcome.page.meta.description.as_deref(),
            Some("  keep whitespace  ")
        );
        assert_eq!(
            outcome.page.meta.extra.get("id"),
            Some(&serde_norway::Value::String("custom".into()))
        );
    }

    #[tokio::test]
    async fn schema_defaults_and_explicit_null_are_one_create_action() {
        let temp = tempfile::tempdir().unwrap();
        scaffold_space(temp.path(), "Test");
        fs::create_dir_all(temp.path().join("Tasks")).unwrap();
        fs::write(
            temp.path().join("Tasks/schema.yaml"),
            "columns:\n  - { name: Status, type: text, default: Todo }\n  - { name: Key, type: unique_id, prefix: TASK, next: 1 }\nviews: []\n",
        )
        .unwrap();
        let mut input = request(temp.path());
        input.parent_path = Some("Tasks".into());
        input.properties = Some(IndexMap::from([("Status".into(), serde_json::Value::Null)]));
        let outcome = create(
            input,
            &IndexRuntimeState::default(),
            update_state(),
            None::<&SystemGitDateExecutor>,
            |paths| async move { Ok::<_, PageError>(paths) },
        )
        .await
        .unwrap();
        assert!(!outcome.page.meta.extra.contains_key("Status"));
        assert_eq!(
            outcome.page.meta.extra.get("Key"),
            Some(&serde_norway::Value::Number(1.into()))
        );
    }

    #[tokio::test]
    async fn late_failure_restores_created_page_counter_and_order() {
        let temp = tempfile::tempdir().unwrap();
        scaffold_space(temp.path(), "Test");
        let schema = temp.path().join("schema.yaml");
        fs::write(
            &schema,
            "columns:\n  - { name: Key, type: unique_id, prefix: KEY, next: 1 }\nviews: []\n",
        )
        .unwrap();
        let before_schema = fs::read(&schema).unwrap();
        let order = temp.path().join(".svode/order.json");
        fs::write(&order, "{}").unwrap();
        let before_order = fs::read(&order).unwrap();
        inject_failure(Some("body"));
        let result = create(
            request(temp.path()),
            &IndexRuntimeState::default(),
            update_state(),
            None::<&SystemGitDateExecutor>,
            |paths| async move { Ok::<_, PageError>(paths) },
        )
        .await;
        inject_failure(None);
        assert!(result.is_err());
        assert!(!temp.path().join("Budget.md").exists());
        assert_eq!(fs::read(schema).unwrap(), before_schema);
        assert_eq!(fs::read(order).unwrap(), before_order);
    }

    #[tokio::test]
    async fn read_only_initial_property_is_rejected_before_create() {
        let temp = tempfile::tempdir().unwrap();
        scaffold_space(temp.path(), "Test");
        fs::write(
            temp.path().join("schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: KEY, next: 1 }\nviews: []\n",
        )
        .unwrap();
        let mut input = request(temp.path());
        input.properties = Some(IndexMap::from([("Key".into(), json!(42))]));
        let result = create(
            input,
            &IndexRuntimeState::default(),
            update_state(),
            None::<&SystemGitDateExecutor>,
            |paths| async move { Ok::<_, PageError>(paths) },
        )
        .await;
        assert!(result.is_err());
        assert!(!temp.path().join("Budget.md").exists());
        assert!(
            fs::read_to_string(temp.path().join("schema.yaml"))
                .unwrap()
                .contains("next: 1")
        );
    }

    #[tokio::test]
    async fn projection_failure_is_an_applied_warning() {
        let temp = tempfile::tempdir().unwrap();
        scaffold_space(temp.path(), "Test");
        inject_failure(Some("projection"));
        let outcome = create(
            request(temp.path()),
            &IndexRuntimeState::default(),
            update_state(),
            None::<&SystemGitDateExecutor>,
            |paths| async move { Ok::<_, PageError>(paths) },
        )
        .await
        .unwrap();
        inject_failure(None);
        assert!(temp.path().join("Budget.md").exists());
        assert!(
            outcome
                .page
                .warnings
                .iter()
                .any(|warning| warning.kind == "projection_update_failed")
        );
    }
}
