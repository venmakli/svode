use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::collections::engine;
use crate::content_tree;
use crate::page::create::{PageCreate, PageCreateOutcome, PageParent, initial_literal_fields};
use crate::page::filename::{self, FilenameProjection};
use crate::page::frontmatter::{self, FrontmatterFields};
use crate::page::store::{self, Page, PageMeta, PageWarning};
use crate::page::write::SourceSnapshot;
use crate::page::{ChildSpaceRoots, PageError, disk_spelling, ensure_path_in_space};

use crate::collections::engine::{
    README_FILE, TemplateSource, humanize_template_slug as humanize_slug,
    join_template_rel as join_rel, normalize_template_rel as normalize_rel,
    resolve_template_source, template_head_rel, template_path_in_space,
    template_rel_abs as rel_abs, templates_dir,
};
pub use crate::collections::engine::{
    TemplateInfo, TemplateKind, list_templates as list,
    prepare_reorder_templates as prepare_reorder,
    prepare_set_default_template as prepare_set_default,
};

pub struct DeletedTemplate {
    pub title: String,
    pub root_path: String,
}

pub struct DuplicatedTemplate {
    pub head_path: String,
    pub old_title: String,
    pub new_title: String,
}

pub struct InstantiatedTemplate {
    pub page: Page,
    pub template_title: String,
}

struct MarkdownDoc {
    meta: PageMeta,
    body: String,
}

pub struct TemplateInitialValues<'a> {
    pub content: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<store::Cover>,
    pub properties: BTreeMap<String, serde_json::Value>,
    pub project: Option<&'a str>,
}

pub struct CreatedTemplate {
    pub slug: String,
    pub head_path: String,
    pub changed_paths: Vec<PathBuf>,
}

struct TemplateCreatePlan {
    slug: String,
    head_rel: String,
    templates_abs: PathBuf,
    root_abs: PathBuf,
    head_abs: PathBuf,
    schema_abs: Option<PathBuf>,
    batch: engine::PreparedItemFieldBatch,
}

impl TemplateCreatePlan {
    fn mutation_paths(&self) -> Vec<PathBuf> {
        let mut paths = self.batch.mutation_paths().to_vec();
        paths.extend(self.schema_abs.iter().cloned());
        paths
    }
}

pub fn create_mutation_paths(
    space: &str,
    collection_path: &str,
    title: &str,
    kind: TemplateKind,
    initial: Option<&TemplateInitialValues<'_>>,
) -> Result<Vec<PathBuf>, PageError> {
    Ok(plan_create(space, collection_path, title, kind, initial)?.mutation_paths())
}

pub fn create(
    space: &str,
    collection_path: &str,
    title: &str,
    kind: TemplateKind,
    initial: Option<&TemplateInitialValues<'_>>,
) -> Result<CreatedTemplate, PageError> {
    ensure_path_in_space(space, collection_path)?;
    crate::page::naming::with_document_name_lock(space, || {
        let plan = plan_create(space, collection_path, title, kind, initial)?;
        crate::git::access::ensure_mutation_paths_were_authorized(&plan.mutation_paths())?;
        commit_create(
            space,
            plan,
            initial
                .and_then(|initial| initial.content.as_deref())
                .unwrap_or(""),
        )
    })
}

