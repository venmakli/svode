use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_yml::Value;

use crate::error::AppError;
use crate::files::entry::{self, Entry, EntryMeta};
use crate::files::{filename, frontmatter, tree};
use crate::properties;

use svode_core::collections::engine::{
    README_FILE, TEMPLATES_DIR, TemplateSource, humanize_template_slug as humanize_slug,
    join_template_rel as join_rel, normalize_template_rel as normalize_rel,
    resolve_template_source, template_head_rel, template_rel_abs as rel_abs, templates_dir,
};
pub use svode_core::collections::engine::{
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
    pub entry: Entry,
    pub template_title: String,
}

struct MarkdownDoc {
    path: PathBuf,
    meta: EntryMeta,
    body: String,
}

pub fn create(
    space: &str,
    collection_path: &str,
    title: &str,
    kind: TemplateKind,
) -> Result<String, AppError> {
    properties::read_collection_schema(space, collection_path)?;
    let templates_abs = templates_dir(space, collection_path);
    fs::create_dir_all(&templates_abs)?;

    let base_slug = entry::slugify(title);
    let slug = unique_template_slug(&templates_abs, &base_slug);
    let (head_abs, head_rel) = match kind {
        TemplateKind::Leaf => {
            let rel = template_head_rel(collection_path, &slug, TemplateKind::Leaf);
            (templates_abs.join(format!("{slug}.md")), rel)
        }
        TemplateKind::Folder | TemplateKind::NestedCollection => {
            let root = templates_abs.join(&slug);
            fs::create_dir_all(&root)?;
            let rel = template_head_rel(collection_path, &slug, kind);
            (root.join(README_FILE), rel)
        }
    };

    let mut meta = EntryMeta::new_persisted(title.to_string());
    properties::apply_schema_defaults_for_path(space, &head_rel, &mut meta)?;
    fs::write(&head_abs, frontmatter::serialize(&meta, ""))?;

    if kind == TemplateKind::NestedCollection {
        let template_collection = join_rel(collection_path, &format!("{TEMPLATES_DIR}/{slug}"));
        properties::write_default_collection_schema(space, &template_collection)?;
    }

    Ok(head_rel)
}

