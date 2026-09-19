use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::files::entry::{self, EntryWarning};
use crate::index::{IndexState, update::IndexUpdateState};

pub(crate) struct PageCreate {
    pub space: String,
    pub parent_path: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<entry::Cover>,
    pub properties: Option<HashMap<String, serde_json::Value>>,
    pub contextual_defaults: bool,
    pub allocate_unique_title: bool,
    pub as_readme: bool,
    pub project: Option<String>,
    pub publish_projection: bool,
}

pub(crate) struct PageCreateOutcome {
    pub page: entry::Entry,
    pub changed_paths: Vec<PathBuf>,
}

struct SourceSnapshot {
    files: BTreeMap<PathBuf, Option<Vec<u8>>>,
    created_dirs: Vec<PathBuf>,
}

impl SourceSnapshot {
    fn capture(paths: impl IntoIterator<Item = PathBuf>) -> Result<Self, AppError> {
        let mut files = BTreeMap::new();
        for path in paths {
            if path.is_dir() {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            files.insert(path, bytes);
        }
        Ok(Self {
            files,
            created_dirs: Vec::new(),
        })
    }

    fn track_created(&mut self, path: PathBuf) {
        self.files.entry(path).or_insert(None);
    }

    fn track_created_dir(&mut self, path: PathBuf) {
        if !self.created_dirs.contains(&path) {
            self.created_dirs.push(path);
        }
    }

    fn rollback(&self, cause: AppError) -> AppError {
        let mut failed = Vec::new();
        for (path, original) in self.files.iter().rev() {
            let restored = match original {
                Some(bytes) => {
                    if let Some(parent) = path.parent() {
                        if let Err(error) = fs::create_dir_all(parent) {
                            failed.push(format!("{}: {error}", parent.display()));
                            continue;
                        }
                    }
                    fs::write(path, bytes)
                }
                None => match fs::remove_file(path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error),
                },
            };
            if let Err(error) = restored {
                failed.push(format!("{}: {error}", path.display()));
            }
        }
        for path in self.created_dirs.iter().rev() {
            match fs::remove_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => failed.push(format!("{}: {error}", path.display())),
            }
        }
        if failed.is_empty() {
            cause
        } else {
            AppError::PageWriteRecovery {
                cause: cause.to_string(),
                paths: failed,
            }
        }
    }

    fn changes(&self) -> Result<Vec<PathBuf>, AppError> {
        let mut changed = Vec::new();
        for (path, before) in &self.files {
            let after = match fs::read(path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if &after != before {
                changed.push(path.clone());
            }
        }
        Ok(changed)
    }
}

