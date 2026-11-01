//! The Collection query semantics of Stage 11 `04` (4.C) in the Page
//! Collection engine: the conformance fixtures the standard semantics of the
//! frontend Properties run too, and the reading of saved multi-value
//! `contains` conditions as `_any` while new ones are refused.

use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::collections::engine::{
    prepare_add_view, prepare_update_view, read_collection_schema, resolve_query_filters,
};
use svode_core::collections::items::{list_items_for_view, query_items};
use svode_core::collections::model::{CollectionSchema, Filter, Sort, View};
use svode_core::collections::query::{
    folded_query_text_json, query_item_rows, validate_ad_hoc_query,
};
use svode_core::collections::schema_validation::{normalize_schema, validate_schema};
use svode_core::git::cli::GitCli;
use svode_core::index::db::{create_pool, ensure_schema};
use svode_core::index::model::IndexedPage;
use svode_core::index::reindex::full_reindex;
use svode_core::index::rows::upsert_page;

const FIXTURES: &str = include_str!("../../../fixtures/collection-query-conformance.json");
const COLLECTION: &str = "items";

#[derive(Deserialize)]
struct Fixtures {
    suites: Vec<Suite>,
}

#[derive(Deserialize)]
struct Suite {
    name: String,
    columns: JsonValue,
    items: Vec<Item>,
    filters: Vec<FilterCase>,
    sorts: Vec<SortCase>,
}

#[derive(Deserialize)]
struct Item {
    id: String,
    title: String,
    description: Option<String>,
    fields: serde_json::Map<String, JsonValue>,
}

#[derive(Deserialize)]
struct FilterCase {
    name: String,
    filter: Vec<Filter>,
    #[serde(default)]
    invalid: bool,
    #[serde(default)]
    expect: Vec<String>,
}

#[derive(Deserialize)]
struct SortCase {
    name: String,
    sort: Vec<Sort>,
    expect: Vec<String>,
}

#[tokio::test]
async fn collection_query_engine_follows_the_conformance_fixtures() {
    let fixtures: Fixtures = serde_json::from_str(FIXTURES).unwrap();
    let mut failures = Vec::new();
    for suite in fixtures.suites {
        let temp = tempfile::TempDir::new().unwrap();
        let pool = suite_pool(temp.path(), &suite).await;
        let mut schema: CollectionSchema =
            serde_json::from_value(serde_json::json!({ "columns": suite.columns, "views": [] }))
                .unwrap();
        normalize_schema(&mut schema);
        validate_schema(&schema).unwrap_or_else(|error| panic!("{}: {error}", suite.name));

        for case in &suite.filters {
            let label = format!("{} / {}", suite.name, case.name);
            let validated = validate_ad_hoc_query(&schema, &case.filter, &[]);
            if case.invalid {
                if validated.is_ok() {
                    failures.push(format!("{label}: accepted an invalid filter"));
                }
                continue;
            }
            if let Err(error) = validated {
                failures.push(format!("{label}: {error}"));
                continue;
            }
            let mut ids = query_ids(temp.path(), &pool, &schema, &case.filter, &[]).await;
            ids.sort();
            let mut expected = case.expect.clone();
            expected.sort();
            if ids != expected {
                failures.push(format!("{label}: expected {expected:?}, got {ids:?}"));
            }
        }
        for case in &suite.sorts {
            let label = format!("{} / {}", suite.name, case.name);
            if let Err(error) = validate_ad_hoc_query(&schema, &[], &case.sort) {
                failures.push(format!("{label}: {error}"));
                continue;
            }
            let ids = query_ids(temp.path(), &pool, &schema, &[], &case.sort).await;
            if ids != case.expect {
                failures.push(format!("{label}: expected {:?}, got {ids:?}", case.expect));
            }
        }
        pool.close().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

async fn suite_pool(space: &Path, suite: &Suite) -> SqlitePool {
    let pool = create_pool(&space.join("index.db")).await.unwrap();
    ensure_schema(&pool).await.unwrap();
    for item in &suite.items {
        let fields_json = JsonValue::Object(item.fields.clone()).to_string();
        let page = IndexedPage {
            rel_path: format!("{COLLECTION}/{}.md", item.id),
            parent_path: COLLECTION.to_string(),
            title: item.title.clone(),
            icon: None,
            description: item.description.clone(),
            cover_json: None,
            created: String::new(),
            updated: String::new(),
            collection_root_path: Some(COLLECTION.to_string()),
            in_collection: true,
            is_item_head: true,
            folded_text_json: folded_query_text_json(
                &item.title,
                item.description.as_deref(),
                &fields_json,
            ),
            fields_json,
            body_preview: String::new(),
            is_discoverable: true,
            knowledge: None,
            source_diagnostic: None,
        };
        upsert_page(&pool, &page).await.unwrap();
    }
    pool
}

async fn query_ids(
    space: &Path,
    pool: &SqlitePool,
    schema: &CollectionSchema,
    filters: &[Filter],
    sort: &[Sort],
) -> Vec<String> {
    let resolved = resolve_query_filters(&ActorCatalogState::new(), None, space, schema, filters)
        .await
        .unwrap();
    query_item_rows(pool, schema, COLLECTION, &resolved, sort, None, None)
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            row.file_path
                .trim_start_matches(&format!("{COLLECTION}/"))
                .trim_end_matches(".md")
                .to_string()
        })
        .collect()
}

