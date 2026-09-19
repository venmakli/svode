#[cfg(test)]
use sqlx::SqlitePool;
#[cfg(test)]
use std::path::Path;

#[cfg(test)]
use crate::error::AppError;
#[cfg(test)]
use svode_core::content_tree::policy::TreeIgnorePolicy;

pub(crate) use svode_core::index::inventory::{
    MarkdownProjection, markdown_projection, markdown_source_record,
};
#[cfg(test)]
use svode_core::index::inventory::{collect_md_files, collect_reindex_inventory};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, TreeSpaceConfig};
    use tempfile::TempDir;

    fn write_tree_config(tmp: &TempDir, exclude: Vec<&str>, include: Vec<&str>) {
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Test".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: Some(TreeSpaceConfig {
                    exclude: exclude.into_iter().map(ToString::to_string).collect(),
                    include: include.into_iter().map(ToString::to_string).collect(),
                    show_ignored_placeholders: false,
                }),
            },
        )
        .expect("write config");
    }

    fn collect_rel_paths(tmp: &TempDir) -> Vec<String> {
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());
        let mut files = Vec::new();
        let mut collection_sources = Vec::new();
        let mut scan_failure_count = 0;
        collect_md_files(
            tmp.path(),
            tmp.path(),
            &[],
            &policy,
            &mut files,
            &mut collection_sources,
            &mut scan_failure_count,
        )
        .expect("collect files");
        let mut rels = files
            .iter()
            .map(|source| {
                source
                    .path
                    .strip_prefix(tmp.path())
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        rels.sort();
        rels
    }

    #[test]
    fn build_entry_indexes_legacy_keys_as_fields() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("note.md");
        std::fs::write(
            &file,
            "---\ntitle: Note\nid: imported\ncreated: yaml-created\nupdated: yaml-updated\n---\nBody\n",
        )
        .unwrap();

        let entry =
            build_entry_with_dates(tmp.path(), &file, None, MarkdownProjection::Discoverable)
                .expect("build entry");
        let fields: serde_json::Value =
            serde_json::from_str(&entry.fields_json).expect("fields json");

        assert_eq!(entry.rel_path, "note.md");
        assert_eq!(entry.title, "Note");
        assert_eq!(fields["id"], "imported");
        assert_eq!(fields["created"], "yaml-created");
        assert_eq!(fields["updated"], "yaml-updated");
        assert_ne!(entry.created, "yaml-created");
        assert_ne!(entry.updated, "yaml-updated");
    }

    #[test]
    fn build_entry_indexes_malformed_frontmatter_as_plain_markdown() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("broken.md");
        let raw = "---\ntitle: [broken\n---\nBody\n";
        std::fs::write(&file, raw).unwrap();

        let entry =
            build_entry_with_dates(tmp.path(), &file, None, MarkdownProjection::Discoverable)
                .expect("build entry");

        assert_eq!(entry.rel_path, "broken.md");
        assert_eq!(entry.title, "Broken");
        assert_eq!(entry.fields_json, "{}");
        assert_eq!(entry.body_preview, raw);
    }

    #[test]
    fn df_087_build_entry_uses_ancestor_only_membership_for_owner_readmes() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
        std::fs::create_dir_all(tmp.path().join("archive")).unwrap();
        std::fs::write(tmp.path().join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(tmp.path().join("README.md"), "# Owner").unwrap();
        std::fs::write(tmp.path().join("child.md"), "# Child").unwrap();
        std::fs::write(tmp.path().join("notes/README.md"), "# Notes").unwrap();
        std::fs::write(
            tmp.path().join("archive/schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("archive/README.md"), "# Archive").unwrap();
        std::fs::write(tmp.path().join("archive/item.md"), "# Archived item").unwrap();

        let owner = build_entry_with_dates(
            tmp.path(),
            &tmp.path().join("README.md"),
            None,
            MarkdownProjection::Discoverable,
        )
        .expect("build owner");
        assert_eq!(owner.collection_root_path, None);
        assert!(!owner.in_collection);

        for path in ["child.md", "notes/README.md", "archive/README.md"] {
            let entry = build_entry_with_dates(
                tmp.path(),
                &tmp.path().join(path),
                None,
                MarkdownProjection::Discoverable,
            )
            .expect("build root member");
            assert_eq!(entry.collection_root_path.as_deref(), Some("."));
            assert!(entry.in_collection);
        }

        let nested = build_entry_with_dates(
            tmp.path(),
            &tmp.path().join("archive/item.md"),
            None,
            MarkdownProjection::Discoverable,
        )
        .expect("build nested member");
        assert_eq!(nested.collection_root_path.as_deref(), Some("archive"));
        assert!(nested.in_collection);
    }

    #[test]
    fn reindex_markdown_walk_applies_tree_excludes() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        std::fs::create_dir_all(tmp.path().join("node_modules").join("pkg")).unwrap();
        std::fs::write(
            tmp.path()
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "ignored",
        )
        .unwrap();
        std::fs::write(tmp.path().join("visible.md"), "visible").unwrap();

        assert_eq!(collect_rel_paths(&tmp), vec!["visible.md".to_string()]);
    }

    #[test]
    fn reindex_markdown_walk_descends_to_user_included_paths() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs"], vec!["docs/guides/keep.md"]);
        std::fs::create_dir_all(tmp.path().join("docs").join("guides")).unwrap();
        std::fs::write(tmp.path().join("docs").join("drop.md"), "drop").unwrap();
        std::fs::write(
            tmp.path().join("docs").join("guides").join("drop.md"),
            "drop",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("docs").join("guides").join("keep.md"),
            "keep",
        )
        .unwrap();

        assert_eq!(
            collect_rel_paths(&tmp),
            vec!["docs/guides/keep.md".to_string()]
        );
    }

    #[test]
    fn df_088_inventory_keeps_hidden_collection_members_but_not_hidden_standalone_pages() {
        let collection = TempDir::new().unwrap();
        write_tree_config(&collection, vec!["hidden.md", "notes"], vec![]);
        std::fs::write(
            collection.path().join("schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        std::fs::create_dir_all(collection.path().join("notes")).unwrap();
        std::fs::write(collection.path().join("hidden.md"), "hidden").unwrap();
        std::fs::write(collection.path().join("notes/README.md"), "notes").unwrap();
        std::fs::write(collection.path().join("visible.md"), "visible").unwrap();
        std::fs::write(collection.path().join(".gitignore"), "git-hidden.md\n").unwrap();
        std::fs::write(collection.path().join("git-hidden.md"), "git hidden").unwrap();

        let inventory = collect_reindex_inventory(collection.path(), &[]).unwrap();
        let mut sources = inventory
            .markdown_sources
            .iter()
            .map(|source| {
                (
                    source
                        .path
                        .strip_prefix(collection.path())
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    source.projection,
                )
            })
            .collect::<Vec<_>>();
        sources.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(
            sources,
            vec![
                (
                    "git-hidden.md".to_string(),
                    MarkdownProjection::CollectionMemberOnly,
                ),
                (
                    "hidden.md".to_string(),
                    MarkdownProjection::CollectionMemberOnly,
                ),
                (
                    "notes/README.md".to_string(),
                    MarkdownProjection::CollectionMemberOnly,
                ),
                ("visible.md".to_string(), MarkdownProjection::Discoverable,),
            ]
        );

        let standalone = TempDir::new().unwrap();
        write_tree_config(&standalone, vec!["hidden.md"], vec![]);
        std::fs::write(standalone.path().join("hidden.md"), "hidden").unwrap();
        let inventory = collect_reindex_inventory(standalone.path(), &[]).unwrap();
        assert!(inventory.markdown_sources.is_empty());
    }

    #[tokio::test]
    async fn df_088_full_reindex_keeps_hidden_member_out_of_global_projections() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["hidden.md"], vec![]);
        std::fs::create_dir_all(tmp.path().join(".svode")).unwrap();
        std::fs::write(
            tmp.path().join("schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: HID, next: 8 }\nviews: []\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("hidden.md"),
            "---\ntitle: Hidden Needle\nKey: 7\n---\nhidden-body-token [private](visible.md)",
        )
        .unwrap();
        std::fs::write(tmp.path().join("visible.md"), "# Visible").unwrap();
        let pool = svode_core::index::db::create_pool(&tmp.path().join(".svode/index.db"))
            .await
            .unwrap();
        svode_core::index::db::ensure_schema(&pool).await.unwrap();

        full_reindex(&pool, tmp.path(), &[]).await.unwrap();

        let row: (Option<String>, i64, i64, String, String) = sqlx::query_as(
            "SELECT collection_root_path,in_collection,is_discoverable,body_preview,fields \
             FROM entries WHERE file_path = 'hidden.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0.as_deref(), Some("."));
        assert_eq!((row.1, row.2), (1, 0));
        assert!(row.3.is_empty());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row.4).unwrap()["Key"],
            7
        );
        let collection_rows = crate::properties::query_entries(
            &pool,
            &crate::properties::ActorCatalogState::new(),
            None,
            &tmp.path().to_string_lossy(),
            ".",
            None,
            None,
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(
            collection_rows
                .iter()
                .any(|entry| entry.path == "hidden.md")
        );

        assert!(
            svode_core::index::search::search_by_title(&pool, "Hidden Needle", 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            svode_core::index::search::search_fts(&pool, "hidden-body-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            svode_core::index::search::search_unique_id_exact(&pool, tmp.path(), "HID-7", 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            svode_core::index::search::recent(&pool, 10)
                .await
                .unwrap()
                .iter()
                .all(|result| result.path != "hidden.md")
        );
        for table in [
            "knowledge_documents",
            "knowledge_fragments",
            "knowledge_links",
        ] {
            let count: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM {table} WHERE source_path = 'hidden.md'"
            ))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        std::fs::remove_file(tmp.path().join("schema.yaml")).unwrap();
        full_reindex(&pool, tmp.path(), &[]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'hidden.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        std::fs::write(tmp.path().join("schema.yaml"), "columns: [\n").unwrap();
        full_reindex(&pool, tmp.path(), &[]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'hidden.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        std::fs::write(
            tmp.path().join("schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: HID, next: 8 }\nviews: []\n",
        )
        .unwrap();
        full_reindex(&pool, tmp.path(), &[]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'hidden.md' \
                 AND in_collection = 1 AND is_discoverable = 0",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn df_088_root_and_registered_space_fixture_preserves_hidden_page_shapes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_tree_config(
            &tmp,
            vec!["roadmap.md", "notes", "archive", "nested"],
            vec![],
        );
        std::fs::write(root.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(root.join("README.md"), "# Root owner").unwrap();
        std::fs::write(root.join("roadmap.md"), "# Roadmap").unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/README.md"), "# Notes").unwrap();
        std::fs::create_dir_all(root.join("archive")).unwrap();
        std::fs::write(root.join("archive/schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(root.join("archive/README.md"), "# Archive").unwrap();
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/README.md"), "# Nested").unwrap();
        std::fs::write(root.join("nested/deep.md"), "# Deep").unwrap();

        let child = root.join("team");
        std::fs::create_dir_all(child.join(".svode")).unwrap();
        std::fs::write(child.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(child.join("README.md"), "# Team owner").unwrap();
        std::fs::write(child.join("item.md"), "# Team item").unwrap();
        std::fs::write(child.join(".gitignore"), "item.md\n").unwrap();

        let root_pool = svode_core::index::db::create_pool(&root.join(".svode/index.db"))
            .await
            .unwrap();
        svode_core::index::db::ensure_schema(&root_pool)
            .await
            .unwrap();
        full_reindex(&root_pool, root, &["team".to_string()])
            .await
            .unwrap();

        let direct = crate::properties::query_entries(
            &root_pool,
            &crate::properties::ActorCatalogState::new(),
            None,
            &root.to_string_lossy(),
            ".",
            None,
            None,
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            direct
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "archive/README.md",
                "nested/README.md",
                "notes/README.md",
                "roadmap.md",
            ]
        );

        let nested = crate::properties::query_entries(
            &root_pool,
            &crate::properties::ActorCatalogState::new(),
            None,
            &root.to_string_lossy(),
            ".",
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();
        let mut nested_paths = nested
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        nested_paths.sort_unstable();
        assert_eq!(
            nested_paths,
            vec![
                "archive/README.md",
                "nested/README.md",
                "nested/deep.md",
                "notes/README.md",
                "roadmap.md",
            ]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE in_collection = 1 AND is_discoverable = 0",
            )
            .fetch_one(&root_pool)
            .await
            .unwrap(),
            5
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path LIKE 'team/%'",
            )
            .fetch_one(&root_pool)
            .await
            .unwrap(),
            0
        );

        let child_pool = svode_core::index::db::create_pool(&child.join(".svode/index.db"))
            .await
            .unwrap();
        svode_core::index::db::ensure_schema(&child_pool)
            .await
            .unwrap();
        full_reindex(&child_pool, &child, &[]).await.unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64, i64)>(
                "SELECT COUNT(*),MAX(in_collection),MAX(is_discoverable) FROM entries \
                 WHERE file_path = 'item.md'",
            )
            .fetch_one(&child_pool)
            .await
            .unwrap(),
            (1, 1, 0)
        );

        write_tree_config(
            &tmp,
            vec!["roadmap.md", "notes", "archive", "nested"],
            vec!["roadmap.md"],
        );
        full_reindex(&root_pool, root, &["team".to_string()])
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64)>(
                "SELECT COUNT(*),MAX(is_discoverable) FROM entries WHERE file_path = 'roadmap.md'",
            )
            .fetch_one(&root_pool)
            .await
            .unwrap(),
            (1, 1)
        );

        std::fs::write(child.join(".gitignore"), "item.md\n!item.md\n").unwrap();
        full_reindex(&child_pool, &child, &[]).await.unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64)>(
                "SELECT COUNT(*),MAX(is_discoverable) FROM entries WHERE file_path = 'item.md'",
            )
            .fetch_one(&child_pool)
            .await
            .unwrap(),
            (1, 1)
        );
    }
}

pub(crate) use svode_core::index::model::IndexedEntry;

pub(crate) use svode_core::index::entry_projection::build_entry_with_dates;

#[cfg(test)]
pub async fn full_reindex(
    pool: &SqlitePool,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<(), AppError> {
    let cli = crate::git::dates::detected_cli();
    svode_core::index::reindex::full_reindex(cli.as_ref(), pool, space_dir, skip_top_level)
        .await
        .map_err(Into::into)
}

#[cfg(test)]
pub async fn full_reindex_for_target(
    pool: &SqlitePool,
    project_dir: &Path,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<bool, AppError> {
    let cli = crate::git::dates::detected_cli();
    svode_core::index::reindex::full_reindex_for_target(
        cli.as_ref(),
        pool,
        project_dir,
        space_dir,
        skip_top_level,
    )
    .await
    .map_err(Into::into)
}