pub(crate) async fn create<F, Fut>(
    request: PageCreate,
    state: &IndexState,
    updates: &IndexUpdateState,
    authorize: F,
) -> Result<PageCreateOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    if request.title.trim().is_empty() {
        return Err(AppError::General("title must not be empty".into()));
    }
    let requested_parent = request
        .parent_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let (parent, parent_conversion) = resolve_parent(&request.space, requested_parent)?;
    let probe = parent
        .as_deref()
        .map(|parent| format!("{parent}/.svode-create-probe.md"))
        .unwrap_or_else(|| ".svode-create-probe.md".to_string());
    let properties = request.properties.unwrap_or_default();
    for key in properties.keys() {
        if request.contextual_defaults {
            continue;
        }
        if matches!(
            key.as_str(),
            "title" | "icon" | "description" | "cover" | "created" | "updated"
        ) {
            return Err(AppError::General(format!(
                "system metadata '{key}' must not be passed in properties"
            )));
        }
    }

    let mut candidate = entry::EntryMeta::new_persisted(request.title.clone());
    if let Some(icon) = request.icon.clone() {
        entry::apply_entry_field_update(&mut candidate, "icon", icon.into())?;
    }
    if let Some(description) = request.description.clone() {
        entry::apply_entry_field_update(&mut candidate, "description", description.into())?;
    }
    if let Some(cover) = request.cover.clone() {
        entry::apply_entry_field_update(&mut candidate, "cover", serde_json::to_value(cover)?)?;
    }

    let schema_root = crate::properties::resolve_collection_schema_result(&request.space, &probe)?
        .map(|(_, root)| root.to_string_lossy().replace('\\', "/"));
    let mut planned_paths = vec![
        Path::new(&request.space).join(".svode/order.json"),
        PathBuf::from(&request.space),
    ];
    planned_paths.extend(crate::properties::unique_id_mutation_paths_for_entry(
        &request.space,
        &probe,
    )?);
    if let Some((old, new_parent)) = parent_conversion.as_ref() {
        let root = Path::new(&request.space);
        planned_paths.extend(crate::space::structural::collect_markdown_paths(
            root,
            root,
            &svode_core::content_tree::policy::TreeIgnorePolicy::from_space_root(root),
        )?);
        planned_paths.push(root.join(old));
        planned_paths.push(root.join(new_parent).join("README.md"));
        planned_paths.extend(
            crate::properties::relation_move_mutation_paths_with_project(
                &request.space,
                request.project.as_deref(),
                old,
                &format!("{new_parent}/README.md"),
            )?,
        );
    }
    let contextual_values = request
        .contextual_defaults
        .then(|| {
            properties
                .iter()
                .map(|(field, value)| {
                    serde_yml::to_value(value)
                        .map(|value| (field.clone(), value))
                        .map_err(|error| {
                            AppError::General(format!(
                                "invalid contextual default '{field}': {error}"
                            ))
                        })
                })
                .collect::<Result<HashMap<_, _>, _>>()
        })
        .transpose()?;
    for (field, value) in &properties {
        if request.contextual_defaults {
            continue;
        }
        crate::properties::ensure_entry_field_writable(&request.space, &probe, field)?;
        let yaml = serde_yml::to_value(value)
            .map_err(|error| AppError::General(format!("invalid property '{field}': {error}")))?;
        let normalized =
            crate::properties::normalize_entry_field_value(&request.space, &probe, field, yaml)?;
        crate::properties::validate_entry_field_value(&request.space, &probe, field, &normalized)?;
        if let Some(collection) = schema_root.as_deref() {
            planned_paths.extend(
                crate::properties::relation_field_target_mutation_paths_for_value_with_project(
                    &request.space,
                    request.project.as_deref(),
                    collection,
                    field,
                    normalized,
                )?,
            );
        }
    }
    planned_paths.sort();
    planned_paths.dedup();
    let authorized = authorize(planned_paths.clone()).await?;
    let mut snapshot = SourceSnapshot::capture(planned_paths)?;
    let backlinks = if parent_conversion.is_some() {
        let backlinks = crate::space::structural::backlinks_for_space(state, &request.space).await;
        if !backlinks.is_built() {
            backlinks.build(Path::new(&request.space))?;
        }
        Some(backlinks)
    } else {
        None
    };

    let operation = crate::git::access::scope_authorized_mutation_paths(authorized, async {
        if let Some((old, new_parent)) = parent_conversion.as_ref() {
            let converted = entry::convert_entry_to_folder(
                Path::new(&request.space),
                old,
                backlinks.as_deref(),
            )?;
            if converted.path != format!("{new_parent}/README.md") {
                return Err(AppError::General(
                    "parent Page conversion returned an unexpected path".into(),
                ));
            }
            snapshot.track_created(Path::new(&request.space).join(&converted.path));
            snapshot.track_created_dir(Path::new(&request.space).join(new_parent));
        }
        let created = entry::create_source_with_options(
            &request.space,
            parent.as_deref(),
            &request.title,
            request.allocate_unique_title,
            request.as_readme,
        )?;
        snapshot.track_created(Path::new(&request.space).join(&created.path));
        checkpoint("create")?;
        let warnings = created.warnings.clone();
        let mut page = created;
        let mut initial_metadata = page.meta.clone();
        crate::properties::apply_schema_defaults_for_path(
            &request.space,
            &page.path,
            &mut initial_metadata,
        )?;
        if let Some(contextual_values) = contextual_values.as_ref() {
            crate::properties::apply_contextual_defaults_for_path(
                &request.space,
                &page.path,
                &mut initial_metadata,
                contextual_values,
            )?;
        }
        crate::properties::assign_unique_id_to_meta_for_path(
            &request.space,
            &page.path,
            &mut initial_metadata,
        )?;
        entry::write_under_name_lock(
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
        page = entry::read(&request.space, &page.path)?;

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
            let batch = crate::properties::prepare_entry_field_batch(
                &request.space,
                request.project.as_deref(),
                &page.path,
                &fields,
                crate::properties::EntryFieldBatchIntent::Literal,
            )?;
            crate::properties::apply_prepared_entry_field_relations(&batch)?;
            entry::write_under_name_lock(
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
            page = entry::read(&request.space, &page.path)?;
        }
        checkpoint("properties")?;
        if let Some(body) = request.body.as_deref() {
            page = entry::replace_created_body(&request.space, &page.path, body)?;
        }
        checkpoint("body")?;
        page.warnings.extend(warnings);
        Ok(page)
    })
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
                crate::space::structural::update_index_paths_or_reindex(
                    state,
                    updates,
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
        page.warnings.push(EntryWarning {
            kind: "projection_update_failed".into(),
            message: format!(
                "Page was created, but derived projection needs refresh: {}",
                projection_errors.join("; ")
            ),
            path: Some(page.path.clone()),
        });
    }
    let warnings = page.warnings;
    page = entry::read(&request.space, &page.path)?;
    page.warnings = warnings;
    Ok(PageCreateOutcome {
        page,
        changed_paths,
    })
}