const LEGACY_SCHEMA: &str = "\
columns:
- name: Tags
  type: multi_select
  options:
  - name: Red
  - name: Green
  - name: Blue
views:
- type: table
  name: Values
  filter:
  - field: Tags
    op: contains
    values:
    - Red
    - Blue
- type: table
  name: Sequence
  filter:
  - field: Tags
    op: not_contains
    value:
    - Red
    - Blue
";

async fn legacy_space() -> (tempfile::TempDir, SqlitePool) {
    let temp = tempfile::TempDir::new().unwrap();
    let space = temp.path().join("space");
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::write(space.join("tasks/schema.yaml"), LEGACY_SCHEMA).unwrap();
    for (name, tags) in [
        ("red", "[Red]"),
        ("green", "[Green]"),
        ("blue", "[Blue, Green]"),
        ("none", "[]"),
    ] {
        fs::write(
            space.join(format!("tasks/{name}.md")),
            format!("---\ntitle: {name}\nTags: {tags}\n---\n"),
        )
        .unwrap();
    }
    let pool = create_pool(&temp.path().join("index.db")).await.unwrap();
    ensure_schema(&pool).await.unwrap();
    full_reindex::<GitCli>(None, &pool, &space, &[])
        .await
        .unwrap();
    (temp, pool)
}

async fn view_titles(space: &str, pool: &SqlitePool, view: &str) -> Vec<String> {
    let mut titles: Vec<String> = list_items_for_view(
        pool,
        &ActorCatalogState::new(),
        None,
        space,
        "tasks",
        view,
        None,
    )
    .await
    .unwrap()
    .into_iter()
    .map(|page| page.meta.title)
    .collect();
    titles.sort();
    titles
}

#[tokio::test]
async fn saved_multi_value_contains_reads_as_any_without_rewrite() {
    let (temp, pool) = legacy_space().await;
    let space = temp.path().join("space");
    let space = space.to_str().unwrap();

    read_collection_schema(space, "tasks").unwrap();
    assert_eq!(view_titles(space, &pool, "Values").await, ["blue", "red"]);
    assert_eq!(view_titles(space, &pool, "Sequence").await, ["green"]);
    assert_eq!(
        fs::read_to_string(temp.path().join("space/tasks/schema.yaml")).unwrap(),
        LEGACY_SCHEMA
    );

    // A write that leaves the filter alone keeps the saved condition.
    prepare_update_view(
        space,
        "tasks",
        "Values",
        serde_norway::from_str("visible_fields: [title]").unwrap(),
    )
    .unwrap()
    .apply()
    .unwrap();
    let schema = read_collection_schema(space, "tasks").unwrap();
    let filter = &schema.views[0].filters()[0];
    assert_eq!(filter.values.as_ref().map(Vec::len), Some(2));
    assert_eq!(view_titles(space, &pool, "Values").await, ["blue", "red"]);
    pool.close().await;
}

#[tokio::test]
async fn new_multi_value_contains_is_refused_with_the_any_operator_hint() {
    let (temp, pool) = legacy_space().await;
    let space = temp.path().join("space");
    let space = space.to_str().unwrap();
    let schema_path = temp.path().join("space/tasks/schema.yaml");
    let refused = |error: String, replacement: &str| {
        assert!(
            error.contains(replacement) && error.contains("takes one value"),
            "{error}"
        );
    };

    let patch =
        serde_norway::from_str("filter:\n- field: Tags\n  op: contains\n  values: [Red, Blue]\n")
            .unwrap();
    let error = prepare_update_view(space, "tasks", "Values", patch)
        .unwrap()
        .apply()
        .unwrap_err();
    refused(error.to_string(), "contains_any");

    let view: View = serde_norway::from_str(
        "type: table\nname: New\nfilter:\n- field: Tags\n  op: not_contains\n  value: [Red, Blue]\n",
    )
    .unwrap();
    let error = prepare_add_view(space, "tasks", view, None)
        .unwrap()
        .apply()
        .unwrap_err();
    refused(error.to_string(), "not_contains_any");
    assert_eq!(fs::read_to_string(&schema_path).unwrap(), LEGACY_SCHEMA);

    let filters: Vec<Filter> =
        serde_norway::from_str("- field: Tags\n  op: contains\n  values: [Red, Blue]\n").unwrap();
    let error = query_items(
        &pool,
        &ActorCatalogState::new(),
        None,
        space,
        "tasks",
        Some(filters),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    refused(error.to_string(), "contains_any");

    let any: Vec<Filter> =
        serde_norway::from_str("- field: Tags\n  op: contains_any\n  values: [Red, Blue]\n")
            .unwrap();
    let mut titles: Vec<String> = query_items(
        &pool,
        &ActorCatalogState::new(),
        None,
        space,
        "tasks",
        Some(any),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap()
    .into_iter()
    .map(|page| page.meta.title)
    .collect();
    titles.sort();
    assert_eq!(titles, ["blue", "red"]);
    pool.close().await;
}
