use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yml::Value;

use crate::error::AppError;
use crate::files::entry::{self, Entry, EntryMeta};
use crate::files::{frontmatter, tree};
use crate::properties::{self, CollectionSchema};

const TEMPLATES_DIR: &str = ".templates";
const README_FILE: &str = "README.md";
const SCHEMA_FILE: &str = "schema.yaml";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateKind {
    Leaf,
    Folder,
    NestedCollection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub slug: String,
    pub kind: TemplateKind,
    pub title: String,
    pub icon: Option<String>,
    pub is_default: bool,
}

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

struct TemplateSource {
    kind: TemplateKind,
    title: String,
    head_abs: PathBuf,
    root_abs: PathBuf,
    is_dir: bool,
}

struct MarkdownDoc {
    path: PathBuf,
    old_id: String,
    meta: EntryMeta,
    body: String,
}

pub fn list(space: &str, collection_path: &str) -> Result<Vec<TemplateInfo>, AppError> {
    let schema = properties::read_collection_schema(space, collection_path)?;
    let templates_abs = templates_dir(space, collection_path);
    if !templates_abs.is_dir() {
        return Ok(Vec::new());
    }

    let mut infos = Vec::new();
    for item in fs::read_dir(&templates_abs)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        if path.is_file() {
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            let Some(slug) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if let Ok(info) = template_info_from_head(&schema, slug, TemplateKind::Leaf, &path) {
                infos.push(info);
            }
        } else if path.is_dir() {
            let head = path.join(README_FILE);
            if !head.is_file() {
                continue;
            }
            let kind = if path.join(SCHEMA_FILE).is_file() {
                TemplateKind::NestedCollection
            } else {
                TemplateKind::Folder
            };
            if let Ok(info) = template_info_from_head(&schema, &name, kind, &head) {
                infos.push(info);
            }
        }
    }

    sort_templates(&mut infos, &schema);
    Ok(infos)
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
    let now = now_rfc3339();

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

    let mut meta = EntryMeta {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        title: title.to_string(),
        icon: None,
        description: None,
        cover: None,
        created: now.clone(),
        updated: now,
        extra: HashMap::new(),
    };
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

    let root_title = initial_title.unwrap_or_default();
    let root_slug_source = if root_title.trim().is_empty() {
        "untitled"
    } else {
        root_title.as_str()
    };
    let root_slug = entry::slugify(root_slug_source);
    let hierarchy = force_folder || source.is_dir;
    let dest_root_abs = if hierarchy {
        unique_child_path(&parent_abs, &root_slug, None)
    } else {
        unique_child_path(&parent_abs, &root_slug, Some("md"))
    };
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

    Ok(InstantiatedTemplate {
        entry: entry::read(space, &head_rel)?,
        template_title: source.title,
    })
}

