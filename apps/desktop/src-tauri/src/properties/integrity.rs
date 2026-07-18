use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionIntegritySeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionIntegrityIssue {
    pub severity: CollectionIntegritySeverity,
    pub code: String,
    pub message: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionIntegrityReport {
    pub errors: Vec<CollectionIntegrityIssue>,
    pub warnings: Vec<CollectionIntegrityIssue>,
}

impl CollectionIntegrityReport {
    fn push(&mut self, issue: CollectionIntegrityIssue) {
        match issue.severity {
            CollectionIntegritySeverity::Error => self.errors.push(issue),
            CollectionIntegritySeverity::Warning => self.warnings.push(issue),
        }
    }

    fn sort(&mut self) {
        let sort_issues = |issues: &mut Vec<CollectionIntegrityIssue>| {
            issues.sort_by(|left, right| {
                left.path
                    .cmp(&right.path)
                    .then_with(|| left.code.cmp(&right.code))
                    .then_with(|| left.related_path.cmp(&right.related_path))
            });
        };
        sort_issues(&mut self.errors);
        sort_issues(&mut self.warnings);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub path: String,
    pub title: String,
    pub row_count: usize,
    pub nested: bool,
}

pub fn list_collections(space: &str) -> Result<Vec<CollectionInfo>, AppError> {
    let root = Path::new(space);
    let mut infos = Vec::new();
    let skip_dirs = child_folder_names(root);
    let policy = TreeIgnorePolicy::from_space_root(root);
    if root.join(SCHEMA_FILE).is_file() {
        infos.push(CollectionInfo {
            path: ".".to_string(),
            title: collection_title(
                root,
                root.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Collection"),
            ),
            row_count: collection_markdown_files(space, ".")?.len(),
            nested: false,
        });
    }
    collect_collections(root, root, &skip_dirs, &policy, &mut infos)?;
    infos.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(infos)
}

/// Validate collection references which can be damaged by deliberate raw filesystem edits.
///
/// This is intentionally read-only. Mutation flows should use the structural entry commands,
/// but an agent that performed an explicit filesystem migration needs one product-level check
/// for relation and sidebar-order invariants afterwards.
pub fn validate_collection_integrity_with_project(
    space: &str,
    collection_path: Option<&str>,
    project_path: Option<&str>,
) -> Result<CollectionIntegrityReport, AppError> {
    let collections = match collection_path {
        Some(path) => {
            let path = normalize_collection_path(path)?;
            let schema_path = collection_dir(space, &path).join(SCHEMA_FILE);
            if !schema_path.is_file() {
                return Err(AppError::FileNotFound(
                    schema_path.to_string_lossy().to_string(),
                ));
            }
            vec![path]
        }
        None => list_collections(space)?
            .into_iter()
            .map(|item| item.path)
            .collect(),
    };

    let mut report = CollectionIntegrityReport::default();
    for collection in &collections {
        validate_collection_relations(space, collection, project_path, &mut report)?;
    }
    validate_stale_order_refs(space, collection_path, &mut report)?;
    report.sort();
    Ok(report)
}

fn validate_collection_relations(
    space: &str,
    collection_path: &str,
    project_path: Option<&str>,
    report: &mut CollectionIntegrityReport,
) -> Result<(), AppError> {
    let schema = read_collection_schema(space, collection_path)?;
    let schema_path = schema_path_for_collection(collection_path);
    let source_files = collection_markdown_files(space, collection_path)?;

    for column in schema
        .columns
        .iter()
        .filter(|column| column.type_ == PropertyType::Relation)
    {
        let Some(relation) = column.relation.as_deref() else {
            report.push(integrity_issue(
                CollectionIntegritySeverity::Error,
                "RELATION_TARGET_MISSING",
                format!("relation column '{}' has no target collection", column.name),
                schema_path.clone(),
                collection_path,
                None,
            ));
            continue;
        };
        let relation = match normalize_collection_path(relation) {
            Ok(path) => path,
            Err(error) => {
                report.push(integrity_issue(
                    CollectionIntegritySeverity::Error,
                    "RELATION_TARGET_INVALID",
                    format!(
                        "relation column '{}' has an invalid target collection: {error}",
                        column.name
                    ),
                    schema_path.clone(),
                    collection_path,
                    None,
                ));
                continue;
            }
        };
        let target_space = match relation_target_space_path(
            space,
            project_path,
            column.relation_scope.as_ref(),
        ) {
            Ok(Some(path)) => path,
            Ok(None) => {
                report.push(integrity_issue(
                    CollectionIntegritySeverity::Error,
                    "RELATION_TARGET_SCOPE_UNAVAILABLE",
                    format!(
                        "relation column '{}' cannot resolve its target scope without project context",
                        column.name
                    ),
                    schema_path.clone(),
                    collection_path,
                    None,
                ));
                continue;
            }
            Err(error) => {
                report.push(integrity_issue(
                    CollectionIntegritySeverity::Error,
                    "RELATION_TARGET_SCOPE_MISSING",
                    format!(
                        "relation column '{}' points to an unavailable target scope: {error}",
                        column.name
                    ),
                    schema_path.clone(),
                    collection_path,
                    None,
                ));
                continue;
            }
        };
        let target_schema = collection_dir(&target_space, &relation).join(SCHEMA_FILE);
        if !target_schema.is_file() {
            report.push(integrity_issue(
                CollectionIntegritySeverity::Error,
                "RELATION_TARGET_COLLECTION_MISSING",
                format!(
                    "relation column '{}' targets collection '{}' without schema.yaml",
                    column.name, relation
                ),
                schema_path.clone(),
                collection_path,
                Some(target_schema.to_string_lossy().replace('\\', "/")),
            ));
            continue;
        }

        for source_file in &source_files {
            let source_path = source_file
                .strip_prefix(space)
                .unwrap_or(source_file)
                .to_string_lossy()
                .replace('\\', "/");
            let raw = fs::read_to_string(source_file)?;
            let meta = match frontmatter::try_parse(&raw) {
                Ok(Some((meta, _))) => meta,
                Ok(None) => continue,
                Err(error) => {
                    report.push(integrity_issue(
                        CollectionIntegritySeverity::Error,
                        "RELATION_SOURCE_FRONTMATTER_MALFORMED",
                        format!(
                            "cannot validate relation column '{}' because frontmatter is malformed: {error}",
                            column.name
                        ),
                        source_path,
                        collection_path,
                        None,
                    ));
                    continue;
                }
            };
            let values = match relation_values_from_value(
                column,
                meta.extra.get(&column.name).unwrap_or(&Value::Null),
            ) {
                Ok(values) => values,
                Err(error) => {
                    report.push(integrity_issue(
                        CollectionIntegritySeverity::Error,
                        "RELATION_VALUE_INVALID",
                        format!(
                            "relation column '{}' has an invalid stored value: {error}",
                            column.name
                        ),
                        source_path,
                        collection_path,
                        None,
                    ));
                    continue;
                }
            };
            for value in values {
                let target_path = join_collection_value(&relation, &value);
                let target_abs = Path::new(&target_space).join(&target_path);
                if !target_abs.is_file() {
                    report.push(integrity_issue(
                        CollectionIntegritySeverity::Error,
                        "RELATION_ENTRY_MISSING",
                        format!(
                            "relation column '{}' points to missing markdown entry '{target_path}'",
                            column.name
                        ),
                        source_path.clone(),
                        collection_path,
                        Some(target_path),
                    ));
                    continue;
                }
                let target_root = find_collection_root(Path::new(&target_space), &target_path);
                if target_root != Some(collection_rel(&relation)) {
                    report.push(integrity_issue(
                        CollectionIntegritySeverity::Error,
                        "RELATION_ENTRY_OUTSIDE_TARGET",
                        format!(
                            "relation column '{}' points outside target collection '{}'",
                            column.name, relation
                        ),
                        source_path.clone(),
                        collection_path,
                        Some(target_path),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_stale_order_refs(
    space: &str,
    selected_collection: Option<&str>,
    report: &mut CollectionIntegrityReport,
) -> Result<(), AppError> {
    let selected_collection = selected_collection
        .map(normalize_collection_path)
        .transpose()?;
    let order = crate::files::tree::read_order(Path::new(space));
    for (directory, entries) in order {
        if !order_key_is_in_scope(&directory, selected_collection.as_deref()) {
            continue;
        }
        let dir_rel = if directory == "." { "" } else { &directory };
        let dir_abs = Path::new(space).join(dir_rel);
        if !dir_abs.is_dir() {
            report.push(integrity_issue(
                CollectionIntegritySeverity::Warning,
                "STALE_ORDER_DIRECTORY",
                "sidebar order contains a directory key that no longer exists".to_string(),
                ".svode/order.json".to_string(),
                selected_collection.as_deref().unwrap_or("."),
                Some(directory.clone()),
            ));
        }
        for name in entries {
            let referenced = dir_abs.join(&name);
            if !referenced.exists() {
                let related_path = if directory == "." {
                    name
                } else {
                    format!("{directory}/{name}")
                };
                report.push(integrity_issue(
                    CollectionIntegritySeverity::Warning,
                    "STALE_ORDER_REF",
                    "sidebar order references an entry that no longer exists".to_string(),
                    ".svode/order.json".to_string(),
                    selected_collection.as_deref().unwrap_or("."),
                    Some(related_path),
                ));
            }
        }
    }
    Ok(())
}

fn schema_path_for_collection(collection_path: &str) -> String {
    let collection = collection_root_for_fs(collection_path);
    if collection.is_empty() {
        SCHEMA_FILE.to_string()
    } else {
        format!("{collection}/{SCHEMA_FILE}")
    }
}

fn order_key_is_in_scope(key: &str, selected_collection: Option<&str>) -> bool {
    let Some(collection) = selected_collection else {
        return true;
    };
    if collection == "." {
        return true;
    }
    key == "." || key == collection || key.starts_with(&format!("{collection}/"))
}

fn integrity_issue(
    severity: CollectionIntegritySeverity,
    code: impl Into<String>,
    message: impl Into<String>,
    path: String,
    collection_path: &str,
    related_path: Option<String>,
) -> CollectionIntegrityIssue {
    CollectionIntegrityIssue {
        severity,
        code: code.into(),
        message: message.into(),
        path,
        collection_path: Some(collection_root_for_schema(collection_path)),
        related_path,
    }
}

fn collect_collections(
    space: &Path,
    dir: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
    out: &mut Vec<CollectionInfo>,
) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();

        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }

        if is_collection_traversal_ignored(space, &path, &meta, skip_dirs, policy) {
            continue;
        }

        if path.join(SCHEMA_FILE).is_file() {
            let rel = path
                .strip_prefix(space)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let title = collection_title(&path, &name);
            let row_count = collection_markdown_files(&space.to_string_lossy(), &rel)?.len();
            let nested =
                find_collection_root(space, &format!("{}/README.md", normalize_rel_path(&rel)))
                    .is_some();
            out.push(CollectionInfo {
                path: rel.clone(),
                title,
                row_count,
                nested,
            });
        }

        collect_collections(space, &path, skip_dirs, policy, out)?;
    }
    Ok(())
}

pub(super) fn is_registered_child_space_rel(rel: &str, skip_dirs: &HashSet<String>) -> bool {
    if rel.is_empty() || rel == "." {
        return false;
    }

    skip_dirs.iter().any(|child| {
        rel == child
            || rel
                .strip_prefix(child)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

fn tree_path_kind(meta: &fs::Metadata) -> TreePathKind {
    if meta.is_dir() {
        TreePathKind::Directory
    } else if meta.is_file() {
        TreePathKind::File
    } else {
        TreePathKind::Unknown
    }
}

pub(super) fn is_collection_traversal_ignored(
    space: &Path,
    path: &Path,
    meta: &fs::Metadata,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> bool {
    let rel_path = path.strip_prefix(space).unwrap_or(path);
    let rel = rel_path_string(rel_path);
    if meta.is_dir() && is_registered_child_space_rel(&rel, skip_dirs) {
        return true;
    }

    policy.is_ignored_rel(rel_path, tree_path_kind(meta))
}

fn collection_title(collection_dir: &Path, fallback_name: &str) -> String {
    let readme = collection_dir.join("README.md");
    if let Ok(raw) = fs::read_to_string(readme) {
        if let Ok(Some((meta, _))) = frontmatter::try_parse(&raw) {
            if !meta.title.trim().is_empty() {
                return meta.title;
            }
        }
    }
    fallback_name.replace(['-', '_'], " ")
}
