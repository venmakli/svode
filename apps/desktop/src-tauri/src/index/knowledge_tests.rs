use crate::index::IndexState;
use std::path::Path;
use svode_core::index::knowledge::{
    KnowledgeFilters, KnowledgeRelatedContext, KnowledgeResponse, KnowledgeScope, KnowledgeSource,
};

#[allow(clippy::too_many_arguments)]
pub async fn read_project_snapshot(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
    query: Option<&str>,
    node_offset: Option<usize>,
    edge_offset: Option<usize>,
    node_limit: Option<usize>,
    edge_limit: Option<usize>,
    search_limit: Option<usize>,
) -> KnowledgeResponse {
    svode_core::index::knowledge::read_project_snapshot(
        &state.core,
        project,
        scope,
        query,
        node_offset,
        edge_offset,
        node_limit,
        edge_limit,
        search_limit,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn read_project_snapshot_filtered(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
    query: Option<&str>,
    node_offset: Option<usize>,
    edge_offset: Option<usize>,
    node_limit: Option<usize>,
    edge_limit: Option<usize>,
    search_limit: Option<usize>,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    svode_core::index::knowledge::read_project_snapshot_filtered(
        &state.core,
        project,
        scope,
        query,
        node_offset,
        edge_offset,
        node_limit,
        edge_limit,
        search_limit,
        filters,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn read_effective_space_snapshot_filtered(
    state: &IndexState,
    project: &Path,
    space_id: Option<String>,
    query: Option<&str>,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    svode_core::index::knowledge::read_effective_space_snapshot_filtered(
        &state.core,
        project,
        space_id,
        query,
        node_limit,
        edge_limit,
        search_limit,
        filters,
    )
    .await
}

pub async fn read_related_context(
    state: &IndexState,
    project: &Path,
    scope: KnowledgeScope,
    query: &str,
    limit: usize,
    text_budget: usize,
    node_kinds: Option<Vec<String>>,
) -> KnowledgeRelatedContext {
    svode_core::index::knowledge::read_related_context(
        &state.core,
        project,
        scope,
        query,
        limit,
        text_budget,
        node_kinds,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{IndexKey, IndexState, ProjectSpacesCache, reindex::full_reindex, update};
    use crate::space::types::SpaceStatus;
    use std::fs;
    use svode_core::index::knowledge_artifact::finish_artifact;
    use svode_core::index::knowledge_rows::replace_all;
    use svode_core::index::model::{
        KnowledgeAgentApplicability, KnowledgeArtifact, KnowledgeEdgeArtifact,
    };
    use tempfile::TempDir;

    use sqlx::SqlitePool;
    use std::collections::{BTreeSet, HashMap};

    const RELATED_NEIGHBORS_PER_ITEM: usize = 5;

    fn test_artifact(path: &str, kind: &str, text: &str) -> KnowledgeArtifact {
        finish_artifact(
            path,
            kind,
            path,
            "2026-08-09T00:00:00Z",
            text,
            path,
            serde_json::json!({ "physical": true }),
            text.to_string(),
            Vec::new(),
        )
    }

    async fn replace_test_snapshot(
        pool: &SqlitePool,
        artifacts: &[KnowledgeArtifact],
        applicability: &[KnowledgeAgentApplicability],
    ) {
        let mut tx = pool.begin().await.unwrap();
        replace_all(&mut tx, artifacts, applicability, 0, 0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn owner_content_and_templates_are_excluded_while_pages_remain_nodes() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join(".templates")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(project.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        fs::write(project.join("tasks/item.md"), "Unlinked body").unwrap();
        fs::write(project.join("README.md"), "Space owner content").unwrap();
        fs::write(project.join(".templates/hidden.md"), "Hidden").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT source_path,node_kind FROM knowledge_documents ORDER BY source_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("tasks".to_string(), "collection".to_string()),
                ("tasks/item.md".to_string(), "page".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn effective_child_scope_uses_prepared_agent_applicability_without_document_leakage() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("child/.svode")).unwrap();
        fs::create_dir_all(project.join("sibling/.svode")).unwrap();

        let state = IndexState::new();
        state.core.spaces_cache.lock().await.insert(
            project.to_path_buf(),
            ProjectSpacesCache {
                by_folder: HashMap::from([
                    ("child".to_string(), "child-space".to_string()),
                    ("sibling".to_string(), "sibling-space".to_string()),
                ]),
                folder_by_id: HashMap::from([
                    ("child-space".to_string(), "child".to_string()),
                    ("sibling-space".to_string(), "sibling".to_string()),
                ]),
                status_by_id: HashMap::from([
                    ("child-space".to_string(), SpaceStatus::Ready),
                    ("sibling-space".to_string(), SpaceStatus::Ready),
                ]),
                root_name: "Root".to_string(),
                name_by_id: HashMap::from([
                    ("child-space".to_string(), "Child".to_string()),
                    ("sibling-space".to_string(), "Sibling".to_string()),
                ]),
            },
        );

        let root_pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let child_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "child-space".to_string(),
            })
            .await
            .unwrap();
        let sibling_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "sibling-space".to_string(),
            })
            .await
            .unwrap();

        replace_test_snapshot(
            &root_pool,
            &[
                test_artifact("root.md", "page", "root page"),
                test_artifact(
                    "AGENTS.md",
                    "agent_instruction",
                    "effective root instructions",
                ),
                test_artifact(
                    "shadowed/AGENTS.md",
                    "agent_instruction",
                    "not effective for child",
                ),
            ],
            &[],
        )
        .await;
        let mut child_page = test_artifact("child.md", "page", "🙂🙂");
        child_page.edges = (0..=RELATED_NEIGHBORS_PER_ITEM)
            .map(|index| KnowledgeEdgeArtifact {
                kind: "links_to".to_string(),
                target_url: format!("related-{index}.md"),
                target_scope: "resolve".to_string(),
                target_path: None,
                target_kind: None,
                field_name: None,
                location_path: "child.md".to_string(),
                byte_start: index as i64,
                byte_end: index as i64,
            })
            .collect();
        replace_test_snapshot(
            &child_pool,
            &[
                child_page,
                test_artifact("AGENTS.md", "agent_instruction", "local instructions"),
            ],
            &[
                KnowledgeAgentApplicability {
                    source_scope: "current".to_string(),
                    source_path: "AGENTS.md".to_string(),
                    node_kind: "agent_instruction".to_string(),
                    provenance: serde_json::json!({ "scopeApplicability": "local" }),
                },
                KnowledgeAgentApplicability {
                    source_scope: "root".to_string(),
                    source_path: "AGENTS.md".to_string(),
                    node_kind: "agent_instruction".to_string(),
                    provenance: serde_json::json!({ "scopeApplicability": "inherited" }),
                },
            ],
        )
        .await;
        replace_test_snapshot(
            &sibling_pool,
            &[test_artifact("sibling.md", "page", "sibling page")],
            &[],
        )
        .await;

        let effective = read_effective_space_snapshot_filtered(
            &state,
            project,
            Some("child-space".to_string()),
            None,
            32,
            32,
            32,
            KnowledgeFilters::default(),
        )
        .await;
        let sources = effective
            .nodes
            .iter()
            .map(|node| {
                (
                    node.source.space_id.clone(),
                    node.source.path.clone(),
                    node.source.kind.clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            sources,
            BTreeSet::from([
                (
                    None,
                    "AGENTS.md".to_string(),
                    "agent_instruction".to_string(),
                ),
                (
                    Some("child-space".to_string()),
                    "AGENTS.md".to_string(),
                    "agent_instruction".to_string(),
                ),
                (
                    Some("child-space".to_string()),
                    "child.md".to_string(),
                    "page".to_string(),
                ),
            ])
        );
        assert!(!sources.iter().any(|(_, path, _)| path == "root.md"));
        assert!(!sources.iter().any(|(_, path, _)| path == "sibling.md"));
        assert!(
            !sources
                .iter()
                .any(|(_, path, _)| path == "shadowed/AGENTS.md")
        );
        let inherited = effective
            .nodes
            .iter()
            .find(|node| node.source.space_id.is_none() && node.source.path == "AGENTS.md")
            .unwrap();
        assert_eq!(inherited.provenance["scopeApplicability"], "inherited");
        assert_eq!(inherited.provenance["effectiveSpaceId"], "child-space");

        let related = read_related_context(
            &state,
            project,
            KnowledgeScope::Space {
                space_id: Some("child-space".to_string()),
            },
            "🙂",
            8,
            5,
            None,
        )
        .await;
        assert_eq!(related.used_budget, 4);
        assert!(related.used_budget <= related.text_budget);
        assert_eq!(related.context.len(), 1);
        assert_eq!(related.context[0].text, "🙂");
        assert!(related.context[0].truncated);
        assert!(related.truncated);

        let related = read_related_context(
            &state,
            project,
            KnowledgeScope::Space {
                space_id: Some("child-space".to_string()),
            },
            "🙂",
            8,
            4_000,
            None,
        )
        .await;
        assert_eq!(related.neighbors.len(), RELATED_NEIGHBORS_PER_ITEM);
        assert!(related.truncated);

        let root = read_effective_space_snapshot_filtered(
            &state,
            project,
            None,
            None,
            32,
            32,
            32,
            KnowledgeFilters::default(),
        )
        .await;
        assert!(root.nodes.iter().any(|node| node.source.path == "root.md"));
        assert!(!root.nodes.iter().any(|node| node.source.space_id.is_some()));

        let project_wide = read_project_snapshot_filtered(
            &state,
            project,
            Some(KnowledgeScope::Project),
            None,
            None,
            None,
            Some(32),
            Some(32),
            Some(32),
            KnowledgeFilters::default(),
        )
        .await;
        assert!(
            project_wide
                .nodes
                .iter()
                .any(|node| node.source.path == "sibling.md")
        );
        assert_eq!(
            project_wide
                .nodes
                .iter()
                .filter(|node| node.source.path == "AGENTS.md")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn targeted_update_delete_and_noop_are_atomic() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        let path = project.join("note.md");
        fs::write(&path, "[old](old.md)").unwrap();
        let state = IndexState::new();
        update::update_entry(&state, project, &path).await.unwrap();
        let pool = state
            .existing_pool(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        sqlx::query("UPDATE knowledge_manifest SET checked_at='sentinel'")
            .execute(&pool)
            .await
            .unwrap();
        update::update_entry(&state, project, &path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT checked_at FROM knowledge_manifest")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "sentinel"
        );
        fs::write(&path, "[new](new.md)").unwrap();
        update::update_entry(&state, project, &path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT target_url FROM knowledge_links")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "new.md"
        );
        fs::remove_file(&path).unwrap();
        update::delete_entry(&state, project, &path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_documents")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn empty_collection_folds_readme_and_schema_into_one_logical_node() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(
            project.join("tasks/schema.yaml"),
            "system_fields:\n  title:\n    label: Task name\ncolumns:\n  - name: Status\n    type: text\n",
        )
        .unwrap();
        fs::write(
            project.join("tasks/README.md"),
            "---\ntitle: Work queue\ndescription: Safe description\n---\nCollection body",
        )
        .unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();

        let nodes: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT source_path,node_kind,title FROM knowledge_documents ORDER BY source_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            nodes,
            vec![(
                "tasks".to_string(),
                "collection".to_string(),
                "Work queue".to_string()
            )]
        );
        let fragment: String =
            sqlx::query_scalar("SELECT text FROM knowledge_fragments WHERE source_path='tasks'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(fragment.contains("Collection body"));
        assert!(fragment.contains("Task name"));
        assert!(fragment.contains("Status"));
    }

    #[tokio::test]
    async fn typed_relations_member_edges_safe_search_and_filters_share_one_model() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::create_dir_all(project.join("projects")).unwrap();
        fs::write(
            project.join("tasks/schema.yaml"),
            "columns:\n  - name: Project\n    type: relation\n    relation: projects\n  - name: Secret\n    type: text\n",
        )
        .unwrap();
        fs::write(project.join("projects/schema.yaml"), "columns: []\n").unwrap();
        fs::write(
            project.join("tasks/item.md"),
            "---\ntitle: Item\nProject: alpha.md\nSecret: must-not-leak\n---\nPublic body",
        )
        .unwrap();
        fs::write(
            project.join("projects/alpha.md"),
            "---\ntitle: Alpha\n---\nAlpha body",
        )
        .unwrap();
        fs::write(project.join("source.md"), "See [the item](tasks/item.md)").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();

        let edges: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT edge_kind,target_url,field_name FROM knowledge_links \
             WHERE source_path='tasks/item.md' ORDER BY edge_kind,target_url",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            edges,
            vec![
                ("member_of".to_string(), "tasks".to_string(), None),
                (
                    "relation".to_string(),
                    "projects/alpha.md".to_string(),
                    Some("Project".to_string())
                )
            ]
        );
        let leaked = read_project_snapshot(
            &state,
            project,
            None,
            Some("must-not-leak"),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(leaked.search_items.is_empty());
        let relation_target = read_project_snapshot(
            &state,
            project,
            None,
            Some("projects/alpha.md"),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(relation_target.search_items.len(), 1);
        assert_eq!(relation_target.search_items[0].source.path, "tasks/item.md");

        let filtered = read_project_snapshot_filtered(
            &state,
            project,
            None,
            None,
            None,
            None,
            Some(1),
            None,
            None,
            KnowledgeFilters {
                node_kinds: Some(vec!["collection".to_string()]),
                edge_kinds: Some(vec!["relation".to_string(), "member_of".to_string()]),
                edge_source_kinds: None,
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "tasks/item.md".to_string(),
                    kind: "page".to_string(),
                }),
                neighbor_limit: Some(10),
                source: None,
                sources: None,
                edge_sources: None,
            },
        )
        .await;
        assert_eq!(filtered.total_node_count, 2);
        assert_eq!(filtered.nodes.len(), 1);
        assert!(filtered.has_more_nodes);
        assert_eq!(filtered.total_edge_count, 2);
        assert_eq!(filtered.edges.len(), 2);
        assert!(
            filtered
                .edges
                .iter()
                .all(|edge| edge.source.path == "tasks/item.md")
        );

        let incoming_markdown = read_project_snapshot_filtered(
            &state,
            project,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            KnowledgeFilters {
                node_kinds: None,
                edge_kinds: Some(vec!["links_to".to_string()]),
                edge_source_kinds: None,
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "tasks/item.md".to_string(),
                    kind: "page".to_string(),
                }),
                neighbor_limit: Some(10),
                source: None,
                sources: None,
                edge_sources: None,
            },
        )
        .await;
        assert_eq!(incoming_markdown.total_edge_count, 1);
        assert_eq!(incoming_markdown.edges.len(), 1);
        assert_eq!(incoming_markdown.edges[0].source.path, "source.md");
        assert_eq!(incoming_markdown.edges[0].target_status, "ready");
    }

    #[tokio::test]
    async fn targeted_collection_readme_update_replaces_folded_fragment() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(project.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        let readme = project.join("tasks/README.md");
        fs::write(&readme, "# Tasks\nOld body").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();
        fs::write(&readme, "# Tasks\nNew body").unwrap();
        update::update_entry(&state, project, &readme)
            .await
            .unwrap();
        let fragment: String =
            sqlx::query_scalar("SELECT text FROM knowledge_fragments WHERE source_path='tasks'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(fragment.contains("New body"));
        assert!(!fragment.contains("Old body"));
        let readme_nodes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_documents WHERE source_path='tasks/README.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(readme_nodes, 0);
    }
}