fn plan_create(
    space: &str,
    collection_path: &str,
    title: &str,
    kind: TemplateKind,
    initial: Option<&TemplateInitialValues<'_>>,
) -> Result<TemplateCreatePlan, PageError> {
    let collection_path = normalize_rel(&disk_spelling(space, collection_path));
    let collection_path = collection_path.as_str();
    ensure_path_in_space(space, collection_path)?;
    if title.trim().is_empty() {
        return Err(PageError::General("title must not be empty".into()));
    }
    let canonical_space = fs::canonicalize(space)?;
    let collection_abs = rel_abs(space, collection_path);
    if !fs::canonicalize(&collection_abs)?.starts_with(&canonical_space) {
        return Err(PageError::PathNotAccessible(collection_path.to_string()));
    }
    let schema_source = collection_abs.join(engine::SCHEMA_FILE);
    let schema_rel = rel_from_abs(Path::new(space), &schema_source);
    ensure_path_in_space(space, &schema_rel)?;
    match fs::canonicalize(&schema_source) {
        Ok(schema) if !schema.starts_with(&canonical_space) => {
            return Err(PageError::PathNotAccessible(schema_rel));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    engine::read_collection_schema(space, collection_path)?;
    let templates_abs = templates_dir(space, collection_path);
    let templates_rel = rel_from_abs(Path::new(space), &templates_abs);
    ensure_path_in_space(space, &templates_rel)?;
    match fs::symlink_metadata(&templates_abs) {
        Ok(metadata) if !metadata.is_dir() => {
            return Err(PageError::PathNotAccessible(templates_rel));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let slug = unique_template_slug(&templates_abs, &store::slugify(title));
    let head_rel = template_head_rel(collection_path, &slug, kind);
    ensure_path_in_space(space, &head_rel)?;
    let head_abs = rel_abs(space, &head_rel);
    let root_abs = if kind == TemplateKind::Leaf {
        head_abs.clone()
    } else {
        templates_abs.join(&slug)
    };
    let schema_abs =
        (kind == TemplateKind::NestedCollection).then(|| root_abs.join(engine::SCHEMA_FILE));
    let mut meta = PageMeta::new_persisted(title.to_string());
    engine::apply_schema_defaults_for_path(space, &head_rel, &mut meta)?;

    let mut fields = BTreeMap::new();
    if let Some(initial) = initial {
        if let Some(key) = initial.properties.keys().find(|key| {
            matches!(
                key.as_str(),
                "title" | "icon" | "description" | "cover" | "created" | "updated"
            )
        }) {
            return Err(PageError::General(format!(
                "system metadata '{key}' must not be passed in properties"
            )));
        }
        fields.extend(initial.properties.clone());
        fields.extend(
            initial
                .icon
                .as_ref()
                .map(|value| ("icon".into(), value.clone().into())),
        );
        fields.extend(
            initial
                .description
                .as_ref()
                .map(|value| ("description".into(), value.clone().into())),
        );
        if let Some(cover) = &initial.cover {
            fields.insert("cover".into(), serde_json::to_value(cover)?);
        }
    }
    let batch = engine::prepare_item_field_batch_from_metadata(
        space,
        initial.and_then(|initial| initial.project),
        &head_rel,
        meta,
        &fields,
        engine::ItemFieldBatchIntent::TemplateInitial,
    )?;
    Ok(TemplateCreatePlan {
        slug,
        head_rel,
        templates_abs,
        root_abs,
        head_abs,
        schema_abs,
        batch,
    })
}

fn commit_create(
    space: &str,
    plan: TemplateCreatePlan,
    body: &str,
) -> Result<CreatedTemplate, PageError> {
    let paths = plan.batch.mutation_paths();
    let reverse_paths = paths
        .iter()
        .filter(|path| **path != plan.head_abs)
        .cloned()
        .collect::<Vec<_>>();
    let mut snapshot = SourceSnapshot::capture(&reverse_paths, None)?;
    let result = (|| -> Result<Vec<PathBuf>, PageError> {
        match fs::create_dir(&plan.templates_abs) {
            Ok(()) => snapshot.track_created_dir(plan.templates_abs.clone()),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let stage = tempfile::Builder::new()
            .prefix(".svode-template-")
            .tempdir_in(&plan.templates_abs)?;
        let staged_root = stage.path().join("template");
        fs::create_dir(&staged_root)?;
        let staged_head = staged_root.join(README_FILE);
        engine::apply_prepared_item_field_relations(&plan.batch)?;
        let meta = plan.batch.into_metadata();
        fs::write(&staged_head, frontmatter::serialize(&meta, body))?;
        if plan.schema_abs.is_some() {
            engine::write_default_collection_schema(
                space,
                &rel_from_abs(Path::new(space), &staged_root),
            )?;
        }
        let mut changed_paths = snapshot.changes()?;
        if plan.root_abs.symlink_metadata().is_ok() {
            return Err(PageError::FileAlreadyExists(plan.head_rel.clone()));
        }
        if plan.root_abs == plan.head_abs {
            fs::rename(staged_head, &plan.root_abs)?;
        } else {
            fs::rename(staged_root, &plan.root_abs)?;
        }
        changed_paths.push(plan.head_abs);
        changed_paths.extend(plan.schema_abs);
        changed_paths.sort();
        Ok(changed_paths)
    })();
    Ok(CreatedTemplate {
        slug: plan.slug,
        head_path: plan.head_rel,
        changed_paths: result.map_err(|error| snapshot.rollback(error))?,
    })
}

pub fn delete(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<DeletedTemplate, PageError> {
    ensure_path_in_space(space, collection_path)?;
    let source = resolve_template_source(space, collection_path, template_slug)?;
    if source.is_dir {
        fs::remove_dir_all(&source.root_abs)?;
    } else {
        fs::remove_file(&source.root_abs)?;
    }
    Ok(DeletedTemplate {
        title: source.title,
        root_path: rel_from_abs(Path::new(space), &source.root_abs),
    })
}

pub fn duplicate(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<DuplicatedTemplate, PageError> {
    ensure_path_in_space(space, collection_path)?;
    let source = resolve_template_source(space, collection_path, template_slug)?;
    let templates_abs = templates_dir(space, collection_path);
    let new_title = format!("{} (copy)", source.title);
    let new_slug = unique_template_slug(&templates_abs, &store::slugify(&new_title));

    let (dest_root, head_path) = if source.is_dir {
        let dest_root = templates_abs.join(&new_slug);
        copy_dir_recursive_all(&source.root_abs, &dest_root)?;
        let head_path = template_head_rel(collection_path, &new_slug, source.kind);
        (dest_root, head_path)
    } else {
        let dest = templates_abs.join(format!("{new_slug}.md"));
        fs::copy(&source.root_abs, &dest)?;
        let head_path = template_head_rel(collection_path, &new_slug, TemplateKind::Leaf);
        (dest, head_path)
    };

    let root_head = if source.is_dir {
        dest_root.join(README_FILE)
    } else {
        dest_root.clone()
    };
    let files = if source.is_dir {
        collect_md_files_all(&dest_root)?
    } else {
        vec![dest_root.clone()]
    };
    let documents = files
        .iter()
        .map(|path| Ok((path, read_markdown_doc(path)?)))
        .collect::<Result<Vec<_>, PageError>>()?;
    for (path, mut doc) in documents {
        if same_path(path, &root_head) {
            doc.meta.title = new_title.clone();
            doc.meta.mark_title_present();
        }
        fs::write(path, frontmatter::serialize(&doc.meta, &doc.body))?;
    }
    engine::rewrite_internal_relation_refs_for_copy(
        space,
        &rel_from_abs(Path::new(space), &source.root_abs),
        &rel_from_abs(Path::new(space), &dest_root),
    )?;

    Ok(DuplicatedTemplate {
        head_path,
        old_title: source.title,
        new_title,
    })
}

/// Selection made once for a create under its immediate parent.
pub enum TemplateSelection {
    Default,
    Specific(String),
    None,
}

pub(crate) enum PageTemplatePlan {
    Ordinary(Option<PageWarning>),
    Instantiate(Box<Instantiation>),
}

pub(crate) fn prepare_page_template(
    request: &PageCreate,
    selection: &TemplateSelection,
) -> Result<PageTemplatePlan, PageError> {
    crate::page::create::ensure_title(request)?;
    let scope = &request.space;
    let parent = request.parent_path.as_deref().unwrap_or_default().trim();
    ensure_path_in_space(scope, parent)?;
    let unavailable =
        || PageError::General("an explicit template requires a Collection parent".into());
    if matches!(selection, TemplateSelection::None) {
        return Ok(PageTemplatePlan::Ordinary(None));
    }
    let parent = match crate::page::create::resolve_page_parent(scope, parent)? {
        PageParent::Directory(parent) => parent,
        _ if matches!(selection, TemplateSelection::Specific(_)) => return Err(unavailable()),
        _ => return Ok(PageTemplatePlan::Ordinary(None)),
    };
    let schema_path = Path::new(scope).join(&parent).join("schema.yaml");
    let schema_rel = rel_from_abs(Path::new(scope), &schema_path);
    let has_schema = match fs::symlink_metadata(&schema_path) {
        Ok(metadata) => {
            ensure_path_in_space(scope, &schema_rel)?;
            if metadata.is_symlink() {
                return Err(PageError::PathNotAccessible(schema_rel));
            }
            metadata.is_file()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if !has_schema {
        if matches!(selection, TemplateSelection::Specific(_)) {
            return Err(unavailable());
        }
        return Ok(PageTemplatePlan::Ordinary(None));
    }
    let schema = engine::read_collection_schema(scope, &parent)?;
    let slug = match selection {
        TemplateSelection::Specific(slug) => slug.as_str(),
        TemplateSelection::Default => {
            let Some(slug) = schema
                .templates
                .as_ref()
                .and_then(|config| config.default.as_deref())
            else {
                return Ok(PageTemplatePlan::Ordinary(None));
            };
            slug
        }
        TemplateSelection::None => unreachable!(),
    };
    let Some(source) = engine::resolve_optional_template_source(scope, &parent, slug)? else {
        if matches!(selection, TemplateSelection::Specific(_)) {
            return Err(PageError::FileNotFound(format!("template '{slug}'")));
        }
        return Ok(PageTemplatePlan::Ordinary(Some(PageWarning {
            kind: "default_template_missing".into(),
            message: format!(
                "Default template '{slug}' is missing. Created the item without a template."
            ),
            path: Some(parent),
            ..PageWarning::default()
        })));
    };
    Ok(PageTemplatePlan::Instantiate(Box::new(
        Instantiation::prepare(
            scope,
            source,
            &parent,
            &request.title,
            request.allocate_unique_title,
            request.as_readme,
            &FrontmatterFields::new(),
            Some(request),
        )?,
    )))
}

pub fn instantiate(
    space: &str,
    collection_path: &str,
    template_slug: &str,
    parent_dir: &str,
    initial_title: Option<String>,
    allocate_unique_title: bool,
    force_folder: bool,
    contextual_defaults: Option<FrontmatterFields>,
) -> Result<InstantiatedTemplate, PageError> {
    ensure_path_in_space(space, collection_path)?;
    ensure_path_in_space(space, parent_dir)?;
    let collection_path = disk_spelling(space, collection_path);
    let parent_dir = disk_spelling(space, parent_dir);
    crate::page::naming::with_document_name_lock(space, || {
        let source = resolve_template_source(space, &collection_path, template_slug)?;
        let template_title = source.title.clone();
        let outcome = Instantiation::prepare(
            space,
            source,
            &parent_dir,
            initial_title.as_deref().unwrap_or_default(),
            allocate_unique_title,
            force_folder,
            &contextual_defaults.unwrap_or_default(),
            None,
        )?
        .apply(space)?;
        Ok(InstantiatedTemplate {
            page: outcome.page,
            template_title,
        })
    })
}

/// The existing Collection template copy, including its destination tree
/// and any order, counter and relation files it may update.
pub(crate) struct Instantiation {
    pub(crate) paths: Vec<PathBuf>,
    pub(crate) source: TemplateSource,
    parent_rel: String,
    dest: PathBuf,
    head_rel: String,
    tree: Vec<(PathBuf, bool)>,
    external_paths: Vec<PathBuf>,
    root_metadata: PageMeta,
    root_body: String,
    fields: Option<engine::PreparedItemFieldBatch>,
    projection: FilenameProjection,
    actual_projection: FilenameProjection,
}

impl Instantiation {
    fn prepare(
        space: &str,
        source: TemplateSource,
        parent_dir: &str,
        requested_title: &str,
        allocate_unique_title: bool,
        force_folder: bool,
        contextual_defaults: &FrontmatterFields,
        initial: Option<&PageCreate>,
    ) -> Result<Self, PageError> {
        let parent_rel = normalize_rel(parent_dir);
        let parent_abs = rel_abs(space, &parent_rel);
        if !parent_abs.is_dir() {
            return Err(PageError::FileNotFound(parent_rel));
        }

        let hierarchy = force_folder || source.is_dir;
        let probe_id = ulid::Ulid::new().to_string().to_lowercase();
        let probe_name = format!("svode-name-probe-{probe_id}");
        let scope_probe = if hierarchy {
            join_rel(&parent_rel, &format!("{probe_name}/{README_FILE}"))
        } else {
            join_rel(&parent_rel, &format!(".{probe_name}.md"))
        };
        let title = if allocate_unique_title {
            crate::page::naming::allocate_document_title(
                Path::new(space),
                &scope_probe,
                requested_title,
            )?
        } else {
            crate::page::naming::ensure_document_name_available(
                Path::new(space),
                &scope_probe,
                requested_title,
            )?;
            requested_title.to_string()
        };
        let projection = filename::project(&title);
        let (dest, actual_projection) = filename::allocate_available_path(
            &parent_abs,
            &projection,
            (!hierarchy).then_some("md"),
        )?;
        let head = if hierarchy {
            dest.join(README_FILE)
        } else {
            dest.clone()
        };
        let head_rel = rel_from_abs(Path::new(space), &head);
        let canonical_space = Path::new(space).canonicalize()?;
        let children = ChildSpaceRoots::read(&canonical_space)?;
        let mut tree = Vec::new();
        if source.is_dir {
            collect_instantiation_tree(
                Path::new(space),
                &canonical_space,
                &children,
                &source.root_abs,
                &source.root_abs,
                &mut tree,
            )?;
            if source.kind == TemplateKind::NestedCollection {
                engine::read_collection_schema(
                    space,
                    &rel_from_abs(Path::new(space), &source.root_abs),
                )?;
            }
        } else if hierarchy {
            tree.push((PathBuf::from(README_FILE), false));
        }
        let mut root = read_markdown_doc(&source.head_abs)?;
        root.meta.title = title.clone();
        root.meta.mark_title_present();
        engine::apply_schema_defaults_for_path(space, &head_rel, &mut root.meta)?;
        engine::apply_contextual_defaults_for_path_strict(
            space,
            &head_rel,
            &mut root.meta,
            contextual_defaults,
        )?;
        let mut fields = None;
        if let Some(initial) = initial {
            let values = initial_literal_fields(initial)?;
            if !values.is_empty() {
                // These relations belong to a new item, with no existing
                // reverse links to remove when it sets an explicit value.
                for key in values.keys() {
                    root.meta.extra.shift_remove(key);
                }
                fields = Some(engine::prepare_item_field_batch_from_metadata(
                    space,
                    initial.project.as_deref(),
                    &head_rel,
                    root.meta.clone(),
                    &values,
                    engine::ItemFieldBatchIntent::Literal,
                )?);
            }
            if let Some(body) = &initial.body {
                root.body = body.clone();
            }
        }

        let mut external_paths = vec![Path::new(space).join(".svode/order.json")];
        external_paths.extend(engine::unique_id_schema_path_for_item(space, &head_rel)?);
        if let Some(fields) = &fields {
            external_paths.extend(
                fields
                    .mutation_paths()
                    .iter()
                    .filter(|path| **path != head)
                    .cloned(),
            );
        }
        external_paths.sort();
        external_paths.dedup();
        let mut paths = external_paths.clone();
        paths.push(dest.clone());
        paths.extend(tree.iter().map(|(rel, _)| dest.join(rel)));
        for path in &paths {
            let relative = rel_from_abs(Path::new(space), path);
            if path.starts_with(&dest)
                && let Some(space_id) = children.owner_of(&relative)
            {
                return Err(PageError::PathInOtherSpace {
                    path: relative,
                    space_id: space_id.to_string(),
                });
            }
        }
        paths.sort();
        paths.dedup();
        Ok(Self {
            paths,
            source,
            parent_rel,
            dest,
            head_rel,
            tree,
            external_paths,
            root_metadata: root.meta,
            root_body: root.body,
            fields,
            projection,
            actual_projection,
        })
    }

    pub(crate) fn apply(mut self, space: &str) -> Result<PageCreateOutcome, PageError> {
        crate::git::access::ensure_mutation_paths_were_authorized(&self.paths)?;
        let mut snapshot = SourceSnapshot::capture(&self.external_paths, None)?;
        let result = (|| {
            let parent = rel_abs(space, &self.parent_rel);
            let stage = tempfile::Builder::new()
                .prefix(".svode-template-stage-")
                .tempdir_in(parent)?;
            let stage_root = stage.path().join("content");
            let hierarchy = !self.tree.is_empty();
            let stage_head = if hierarchy {
                fs::create_dir(&stage_root)?;
                for (rel, directory) in &self.tree {
                    let dest = stage_root.join(rel);
                    if *directory {
                        fs::create_dir(&dest)?;
                    } else if self.source.is_dir {
                        fs::copy(self.source.root_abs.join(rel), dest)?;
                    } else {
                        fs::copy(&self.source.head_abs, dest)?;
                    }
                }
                stage_root.join(README_FILE)
            } else {
                fs::copy(&self.source.head_abs, &stage_root)?;
                stage_root.clone()
            };

            if let Some(fields) = self.fields.take() {
                engine::apply_prepared_item_field_relations(&fields)?;
                self.root_metadata = fields.into_metadata();
            }
            engine::force_assign_unique_id_to_meta_for_path(
                space,
                &self.head_rel,
                &mut self.root_metadata,
            )?;
            fs::write(
                &stage_head,
                frontmatter::serialize(&self.root_metadata, &self.root_body),
            )?;
            if hierarchy {
                for path in collect_md_files_all(&stage_root)? {
                    if path != stage_head {
                        let doc = read_markdown_doc(&path)?;
                        fs::write(path, frontmatter::serialize(&doc.meta, &doc.body))?;
                    }
                }
            }
            // The planned destination can only be installed once. The
            // caller holds the name lock, plus repository guards for tools.
            if fs::symlink_metadata(&self.dest).is_ok() {
                return Err(PageError::FileAlreadyExists(rel_from_abs(
                    Path::new(space),
                    &self.dest,
                )));
            }
            fs::rename(&stage_root, &self.dest)?;
            if hierarchy {
                snapshot.track_created_dir(self.dest.clone());
                for (rel, directory) in &self.tree {
                    let path = self.dest.join(rel);
                    if *directory {
                        snapshot.track_created_dir(path);
                    } else {
                        snapshot.track_created(path);
                    }
                }
            } else {
                snapshot.track_created(self.dest.clone());
            }
            engine::rewrite_internal_relation_refs_for_copy(
                space,
                &rel_from_abs(Path::new(space), &self.source.root_abs),
                &rel_from_abs(Path::new(space), &self.dest),
            )?;
            append_order(
                Path::new(space),
                &self.parent_rel,
                &self.dest.file_name().unwrap_or_default().to_string_lossy(),
            )?;
            let mut page = store::read(space, &self.head_rel)?;
            page.warnings.extend(store::filename_allocation_warnings(
                &self.projection,
                &self.actual_projection,
                &self.head_rel,
            ));
            Ok(PageCreateOutcome {
                page,
                changed_paths: snapshot.changes()?,
            })
        })();
        result.map_err(|error| snapshot.rollback(error))
    }
}

fn collect_instantiation_tree(
    space: &Path,
    canonical_space: &Path,
    children: &ChildSpaceRoots,
    root: &Path,
    dir: &Path,
    out: &mut Vec<(PathBuf, bool)>,
) -> Result<(), PageError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let source_rel = rel_from_abs(space, &path);
        if let Some(space_id) = children.owner_of(&source_rel) {
            return Err(PageError::PathInOtherSpace {
                path: source_rel,
                space_id: space_id.to_string(),
            });
        }
        let kind = entry.file_type()?;
        let is_file = if kind.is_symlink() {
            // A file alias is resolved by the same boundary as inventory.
            // Directory aliases below the template root could cycle.
            let checked = template_path_in_space(canonical_space, children, &path)?;
            fs::metadata(checked)?.is_file()
        } else {
            kind.is_file()
        };
        if (!is_file && !kind.is_dir())
            || entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
        {
            return Err(PageError::PathNotAccessible(source_rel));
        }
        out.push((
            path.strip_prefix(root)
                .expect("directory entry must be below template root")
                .to_path_buf(),
            kind.is_dir(),
        ));
        if kind.is_dir() {
            collect_instantiation_tree(space, canonical_space, children, root, &path, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn template_create_rolls_back_reverse_relations_and_staging_when_a_write_fails() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_str().unwrap();
        let tasks = tmp.path().join("tasks");
        let people = tmp.path().join("people");
        fs::create_dir(&tasks).unwrap();
        fs::create_dir(&people).unwrap();
        fs::write(
            tasks.join("schema.yaml"),
            "columns:\n  - { name: A, type: relation, relation: people, two_way: TasksA }\n  - { name: Z, type: relation, relation: people, two_way: TasksZ }\nviews: []\n",
        )
        .unwrap();
        fs::write(
            people.join("schema.yaml"),
            "columns:\n  - { name: TasksA, type: relation, relation: tasks, two_way: A }\n  - { name: TasksZ, type: relation, relation: tasks, two_way: Z }\nviews: []\n",
        )
        .unwrap();
        let ada = "---\ntitle: Ada\n---\n";
        let zac = "---\ntitle: Zac\nTasksZ: 42\n---\n";
        fs::write(people.join("Ada.md"), ada).unwrap();
        fs::write(people.join("Zac.md"), zac).unwrap();
        let initial = TemplateInitialValues {
            content: Some("Close the loop".into()),
            icon: None,
            description: None,
            cover: None,
            properties: BTreeMap::from([
                ("A".into(), serde_json::json!(["Ada.md"])),
                ("Z".into(), serde_json::json!(["Zac.md"])),
            ]),
            project: None,
        };
        let planned = create_mutation_paths(
            space,
            "tasks",
            "Preset",
            TemplateKind::NestedCollection,
            Some(&initial),
        )
        .unwrap();
        assert!(planned.contains(&people.join("Ada.md")));
        assert!(planned.contains(&people.join("Zac.md")));
        let error = create(
            space,
            "tasks",
            "Preset",
            TemplateKind::NestedCollection,
            Some(&initial),
        )
        .err()
        .expect("invalid reverse field fails the mutation");
        assert!(error.to_string().contains("TasksZ"), "{error}");
        assert_eq!(fs::read_to_string(people.join("Ada.md")).unwrap(), ada);
        assert_eq!(fs::read_to_string(people.join("Zac.md")).unwrap(), zac);
        assert!(!tasks.join(".templates").exists());
    }

    #[cfg(unix)]
    #[test]
    fn template_create_refuses_linked_template_storage() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let space = tmp.path().to_str().unwrap();
        engine::write_default_collection_schema(space, "tasks").unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("tasks/.templates")).unwrap();
        let result = create(space, "tasks", "Preset", TemplateKind::Leaf, None);
        assert!(matches!(result, Err(PageError::PathNotAccessible(_))));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn template_create_refuses_a_linked_collection_schema_outside_the_space() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let space = tmp.path().to_str().unwrap();
        engine::write_default_collection_schema(outside.path().to_str().unwrap(), "tasks").unwrap();
        fs::create_dir(tmp.path().join("tasks")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("tasks/schema.yaml"),
            tmp.path().join("tasks/schema.yaml"),
        )
        .unwrap();
        let result = create(space, "tasks", "Preset", TemplateKind::Leaf, None);
        assert!(matches!(result, Err(PageError::PathNotAccessible(_))));
        assert!(!tmp.path().join("tasks/.templates").exists());
    }

    #[cfg(unix)]
    #[test]
    fn template_create_refuses_a_linked_relation_target_outside_its_space() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let space = tmp.path().to_str().unwrap();
        fs::create_dir(tmp.path().join("tasks")).unwrap();
        fs::write(
            tmp.path().join("tasks/schema.yaml"),
            "columns:\n  - { name: Owner, type: relation, relation: people, limit: one }\nviews: []\n",
        )
        .unwrap();
        engine::write_default_collection_schema(space, "people").unwrap();
        let person = outside.path().join("Ada.md");
        fs::write(&person, "---\ntitle: Ada\n---\n").unwrap();
        std::os::unix::fs::symlink(&person, tmp.path().join("people/Ada.md")).unwrap();
        let initial = TemplateInitialValues {
            content: None,
            icon: None,
            description: None,
            cover: None,
            properties: BTreeMap::from([("Owner".into(), serde_json::json!("Ada.md"))]),
            project: None,
        };
        let result = create(space, "tasks", "Preset", TemplateKind::Leaf, Some(&initial));
        assert!(matches!(result, Err(PageError::PathNotAccessible(_))));
        assert!(!tmp.path().join("tasks/.templates").exists());
    }

    #[test]
    fn template_instantiation_uses_collection_document_name_contract() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        fs::create_dir(tmp.path().join("collection")).unwrap();
        engine::write_default_collection_schema(&space, "collection").unwrap();
        create(&space, "collection", "Template", TemplateKind::Leaf, None).unwrap();
        store::create_with_options(&space, Some("collection"), "Shared", None, false, false)
            .unwrap();

        let conflict = instantiate(
            &space,
            "collection",
            "template",
            "collection",
            Some(" shared ".into()),
            false,
            false,
            None,
        );
        assert!(matches!(conflict, Err(PageError::DocumentNameConflict(_))));

        let allocated = instantiate(
            &space,
            "collection",
            "template",
            "collection",
            Some("Shared".into()),
            true,
            false,
            None,
        )
        .unwrap();
        assert_eq!(allocated.page.meta.title, "Shared 2");

        let unicode = instantiate(
            &space,
            "collection",
            "template",
            "collection",
            Some("日本語 Template 🚀".into()),
            false,
            false,
            None,
        )
        .unwrap();
        assert_eq!(unicode.page.path, "collection/日本語 Template 🚀.md");
        assert!(unicode.page.warnings.is_empty());
    }

    #[test]
    fn template_records_take_the_next_unique_id_and_replace_the_template_value() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy().to_string();
        fs::create_dir(tmp.path().join("tasks")).unwrap();
        fs::write(
            tmp.path().join("tasks/schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: TASK, next: 5 }\nviews: []\n",
        )
        .unwrap();
        create(&space, "tasks", "Note", TemplateKind::Leaf, None).unwrap();
        create(&space, "tasks", "Kickoff", TemplateKind::Folder, None).unwrap();
        fs::write(
            tmp.path().join("tasks/.templates/kickoff/agenda.md"),
            "---\ntitle: Agenda\n---\nAgenda body",
        )
        .unwrap();
        create(&space, "tasks", "Preset", TemplateKind::Leaf, None).unwrap();
        let preset = tmp.path().join("tasks/.templates/preset.md");
        let mut preset_doc = read_markdown_doc(&preset).unwrap();
        preset_doc
            .meta
            .extra
            .insert("Key".into(), serde_norway::Value::Number(42.into()));
        fs::write(&preset, frontmatter::serialize(&preset_doc.meta, "")).unwrap();

        let key = |page: &Page| page.meta.extra.get("Key").cloned();
        let number = |value: u64| Some(serde_norway::Value::Number(value.into()));
        let note = instantiate(
            &space,
            "tasks",
            "note",
            "tasks",
            Some("Note".into()),
            true,
            false,
            None,
        )
        .unwrap();
        assert_eq!(key(&note.page), number(5));
        let kickoff = instantiate(
            &space,
            "tasks",
            "kickoff",
            "tasks",
            Some("Kickoff".into()),
            true,
            false,
            None,
        )
        .unwrap();
        assert_eq!(kickoff.page.path, "tasks/Kickoff/README.md");
        assert_eq!(key(&kickoff.page), number(6));
        let agenda = store::read(&space, "tasks/Kickoff/agenda.md").unwrap();
        assert!(!agenda.meta.extra.contains_key("Key"));
        let preset = instantiate(
            &space,
            "tasks",
            "preset",
            "tasks",
            Some("Preset".into()),
            true,
            false,
            None,
        )
        .unwrap();
        assert_eq!(key(&preset.page), number(7));
        let forced = instantiate(
            &space,
            "tasks",
            "note",
            "tasks",
            Some("Forced".into()),
            true,
            true,
            None,
        )
        .unwrap();
        assert_eq!(forced.page.path, "tasks/Forced/README.md");
        assert_eq!(key(&forced.page), number(8));

        let next = engine::read_collection_schema(&space, "tasks")
            .unwrap()
            .columns
            .into_iter()
            .find(|column| column.name == "Key")
            .and_then(|column| column.next);
        assert_eq!(next, Some(9));
        let template = store::read(&space, "tasks/.templates/preset.md").unwrap();
        assert_eq!(key(&template), number(42));

        fs::create_dir(tmp.path().join("notes")).unwrap();
        engine::write_default_collection_schema(&space, "notes").unwrap();
        create(&space, "notes", "Plain", TemplateKind::Leaf, None).unwrap();
        let schema_before = fs::read(tmp.path().join("notes/schema.yaml")).unwrap();
        let plain = instantiate(
            &space,
            "notes",
            "plain",
            "notes",
            Some("Plain".into()),
            true,
            false,
            None,
        )
        .unwrap();
        assert!(!plain.page.meta.extra.contains_key("Key"));
        assert_eq!(
            fs::read(tmp.path().join("notes/schema.yaml")).unwrap(),
            schema_before
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_template_record_keeps_the_unique_id_counter() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy().to_string();
        fs::create_dir(tmp.path().join("tasks")).unwrap();
        let schema_path = tmp.path().join("tasks/schema.yaml");
        fs::write(
            &schema_path,
            "columns:\n  - { name: Key, type: unique_id, next: 5 }\nviews: []\n",
        )
        .unwrap();
        create(&space, "tasks", "Note", TemplateKind::Leaf, None).unwrap();
        // The copied record keeps the template's mode, so writing it fails
        // after its number was allocated.
        let template = tmp.path().join("tasks/.templates/note.md");
        fs::set_permissions(&template, fs::Permissions::from_mode(0o444)).unwrap();
        let before = fs::read(&schema_path).unwrap();

        let failed = instantiate(
            &space,
            "tasks",
            "note",
            "tasks",
            Some("Note".into()),
            true,
            false,
            None,
        );
        assert!(failed.is_err());
        assert_eq!(fs::read(&schema_path).unwrap(), before);
    }

    #[test]
    fn prepared_template_config_validates_inventory_and_reports_actual_changes() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy().to_string();
        fs::create_dir(tmp.path().join("collection")).unwrap();
        engine::write_default_collection_schema(&space, "collection").unwrap();
        create(&space, "collection", "Template", TemplateKind::Leaf, None).unwrap();
        let schema_path = tmp.path().join("collection/schema.yaml");

        let selected = prepare_set_default(&space, "collection", Some("template".to_string()))
            .unwrap()
            .apply()
            .unwrap();
        assert_eq!(selected.changed_paths, [schema_path.clone()]);
        let unchanged = prepare_set_default(&space, "collection", Some("template".to_string()))
            .unwrap()
            .apply()
            .unwrap();
        assert!(unchanged.changed_paths.is_empty());

        let reordered = prepare_reorder(&space, "collection", vec!["template".to_string()])
            .unwrap()
            .apply()
            .unwrap();
        assert_eq!(reordered.changed_paths, [schema_path.clone()]);

        let before = fs::read(&schema_path).unwrap();
        assert!(prepare_set_default(&space, "collection", Some("missing".to_string())).is_err());
        assert!(prepare_reorder(&space, "collection", vec!["missing".to_string()]).is_err());
        assert_eq!(fs::read(schema_path).unwrap(), before);
    }
}

fn read_markdown_doc(path: &Path) -> Result<MarkdownDoc, PageError> {
    let raw = fs::read_to_string(path)?;
    let (meta, body) = match frontmatter::try_parse(&raw)? {
        Some((meta, body)) => (meta, body),
        None => {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled");
            (PageMeta::new_persisted(humanize_slug(stem)), raw)
        }
    };
    Ok(MarkdownDoc { meta, body })
}

fn unique_template_slug(templates_abs: &Path, base_slug: &str) -> String {
    for i in 0..=1000 {
        let candidate = if i == 0 {
            base_slug.to_string()
        } else {
            format!("{base_slug}-{i}")
        };
        if templates_abs
            .join(format!("{candidate}.md"))
            .symlink_metadata()
            .is_err()
            && templates_abs.join(&candidate).symlink_metadata().is_err()
        {
            return candidate;
        }
    }
    format!(
        "{base_slug}-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    )
}

fn copy_dir_recursive_all(source: &Path, dest: &Path) -> Result<(), PageError> {
    fs::create_dir_all(dest)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let source_path = item.path();
        let dest_path = dest.join(item.file_name());
        if source_path.is_dir() {
            copy_dir_recursive_all(&source_path, &dest_path)?;
        } else {
            fs::copy(&source_path, &dest_path)?;
        }
    }
    Ok(())
}

fn collect_md_files_all(root: &Path) -> Result<Vec<PathBuf>, PageError> {
    let mut files = Vec::new();
    collect_md_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_md_files_inner(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), PageError> {
    if path.is_file() {
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path.to_path_buf());
        }
        return Ok(());
    }
    for item in fs::read_dir(path)? {
        let item = item?;
        collect_md_files_inner(&item.path(), out)?;
    }
    Ok(())
}

fn append_order(space: &Path, parent_rel: &str, name: &str) -> Result<(), PageError> {
    let key = if parent_rel.is_empty() || parent_rel == "." {
        ".".to_string()
    } else {
        parent_rel.to_string()
    };
    content_tree::update_order(space, |order| {
        let items = order.children_mut(&key);
        if items.iter().any(|item| item == name) {
            return false;
        }
        items.push(name.to_string());
        true
    })?;
    Ok(())
}

fn rel_from_abs(space: &Path, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b
        || fs::canonicalize(a)
            .ok()
            .zip(fs::canonicalize(b).ok())
            .is_some_and(|(a, b)| a == b)
}
