use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::files::frontmatter;
use crate::repo_path::{RootMode, normalize_repo_relative};

use super::{
    CollectionSchema, PropertyType, RelationScope, join_collection_value, read_collection_schema,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCollectionProjection {
    pub source_path: String,
    pub title: String,
    pub description: Option<String>,
    pub body: String,
    pub schema_labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRelationProjection {
    pub field_name: String,
    pub target_scope: String,
    pub target_path: String,
}

pub fn project_collection(
    space_root: &Path,
    collection_path: &str,
) -> Result<KnowledgeCollectionProjection, AppError> {
    let schema = read_collection_schema(&space_root.to_string_lossy(), collection_path)?;
    let collection_dir = if collection_path == "." {
        space_root.to_path_buf()
    } else {
        space_root.join(collection_path)
    };
    let readme = collection_dir.join("README.md");
    let fallback_title = collection_dir
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Collection")
        .to_string();
    let (title, description, body) = read_collection_readme(&readme, fallback_title)?;
    let mut schema_labels = schema_labels(&schema);
    schema_labels.sort();
    schema_labels.dedup();
    Ok(KnowledgeCollectionProjection {
        source_path: collection_path.to_string(),
        title,
        description,
        body,
        schema_labels,
    })
}

pub fn project_entry_relations(
    space_root: &Path,
    entry_path: &str,
    fields_json: &str,
) -> Result<Vec<KnowledgeRelationProjection>, AppError> {
    let Some((schema, collection_root)) =
        super::resolve_collection_schema_result(&space_root.to_string_lossy(), entry_path)?
    else {
        return Ok(Vec::new());
    };
    let values = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(fields_json)
        .unwrap_or_default();
    let mut relations = Vec::new();
    for column in schema
        .columns
        .iter()
        .filter(|column| column.type_ == PropertyType::Relation)
    {
        let Some(target_collection) = column.relation.as_deref() else {
            continue;
        };
        let target_scope = match column.relation_scope.as_ref() {
            None => "current".to_string(),
            Some(RelationScope::Root) => "root".to_string(),
            Some(RelationScope::Space { id }) => format!("space:{id}"),
        };
        let Some(value) = values.get(&column.name) else {
            continue;
        };
        for target_value in string_values(value) {
            let target_path = join_collection_value(target_collection, target_value);
            let target_path = normalize_projected_path(Path::new(&target_path))?;
            relations.push(KnowledgeRelationProjection {
                field_name: column.name.clone(),
                target_scope: target_scope.clone(),
                target_path,
            });
        }
    }
    relations.sort_by(|left, right| {
        left.field_name
            .cmp(&right.field_name)
            .then_with(|| left.target_scope.cmp(&right.target_scope))
            .then_with(|| left.target_path.cmp(&right.target_path))
    });
    relations.dedup();
    let _ = collection_root;
    Ok(relations)
}

pub fn collection_readme_path(collection_path: &str) -> String {
    if collection_path == "." {
        "README.md".to_string()
    } else {
        format!("{collection_path}/README.md")
    }
}

fn read_collection_readme(
    path: &Path,
    fallback_title: String,
) -> Result<(String, Option<String>, String), AppError> {
    if !path.is_file() {
        return Ok((fallback_title, None, String::new()));
    }
    let raw = fs::read_to_string(path)?;
    Ok(match frontmatter::parse_status(&raw) {
        frontmatter::ParseStatus::Valid { meta, body } => {
            let title = if meta.frontmatter_keys.title {
                meta.title
            } else {
                markdown_heading(&body).unwrap_or(fallback_title)
            };
            (title, meta.description, body)
        }
        _ => (markdown_heading(&raw).unwrap_or(fallback_title), None, raw),
    })
}

fn markdown_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(ToString::to_string)
    })
}

fn schema_labels(schema: &CollectionSchema) -> Vec<String> {
    let mut labels = schema
        .columns
        .iter()
        .map(|column| column.name.trim().to_string())
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>();
    if let Some(label) = schema
        .system_fields
        .as_ref()
        .and_then(|fields| fields.title.as_ref())
        .and_then(|field| field.label.as_deref())
        .map(str::trim)
        .filter(|label| !label.is_empty())
    {
        labels.push(label.to_string());
    }
    labels.extend(
        schema
            .columns
            .iter()
            .filter(|column| column.type_ == PropertyType::Relation)
            .filter_map(|column| column.relation.as_deref())
            .map(ToString::to_string),
    );
    labels
}

fn string_values(value: &serde_json::Value) -> Vec<&str> {
    match value {
        serde_json::Value::String(value) => vec![value.as_str()],
        serde_json::Value::Array(values) => {
            values.iter().filter_map(|value| value.as_str()).collect()
        }
        _ => Vec::new(),
    }
}

fn normalize_projected_path(path: &Path) -> Result<String, AppError> {
    normalize_repo_relative(&path.to_string_lossy(), RootMode::Reject)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn only_schema_declared_relations_are_projected() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("tasks")).unwrap();
        fs::write(
            temp.path().join("tasks/schema.yaml"),
            "columns:\n  - name: Project\n    type: relation\n    relation: projects\n  - name: Secret\n    type: text\n",
        )
        .unwrap();
        fs::write(temp.path().join("tasks/item.md"), "item").unwrap();
        let fields = serde_json::json!({
            "Project": "alpha.md",
            "Secret": "must-not-be-projected.md"
        })
        .to_string();

        let projected = project_entry_relations(temp.path(), "tasks/item.md", &fields).unwrap();
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].field_name, "Project");
        assert_eq!(projected[0].target_path, "projects/alpha.md");
    }
}
