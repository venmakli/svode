//! What changed in a Collection schema between two versions of `schema.yaml`:
//! its fields and views, the schema facts of version messages (Stage 11 1.G).

use serde_norway::{Mapping, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaChange {
    FieldAdded(String),
    FieldRemoved(String),
    FieldRenamed { from: String, to: String },
    ViewChanged(String),
}

/// The field and view changes from `old` to `new`; an absent or unreadable
/// version has no fields and views. A field removed and another added at the
/// same position with the same type is a rename.
pub fn schema_changes(old: Option<&str>, new: Option<&str>) -> Vec<SchemaChange> {
    let old = Items::read(old);
    let new = Items::read(new);
    let mut changes = Vec::new();
    let removed = old
        .columns
        .iter()
        .enumerate()
        .filter(|(_, column)| !new.has_column(&column.name))
        .collect::<Vec<_>>();
    let added = new
        .columns
        .iter()
        .enumerate()
        .filter(|(_, column)| !old.has_column(&column.name))
        .collect::<Vec<_>>();
    let mut renamed = vec![false; removed.len()];
    let mut taken = vec![false; added.len()];
    for (r, (old_index, old_column)) in removed.iter().enumerate() {
        if let Some(a) = added.iter().enumerate().position(|(a, (index, column))| {
            !taken[a] && index == old_index && column.kind == old_column.kind
        }) {
            renamed[r] = true;
            taken[a] = true;
            changes.push(SchemaChange::FieldRenamed {
                from: old_column.name.clone(),
                to: added[a].1.name.clone(),
            });
        }
    }
    for (a, (_, column)) in added.iter().enumerate() {
        if !taken[a] {
            changes.push(SchemaChange::FieldAdded(column.name.clone()));
        }
    }
    for (r, (_, column)) in removed.iter().enumerate() {
        if !renamed[r] {
            changes.push(SchemaChange::FieldRemoved(column.name.clone()));
        }
    }
    for (name, view) in &new.views {
        if old.view(name) != Some(view) {
            changes.push(SchemaChange::ViewChanged(name.clone()));
        }
    }
    for (name, _) in &old.views {
        if new.view(name).is_none() {
            changes.push(SchemaChange::ViewChanged(name.clone()));
        }
    }
    changes
}

struct Column {
    name: String,
    kind: Option<Value>,
}

#[derive(Default)]
struct Items {
    columns: Vec<Column>,
    views: Vec<(String, Value)>,
}

impl Items {
    fn read(source: Option<&str>) -> Self {
        let Some(Value::Mapping(root)) =
            source.and_then(|source| serde_norway::from_str::<Value>(source).ok())
        else {
            return Self::default();
        };
        Self {
            columns: named(&root, "columns")
                .map(|(name, item)| Column {
                    name,
                    kind: item.get("type").cloned(),
                })
                .collect(),
            views: named(&root, "views")
                .map(|(name, item)| (name, Value::Mapping(item.clone())))
                .collect(),
        }
    }

    fn has_column(&self, name: &str) -> bool {
        self.columns.iter().any(|column| column.name == name)
    }

    fn view(&self, name: &str) -> Option<&Value> {
        self.views
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, view)| view)
    }
}

fn named<'a>(root: &'a Mapping, key: &str) -> impl Iterator<Item = (String, &'a Mapping)> {
    root.get(key)
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let item = item.as_mapping()?;
            let name = item.get("name")?.as_str()?.to_string();
            Some((name, item))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn added_removed_and_renamed_fields_and_changed_views() {
        let old = "columns:\n  - name: Status\n    type: status\n  - name: Owner\n    type: actor\n  - name: Notes\n    type: text\nviews:\n  - name: Board\n    type: board\n    group_by: Status\n  - name: Old\n    type: table\n";
        let new = "columns:\n  - name: State\n    type: status\n  - name: Owner\n    type: actor\n  - name: Priority\n    type: select\nviews:\n  - name: Board\n    type: board\n    group_by: State\n  - name: All\n    type: table\n";
        assert_eq!(
            schema_changes(Some(old), Some(new)),
            vec![
                SchemaChange::FieldRenamed {
                    from: "Status".into(),
                    to: "State".into(),
                },
                SchemaChange::FieldAdded("Priority".into()),
                SchemaChange::FieldRemoved("Notes".into()),
                SchemaChange::ViewChanged("Board".into()),
                SchemaChange::ViewChanged("All".into()),
                SchemaChange::ViewChanged("Old".into()),
            ]
        );
    }

    #[test]
    fn a_new_schema_adds_its_fields_and_an_unchanged_one_has_none() {
        let schema = "columns:\n  - name: Priority\n    type: select\n";
        assert_eq!(
            schema_changes(None, Some(schema)),
            vec![SchemaChange::FieldAdded("Priority".into())]
        );
        assert!(schema_changes(Some(schema), Some(schema)).is_empty());
        assert!(schema_changes(Some("next: 3\n"), Some("next: 4\n")).is_empty());
    }
}