fn resolve_parent(
    space: &str,
    requested: Option<&str>,
) -> Result<(Option<String>, Option<(String, String)>), AppError> {
    let Some(requested) = requested else {
        return Ok((None, None));
    };
    let root = Path::new(space);
    let requested_path = Path::new(requested);
    let direct = root.join(requested_path);
    if direct.is_dir() {
        return Ok((Some(requested.to_string()), None));
    }
    let leaf = if direct.is_file() {
        requested.to_string()
    } else if requested_path.extension().is_none() {
        let candidate = format!("{requested}.md");
        if root.join(&candidate).is_file() {
            candidate
        } else {
            return Err(AppError::FileNotFound(requested.to_string()));
        }
    } else {
        return Err(AppError::FileNotFound(requested.to_string()));
    };
    if !Path::new(&leaf)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(AppError::General("parent Page must be Markdown".into()));
    }
    let stem = Path::new(&leaf)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AppError::General("parent Page has an invalid filename".into()))?;
    let base = Path::new(&leaf).parent().unwrap_or(Path::new(""));
    let parent = if base.as_os_str().is_empty() {
        stem.to_string()
    } else {
        format!("{}/{stem}", base.to_string_lossy())
    };
    Ok((Some(parent.clone()), Some((leaf, parent))))
}

#[cfg(not(test))]
fn checkpoint(_: &str) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
thread_local! { static FAILURE: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) }; }

