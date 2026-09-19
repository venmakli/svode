//! File-backed Collection template inventory and default/order configuration.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    CollectionError, CollectionSchema, PreparedCollectionMutation, read_collection_schema,
    reorder_templates, schema_mutation_paths, set_default_template,
};
use crate::page::frontmatter;

pub const TEMPLATES_DIR: &str = ".templates";
pub const README_FILE: &str = "README.md";
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

/// Resolved file-backed template head/root inside a Collection.
pub struct TemplateSource {
    pub kind: TemplateKind,
    pub title: String,
    pub head_abs: PathBuf,
    pub root_abs: PathBuf,
    pub is_dir: bool,
}

pub fn list_templates(
    space: &str,
    collection_path: &str,
) -> Result<Vec<TemplateInfo>, CollectionError> {
    let schema = read_collection_schema(space, collection_path)?;
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

pub fn ensure_template_exists(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<TemplateInfo, CollectionError> {
    let source = resolve_template_source(space, collection_path, template_slug)?;
    let schema = read_collection_schema(space, collection_path)?;
    template_info_from_head(&schema, template_slug, source.kind, &source.head_abs)
}

pub fn validate_template_order(
    space: &str,
    collection_path: &str,
    new_order: &[String],
) -> Result<(), CollectionError> {
    let templates = list_templates(space, collection_path)?;
    if new_order.len() != templates.len() {
        return Err(CollectionError::General(
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
            return Err(CollectionError::General(format!(
                "duplicate template in order '{slug}'"
            )));
        }
        if !slugs.contains(slug.as_str()) {
            return Err(CollectionError::FileNotFound(format!("template '{slug}'")));
        }
    }
    Ok(())
}

pub fn prepare_set_default_template(
    space: &str,
    collection_path: &str,
    template_slug: Option<String>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    if let Some(template_slug) = template_slug.as_deref() {
        ensure_template_exists(space, collection_path, template_slug)?;
    }
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        set_default_template(&space, &collection_path, template_slug.as_deref())
    }))
}

pub fn prepare_reorder_templates(
    space: &str,
    collection_path: &str,
    new_order: Vec<String>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    validate_template_order(space, collection_path, &new_order)?;
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        reorder_templates(&space, &collection_path, new_order)
    }))
}

pub fn resolve_template_source(
    space: &str,
    collection_path: &str,
    template_slug: &str,
) -> Result<TemplateSource, CollectionError> {
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

    Err(CollectionError::FileNotFound(format!(
        "template '{template_slug}'"
    )))
}

fn template_info_from_head(
    schema: &CollectionSchema,
    slug: &str,
    kind: TemplateKind,
    head: &Path,
) -> Result<TemplateInfo, CollectionError> {
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

fn read_template_head(
    head: &Path,
    slug: &str,
) -> Result<(String, Option<String>), CollectionError> {
    let raw = fs::read_to_string(head)?;
    match frontmatter::try_parse(&raw) {
        Ok(Some((meta, _))) => {
            let title = if meta.frontmatter_keys.title {
                meta.title
            } else {
                humanize_template_slug(slug)
            };
            Ok((title, meta.icon))
        }
        Ok(None) => Ok((humanize_template_slug(slug), None)),
        Err(_) => Err(CollectionError::FrontmatterParse(format!(
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

pub fn templates_dir(space: &str, collection_path: &str) -> PathBuf {
    template_rel_abs(space, &join_template_rel(collection_path, TEMPLATES_DIR))
}

pub fn template_head_rel(collection_path: &str, slug: &str, kind: TemplateKind) -> String {
    match kind {
        TemplateKind::Leaf => {
            join_template_rel(collection_path, &format!("{TEMPLATES_DIR}/{slug}.md"))
        }
        TemplateKind::Folder | TemplateKind::NestedCollection => join_template_rel(
            collection_path,
            &format!("{TEMPLATES_DIR}/{slug}/{README_FILE}"),
        ),
    }
}

pub fn join_template_rel(base: &str, child: &str) -> String {
    let base = normalize_template_rel(base);
    if base.is_empty() || base == "." {
        child.to_string()
    } else {
        format!("{base}/{child}")
    }
}

pub fn template_rel_abs(space: &str, rel: &str) -> PathBuf {
    let rel = normalize_template_rel(rel);
    if rel.is_empty() || rel == "." {
        PathBuf::from(space)
    } else {
        Path::new(space).join(rel)
    }
}

pub fn normalize_template_rel(path: &str) -> String {
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

pub fn humanize_template_slug(slug: &str) -> String {
    let mut chars = slug.replace(['-', '_'], " ").chars().collect::<Vec<_>>();
    if let Some(first) = chars.first_mut() {
        first.make_ascii_uppercase();
    }
    chars.into_iter().collect()
}