pub fn ensure_template_exists(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<TemplateInfo, AppError> {
    let source = resolve_template_source(space, collection_path, template_slug)?;
    let schema = properties::read_collection_schema(space, collection_path)?;
    template_info_from_head(&schema, template_slug, source.kind, &source.head_abs)
}

pub fn validate_template_order(
    space: &str,
    collection_path: &str,
    new_order: &[String],
) -> Result<(), AppError> {
    let templates = list(space, collection_path)?;
    if new_order.len() != templates.len() {
        return Err(AppError::General(
            "template order must include every template exactly once".to_string(),
        ));
    }

    let slugs: HashSet<&str> = templates
        .iter()
        .map(|template| template.slug.as_str())
        .collect();
    let mut seen = HashSet::new();
    for slug in new_order {
        if !seen.insert(slug.as_str()) {
            return Err(AppError::General(format!(
                "duplicate template in order '{slug}'"
            )));
        }
        if !slugs.contains(slug.as_str()) {
            return Err(AppError::FileNotFound(format!("template '{slug}'")));
        }
    }
    Ok(())
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

fn resolve_template_source(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<TemplateSource, AppError> {
    let templates_abs = templates_dir(space, collection_path);
    let leaf = templates_abs.join(format!("{template_slug}.md"));
    if leaf.is_file() {
        let (title, _) = read_template_head(&leaf, template_slug)?;
        return Ok(TemplateSource {
            kind: TemplateKind::Leaf,
            title,
            head_abs: leaf.clone(),
            root_abs: leaf,
            is_dir: false,
        });
    }

    let root = templates_abs.join(template_slug);
    let head = root.join(README_FILE);
    if root.is_dir() && head.is_file() {
        let kind = if root.join(SCHEMA_FILE).is_file() {
            TemplateKind::NestedCollection
        } else {
            TemplateKind::Folder
        };
        let (title, _) = read_template_head(&head, template_slug)?;
        return Ok(TemplateSource {
            kind,
            title,
            head_abs: head,
            root_abs: root,
            is_dir: true,
        });
    }

    Err(AppError::FileNotFound(format!(
        "template '{template_slug}'"
    )))
}

fn template_info_from_head(
    schema: &CollectionSchema,
    slug: &str,
    kind: TemplateKind,
    head: &Path,
) -> Result<TemplateInfo, AppError> {
    let (title, icon) = read_template_head(head, slug)?;
    let is_default = schema
        .templates
        .as_ref()
        .and_then(|templates| templates.default.as_deref())
        == Some(slug);
    Ok(TemplateInfo {
        slug: slug.to_string(),
        kind,
        title,
        icon,
        is_default,
    })
}

fn read_template_head(head: &Path, slug: &str) -> Result<(String, Option<String>), AppError> {
    let raw = fs::read_to_string(head)?;
    match frontmatter::try_parse(&raw) {
        Ok(Some((meta, _))) => Ok((meta.title, meta.icon)),
        Ok(None) => Ok((humanize_slug(slug), None)),
        Err(_) => Err(AppError::FrontmatterParse(format!(
            "invalid template frontmatter: {}",
            head.display()
        ))),
    }
}

fn sort_templates(infos: &mut Vec<TemplateInfo>, schema: &CollectionSchema) {
    infos.sort_by(|a, b| {
        a.slug
            .to_lowercase()
            .cmp(&b.slug.to_lowercase())
            .then_with(|| a.slug.cmp(&b.slug))
    });
    let Some(order) = schema
        .templates
        .as_ref()
        .and_then(|templates| templates.order.as_ref())
    else {
        return;
    };
    let positions: HashMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(idx, slug)| (slug.as_str(), idx))
        .collect();
    infos.sort_by(|a, b| {
        match (
            positions.get(a.slug.as_str()),
            positions.get(b.slug.as_str()),
        ) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a
                .slug
                .to_lowercase()
                .cmp(&b.slug.to_lowercase())
                .then_with(|| a.slug.cmp(&b.slug)),
        }
    });
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
    let mut id_map = HashMap::new();
    for path in files {
        let doc = read_markdown_doc(path)?;
        let new_id = ulid::Ulid::new().to_string().to_lowercase();
        id_map.insert(doc.old_id.clone(), new_id);
        docs.push(doc);
    }

    let now = now_rfc3339();
    for doc in &mut docs {
        let is_root = root_head.is_some_and(|head| same_path(head, &doc.path));
        if let Some(new_id) = id_map.get(&doc.old_id) {
            doc.meta.id = new_id.clone();
        }
        doc.meta.created = now.clone();
        doc.meta.updated = now.clone();
        replace_ids_in_meta(&mut doc.meta, &id_map);

        if is_root {
            if let Some(title) = root_title {
                doc.meta.title = title.to_string();
            } else if let Some(suffix) = title_suffix {
                doc.meta.title.push_str(suffix);
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
            let now = now_rfc3339();
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled");
            (
                EntryMeta {
                    id: ulid::Ulid::new().to_string().to_lowercase(),
                    title: humanize_slug(stem),
                    icon: None,
                    description: None,
                    cover: None,
                    created: now.clone(),
                    updated: now,
                    extra: HashMap::new(),
                },
                raw,
            )
        }
    };
    let old_id = meta.id.clone();
    Ok(MarkdownDoc {
        path: path.to_path_buf(),
        old_id,
        meta,
        body,
    })
}

fn replace_ids_in_meta(meta: &mut EntryMeta, id_map: &HashMap<String, String>) {
    for value in meta.extra.values_mut() {
        replace_ids_in_value(value, id_map);
    }
}

fn replace_ids_in_value(value: &mut Value, id_map: &HashMap<String, String>) {
    match value {
        Value::String(current) => {
            if let Some(next) = id_map.get(current) {
                *current = next.clone();
            }
        }
        Value::Sequence(items) => {
            for item in items {
                replace_ids_in_value(item, id_map);
            }
        }
        Value::Mapping(mapping) => {
            for item in mapping.values_mut() {
                replace_ids_in_value(item, id_map);
            }
        }
        _ => {}
    }
}

fn validate_contextual_defaults(
    space: &str,
    head_rel: &str,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<(), AppError> {
    let mut meta = EntryMeta {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        title: String::new(),
        icon: None,
        description: None,
        cover: None,
        created: String::new(),
        updated: String::new(),
        extra: HashMap::new(),
    };
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

fn unique_child_path(parent: &Path, stem: &str, extension: Option<&str>) -> PathBuf {
    let make = |candidate: &str| match extension {
        Some(ext) => parent.join(format!("{candidate}.{ext}")),
        None => parent.join(candidate),
    };
    for i in 0..=1000 {
        let candidate = if i == 0 {
            stem.to_string()
        } else {
            format!("{stem}-{i}")
        };
        let path = make(&candidate);
        if !path.exists() {
            return path;
        }
    }
    make(&format!(
        "{stem}-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    ))
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

fn templates_dir(space: &str, collection_path: &str) -> PathBuf {
    rel_abs(space, &join_rel(collection_path, TEMPLATES_DIR))
}

fn template_head_rel(collection_path: &str, slug: &str, kind: TemplateKind) -> String {
    match kind {
        TemplateKind::Leaf => join_rel(collection_path, &format!("{TEMPLATES_DIR}/{slug}.md")),
        TemplateKind::Folder | TemplateKind::NestedCollection => join_rel(
            collection_path,
            &format!("{TEMPLATES_DIR}/{slug}/{README_FILE}"),
        ),
    }
}

fn join_rel(base: &str, child: &str) -> String {
    let base = normalize_rel(base);
    if base.is_empty() || base == "." {
        child.to_string()
    } else {
        format!("{base}/{child}")
    }
}

fn rel_abs(space: &str, rel: &str) -> PathBuf {
    let rel = normalize_rel(rel);
    if rel.is_empty() || rel == "." {
        PathBuf::from(space)
    } else {
        Path::new(space).join(rel)
    }
}

fn normalize_rel(path: &str) -> String {
    let normalized = path
        .trim_matches('/')
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string();
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn rel_from_abs(space: &Path, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn humanize_slug(slug: &str) -> String {
    let mut chars = slug.replace(['-', '_'], " ").chars().collect::<Vec<_>>();
    if let Some(first) = chars.first_mut() {
        first.make_ascii_uppercase();
    }
    chars.into_iter().collect()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b
        || fs::canonicalize(a)
            .ok()
            .zip(fs::canonicalize(b).ok())
            .is_some_and(|(a, b)| a == b)
}