#[cfg(test)]
fn checkpoint(stage: &str) -> Result<(), AppError> {
    if FAILURE.with(|failure| *failure.borrow() == Some(stage)) {
        Err(AppError::General(format!("injected {stage} failure")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::update::test_update_state;
    use serde_json::json;

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
            properties: Some(HashMap::from([("id".into(), json!("custom"))])),
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
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
        let outcome = create(
            request(temp.path()),
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
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
            Some(&serde_yml::Value::String("custom".into()))
        );
    }

    #[tokio::test]
    async fn schema_defaults_and_explicit_null_are_one_create_action() {
        let temp = tempfile::tempdir().unwrap();
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
        fs::create_dir_all(temp.path().join("Tasks")).unwrap();
        fs::write(
            temp.path().join("Tasks/schema.yaml"),
            "columns:\n  - { name: Status, type: text, default: Todo }\n  - { name: Key, type: unique_id, prefix: TASK, next: 1 }\nviews: []\n",
        )
        .unwrap();
        let mut input = request(temp.path());
        input.parent_path = Some("Tasks".into());
        input.properties = Some(HashMap::from([("Status".into(), serde_json::Value::Null)]));
        let outcome = create(
            input,
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
        )
        .await
        .unwrap();
        assert!(!outcome.page.meta.extra.contains_key("Status"));
        assert_eq!(
            outcome.page.meta.extra.get("Key"),
            Some(&serde_yml::Value::Number(1.into()))
        );
    }

    #[tokio::test]
    async fn creating_under_leaf_materializes_parent_in_the_same_action() {
        let temp = tempfile::tempdir().unwrap();
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
        fs::write(
            temp.path().join("Parent.md"),
            "---\ntitle: Parent\n---\nParent body",
        )
        .unwrap();
        let mut input = request(temp.path());
        input.parent_path = Some("Parent.md".into());
        let outcome = create(
            input,
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
        )
        .await
        .unwrap();
        assert_eq!(outcome.page.path, "Parent/Budget.md");
        assert!(!temp.path().join("Parent.md").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("Parent/README.md")).unwrap(),
            "---\ntitle: Parent\n---\nParent body"
        );
    }

    #[tokio::test]
    async fn late_failure_restores_created_page_counter_and_order() {
        let temp = tempfile::tempdir().unwrap();
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
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
        FAILURE.with(|failure| *failure.borrow_mut() = Some("body"));
        let result = create(
            request(temp.path()),
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
        )
        .await;
        FAILURE.with(|failure| *failure.borrow_mut() = None);
        assert!(result.is_err());
        assert!(!temp.path().join("Budget.md").exists());
        assert_eq!(fs::read(schema).unwrap(), before_schema);
        assert_eq!(fs::read(order).unwrap(), before_order);
    }

    #[tokio::test]
    async fn read_only_initial_property_is_rejected_before_create() {
        let temp = tempfile::tempdir().unwrap();
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
        fs::write(
            temp.path().join("schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: KEY, next: 1 }\nviews: []\n",
        )
        .unwrap();
        let mut input = request(temp.path());
        input.properties = Some(HashMap::from([("Key".into(), json!(42))]));
        let result = create(
            input,
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
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
    async fn failure_after_parent_conversion_restores_leaf_layout() {
        let temp = tempfile::tempdir().unwrap();
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
        let original = "---\ntitle: Parent\n---\nParent body";
        fs::write(temp.path().join("Parent.md"), original).unwrap();
        let mut input = request(temp.path());
        input.parent_path = Some("Parent.md".into());
        FAILURE.with(|failure| *failure.borrow_mut() = Some("body"));
        let result = create(
            input,
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
        )
        .await;
        FAILURE.with(|failure| *failure.borrow_mut() = None);
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(temp.path().join("Parent.md")).unwrap(),
            original
        );
        assert!(!temp.path().join("Parent").exists());
    }

    #[tokio::test]
    async fn projection_failure_is_an_applied_warning() {
        let temp = tempfile::tempdir().unwrap();
        crate::space::scaffold::scaffold_space(temp.path(), "Test", "", "").unwrap();
        FAILURE.with(|failure| *failure.borrow_mut() = Some("projection"));
        let outcome = create(
            request(temp.path()),
            &IndexState::new(),
            test_update_state(),
            |paths| async move { Ok(paths) },
        )
        .await
        .unwrap();
        FAILURE.with(|failure| *failure.borrow_mut() = None);
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