pub fn delete(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<DeletedTemplate, AppError> {
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
) -> Result<DuplicatedTemplate, AppError> {
    let source = resolve_template_source(space, collection_path, template_slug)?;
    let templates_abs = templates_dir(space, collection_path);
    let new_title = format!("{} (copy)", source.title);
    let new_slug = unique_template_slug(&templates_abs, &entry::slugify(&new_title));

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
    rewrite_markdown_identities(&files, Some(&root_head), Some(&new_title), None, None, None)?;
    properties::rewrite_internal_relation_refs_for_copy(
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

pub fn instantiate(
    space: &str,
    collection_path: &str,
    template_slug: &str,
    parent_dir: &str,
    initial_title: Option<String>,
    allocate_unique_title: bool,
    force_folder: bool,
    contextual_defaults: Option<HashMap<String, Value>>,
) -> Result<InstantiatedTemplate, AppError> {
    crate::files::naming::with_document_name_lock(space, || {
        instantiate_inner(
            space,
            collection_path,
            template_slug,
            parent_dir,
            initial_title,
            allocate_unique_title,
            force_folder,
            contextual_defaults,
        )
    })
}

fn instantiate_inner(
    space: &str,
    collection_path: &str,
    template_slug: &str,
    parent_dir: &str,
    initial_title: Option<String>,
    allocate_unique_title: bool,
    force_folder: bool,
    contextual_defaults: Option<HashMap<String, Value>>,
) -> Result<InstantiatedTemplate, AppError> {
    let source = resolve_template_source(space, collection_path, template_slug)?;
    let contextual_defaults = contextual_defaults.unwrap_or_default();
    let parent_rel = normalize_rel(parent_dir);
    let parent_abs = rel_abs(space, &parent_rel);
    if !parent_abs.is_dir() {
        return Err(AppError::FileNotFound(parent_rel));
    }

    let hierarchy = force_folder || source.is_dir;
    let requested_title = initial_title.unwrap_or_default();
    let probe_id = ulid::Ulid::new().to_string().to_lowercase();
    let scope_probe = if hierarchy {
        join_rel(
            &parent_rel,
            &format!("svode-name-probe-{probe_id}/README.md"),
        )
    } else {
        join_rel(&parent_rel, &format!(".svode-name-probe-{probe_id}.md"))
    };
    let root_title = if allocate_unique_title {
        crate::files::naming::allocate_document_title(
            Path::new(space),
            &scope_probe,
            &requested_title,
        )?
    } else {
        crate::files::naming::ensure_document_name_available(
            Path::new(space),
            &scope_probe,
            &requested_title,
        )?;
        requested_title
    };
    let projection = filename::project(&root_title);
    let (dest_root_abs, actual_projection) =
        filename::allocate_available_path(&parent_abs, &projection, (!hierarchy).then_some("md"))?;
    let head_abs = if hierarchy {
        dest_root_abs.join(README_FILE)
    } else {
        dest_root_abs.clone()
    };
    let head_rel = rel_from_abs(Path::new(space), &head_abs);

    validate_contextual_defaults(space, &head_rel, &contextual_defaults)?;

    if hierarchy {
        instantiate_hierarchy(
            space,
            &source,
            &dest_root_abs,
            &head_abs,
            &head_rel,
            &root_title,
            &contextual_defaults,
        )?;
        append_order(
            Path::new(space),
            &parent_rel,
            &dest_root_abs
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
        );
    } else {
        fs::copy(&source.head_abs, &head_abs)?;
        rewrite_markdown_identities(
            &[head_abs.clone()],
            Some(&head_abs),
            Some(&root_title),
            Some((space, head_rel.as_str())),
            Some(&contextual_defaults),
            None,
        )?;
        properties::rewrite_internal_relation_refs_for_copy(
            space,
            &rel_from_abs(Path::new(space), &source.root_abs),
            &rel_from_abs(Path::new(space), &head_abs),
        )?;
        append_order(
            Path::new(space),
            &parent_rel,
            &head_abs.file_name().unwrap_or_default().to_string_lossy(),
        );
    }

    let mut entry = entry::read(space, &head_rel)?;
    entry.warnings.extend(entry::filename_allocation_warnings(
        &projection,
        &actual_projection,
        &head_rel,
    ));
    Ok(InstantiatedTemplate {
        entry,
        template_title: source.title,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn template_instantiation_uses_collection_document_name_contract() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        fs::create_dir(tmp.path().join("collection")).unwrap();
        properties::write_default_collection_schema(&space, "collection").unwrap();
        create(&space, "collection", "Template", TemplateKind::Leaf).unwrap();
        entry::create_with_options(&space, Some("collection"), "Shared", None, false, false)
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
        assert!(matches!(conflict, Err(AppError::DocumentNameConflict(_))));

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
        assert_eq!(allocated.entry.meta.title, "Shared 2");

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
        assert_eq!(unicode.entry.path, "collection/日本語 Template 🚀.md");
        assert!(unicode.entry.warnings.is_empty());
    }

    #[test]
    fn prepared_template_config_validates_inventory_and_reports_actual_changes() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy().to_string();
        fs::create_dir(tmp.path().join("collection")).unwrap();
        properties::write_default_collection_schema(&space, "collection").unwrap();
        create(&space, "collection", "Template", TemplateKind::Leaf).unwrap();
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

fn instantiate_hierarchy(
    space: &str,
    source: &TemplateSource,
    dest_root_abs: &Path,
    head_abs: &Path,
    head_rel: &str,
    root_title: &str,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<(), AppError> {
    let stage_root = create_stage_dir()?.join(
        dest_root_abs
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .as_ref(),
    );
    let result = (|| {
        if source.is_dir {
            copy_dir_recursive_all(&source.root_abs, &stage_root)?;
        } else {
            fs::create_dir_all(&stage_root)?;
            fs::copy(&source.head_abs, stage_root.join(README_FILE))?;
        }

        let files = collect_md_files_all(&stage_root)?;
        let staged_head = stage_root.join(README_FILE);
        rewrite_markdown_identities(
            &files,
            Some(&staged_head),
            Some(root_title),
            Some((space, head_rel)),
            Some(contextual_defaults),
            None,
        )?;

        if let Some(parent) = dest_root_abs.parent() {
            if !parent.is_dir() {
                return Err(AppError::FileNotFound(parent.to_string_lossy().to_string()));
            }
        }
        fs::rename(&stage_root, dest_root_abs)?;
        properties::rewrite_internal_relation_refs_for_copy(
            space,
            &rel_from_abs(Path::new(space), &source.root_abs),
            &rel_from_abs(Path::new(space), dest_root_abs),
        )?;
        Ok(())
    })();

    if let Some(stage_parent) = stage_root.parent() {
        let _ = fs::remove_dir_all(stage_parent);
    }
    if result.is_err() && head_abs.exists() {
        let _ = fs::remove_file(head_abs);
    }
    result
}

fn rewrite_markdown_identities(
    files: &[PathBuf],
    root_head: Option<&Path>,
    root_title: Option<&str>,
    root_schema_path: Option<(&str, &str)>,
    contextual_defaults: Option<&HashMap<String, Value>>,
    title_suffix: Option<&str>,
) -> Result<(), AppError> {
    let mut docs = Vec::new();
    for path in files {
        let doc = read_markdown_doc(path)?;
        docs.push(doc);
    }

    for doc in &mut docs {
        let is_root = root_head.is_some_and(|head| same_path(head, &doc.path));

        if is_root {
            if let Some(title) = root_title {
                doc.meta.title = title.to_string();
                doc.meta.mark_title_present();
            } else if let Some(suffix) = title_suffix {
                doc.meta.title.push_str(suffix);
                doc.meta.mark_title_present();
            }
            if let Some((space, rel_path)) = root_schema_path {
                properties::apply_schema_defaults_for_path(space, rel_path, &mut doc.meta)?;
                if let Some(defaults) = contextual_defaults {
                    properties::apply_contextual_defaults_for_path_strict(
                        space,
                        rel_path,
                        &mut doc.meta,
                        defaults,
                    )?;
                }
            }
        }

        fs::write(&doc.path, frontmatter::serialize(&doc.meta, &doc.body))?;
    }

    Ok(())
}

fn read_markdown_doc(path: &Path) -> Result<MarkdownDoc, AppError> {
    let raw = fs::read_to_string(path)?;
    let (meta, body) = match frontmatter::try_parse(&raw)? {
        Some((meta, body)) => (meta, body),
        None => {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled");
            (EntryMeta::new_persisted(humanize_slug(stem)), raw)
        }
    };
    Ok(MarkdownDoc {
        path: path.to_path_buf(),
        meta,
        body,
    })
}

fn validate_contextual_defaults(
    space: &str,
    head_rel: &str,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<(), AppError> {
    let mut meta = EntryMeta::new_persisted("");
    properties::apply_contextual_defaults_for_path_strict(
        space,
        head_rel,
        &mut meta,
        contextual_defaults,
    )?;
    Ok(())
}

fn unique_template_slug(templates_abs: &Path, base_slug: &str) -> String {
    for i in 0..=1000 {
        let candidate = if i == 0 {
            base_slug.to_string()
        } else {
            format!("{base_slug}-{i}")
        };
        if !templates_abs.join(format!("{candidate}.md")).exists()
            && !templates_abs.join(&candidate).exists()
        {
            return candidate;
        }
    }
    format!(
        "{base_slug}-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    )
}

fn copy_dir_recursive_all(source: &Path, dest: &Path) -> Result<(), AppError> {
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

fn collect_md_files_all(root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    collect_md_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_md_files_inner(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
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

fn create_stage_dir() -> Result<PathBuf, AppError> {
    let path = std::env::temp_dir().join(format!(
        "svode-template-stage-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    ));
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn append_order(space: &Path, parent_rel: &str, name: &str) {
    let key = if parent_rel.is_empty() || parent_rel == "." {
        ".".to_string()
    } else {
        parent_rel.to_string()
    };
    let mut order = tree::read_order(space);
    let items = order.entry(key).or_default();
    if !items.iter().any(|item| item == name) {
        items.push(name.to_string());
        let _ = tree::write_order(space, &order);
    }
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
