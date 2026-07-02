use serde_json::{Value, json};

use super::protocol::{ToolAnnotations, ToolDefinition};

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        def(
            "get_project_info",
            "Return the active Svode project and capabilities.",
            obj(vec![]),
            read_only_ann(),
            None,
        ),
        def(
            "list_spaces",
            "List addressable MCP spaces in the active project, including the root project space. Use spaceId \"root\" for the root project; null in other tools means active/default space.",
            obj(vec![]),
            read_only_ann(),
            None,
        ),
        def(
            "list_documents",
            "List markdown documents in a space. spaceId \"root\" targets the project root; spaceId null uses the active/default space.",
            schema(
                &[
                    space_id(),
                    path_opt("path", "Optional repo-relative folder path to list."),
                    int_opt("limit"),
                    int_opt("offset"),
                ],
                &[],
            ),
            read_only_ann(),
            None,
        ),
        def(
            "read_document",
            "Read a markdown document by repo-relative path.",
            schema(
                &[
                    space_id(),
                    document_path_req("path", "Markdown document path."),
                ],
                &["path"],
            ),
            read_only_ann(),
            None,
        ),
        def(
            "write_document",
            "Replace a markdown document body. Use this instead of direct filesystem writes so Svode preserves metadata, validates paths, and reports changedPaths. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    document_path_req("path", "Existing markdown document path."),
                    str_req("content"),
                    str_opt("title"),
                ],
                &["path", "content"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "create_document",
            "Create a regular Svode markdown document, not a collection. Use create_collection for structured data like tasks, CRM contacts, OKRs, backlog rows, assets, or any list/table/board/calendar content. Paths without extension become .md; trailing slash creates README.md.",
            schema(
                &[
                    space_id(),
                    path_req(
                        "path",
                        "Repo-relative document path. Missing .md is normalized to .md; trailing slash creates README.md.",
                    ),
                    str_opt("content"),
                    str_opt("title"),
                    str_opt("icon"),
                    str_opt("description"),
                    cover_opt("cover"),
                ],
                &["path"],
            ),
            write_ann(false, Some(false)),
            None,
        ),
        def(
            "update_document_metadata",
            "Update document or collection README metadata: title, icon, description, and cover. Does not change body and does not autocommit.",
            schema(
                &[
                    space_id(),
                    document_path_req("path", "Markdown document or collection README path."),
                    str_opt("title"),
                    str_opt("icon"),
                    str_opt("description"),
                    cover_opt("cover"),
                ],
                &["path"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "create_collection",
            "Create a Svode collection: a directory with README.md identity plus schema.yaml. Use for structured data, tables, boards, calendars, CRM, OKRs, tasks, backlog, inventories, and repeated records. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    path_req(
                        "path",
                        "Repo-relative directory path for the collection. Do not include a markdown extension and do not create a wrapper folder for a single collection.",
                    ),
                    str_req("title"),
                    str_opt("icon"),
                    str_opt("description"),
                    cover_opt("cover"),
                    str_opt("body"),
                    columns_opt("columns"),
                    views_opt("views"),
                    str_opt_desc(
                        "documentLabel",
                        "Optional label for collection entry documents.",
                    ),
                ],
                &["path", "title"],
            ),
            write_ann(false, Some(false)),
            None,
        ),
        def(
            "convert_to_collection",
            "Convert an existing markdown leaf, folder document, or bare folder into a Svode collection in place by adding schema.yaml. Use for existing content that should become structured records. Does not create a wrapper folder and does not autocommit.",
            schema(
                &[
                    space_id(),
                    path_req(
                        "path",
                        "Existing markdown leaf, folder document path, or bare folder path.",
                    ),
                ],
                &["path"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "search_documents",
            "Search indexed documents with FTS snippets.",
            schema(
                &[
                    space_id(),
                    str_req("query"),
                    int_opt("limit"),
                    int_opt("offset"),
                ],
                &["query"],
            ),
            read_only_ann(),
            None,
        ),
        def(
            "list_collections",
            "List collections in a space.",
            schema(&[space_id()], &[]),
            read_only_ann(),
            None,
        ),
        def(
            "get_collection_schema",
            "Read a collection schema including sensitivity metadata. Call this before changing columns, views, filters, sort, or field values.",
            schema(
                &[space_id(), collection_path_req("collectionPath")],
                &["collectionPath"],
            ),
            read_only_ann(),
            None,
        ),
        def(
            "query_entries",
            "Query entries from an existing collection. Use list_collections first if you are unsure whether a collection exists. Relation field values are entry path refs, not row IDs.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    filters_opt("filters"),
                    sort_opt("sort"),
                    int_opt("limit"),
                    int_opt("offset"),
                ],
                &["collectionPath"],
            ),
            read_only_ann(),
            None,
        ),
        def(
            "create_entry",
            "Create one record inside an existing collection. The collectionPath must already contain schema.yaml; this tool does not create collections. fields are custom schema field values; title/icon/description/cover are system metadata. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    str_req("title"),
                    str_opt("body"),
                    str_opt("icon"),
                    str_opt("description"),
                    cover_opt("cover"),
                    fields_opt("fields"),
                ],
                &["collectionPath", "title"],
            ),
            write_ann(false, Some(false)),
            None,
        ),
        def(
            "update_entry_fields",
            "Update entry frontmatter custom fields. Do not write unique_id, title, icon, description, cover, created, or updated through fields. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    document_path_req("path", "Markdown entry path."),
                    fields_req("fields"),
                ],
                &["path", "fields"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "update_entry_body",
            "Replace entry body. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    document_path_req("path", "Markdown entry path."),
                    str_req("body"),
                ],
                &["path", "body"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "delete_entry",
            "Delete one document or collection entry by repo-relative markdown path. Pass folder/README.md to delete a folder document or collection root. Uses the same delete/index/backlink behavior as the UI, returns changedPaths, and does not autocommit.",
            schema(
                &[
                    space_id(),
                    document_path_req("path", "Markdown entry path to delete."),
                ],
                &["path"],
            ),
            write_ann(true, Some(false)),
            None,
        ),
        def(
            "add_collection_column",
            "Add a schema column to an existing collection. Read get_collection_schema first. actor values are canonical emails; status is workflow state; unique_id is read-only after materialization. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    column_req("column"),
                ],
                &["collectionPath", "column"],
            ),
            write_ann(false, Some(false)),
            None,
        ),
        def(
            "update_collection_column",
            "Patch configurable settings of an existing collection column, such as options, display, color, sensitivity, relation, date settings, or status groups. For new fields prefer add_collection_column. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    str_req("columnName"),
                    column_patch_req("patch"),
                ],
                &["collectionPath", "columnName", "patch"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "delete_collection_column",
            "Delete a collection column. Set deleteValues true only when stored values should also be removed from entries. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    str_req("columnName"),
                    bool_opt("deleteValues"),
                ],
                &["collectionPath", "columnName"],
            ),
            write_ann(true, Some(false)),
            None,
        ),
        def(
            "add_collection_view",
            "Add a table, board, calendar, list, or gallery view to an existing collection schema. Calendar requires date_field. Board group_by should be status, select, or single actor. Gallery uses card_cover. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    view_req("view"),
                    int_opt("position"),
                ],
                &["collectionPath", "view"],
            ),
            write_ann(false, Some(false)),
            None,
        ),
        def(
            "update_collection_view",
            "Patch an existing collection view: filters, sort, visible_fields, card_fields, group_by, date_field, gallery cover settings, and related view settings. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    str_req("viewName"),
                    view_patch_req("patch"),
                ],
                &["collectionPath", "viewName", "patch"],
            ),
            write_ann(false, None),
            None,
        ),
        def(
            "delete_collection_view",
            "Delete a named collection view. The implicit README Document tab is not a schema view and cannot be deleted through this tool. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    collection_path_req("collectionPath"),
                    str_req("viewName"),
                ],
                &["collectionPath", "viewName"],
            ),
            write_ann(true, Some(false)),
            None,
        ),
        def(
            "list_actors",
            "Return read-only actor candidates from the Git-backed actor catalog. Use before writing actor fields; actor values are canonical email strings.",
            schema(
                &[
                    space_id(),
                    bool_opt_desc(
                        "allTime",
                        "When true, scan all Git history instead of the recent catalog window.",
                    ),
                ],
                &[],
            ),
            read_only_ann(),
            Some(list_actors_output_schema()),
        ),
        def(
            "get_git_status",
            "Return read-only Git status for the active/default or selected space. This is only for review/reporting pending changes; Svode app owns commit/sync/autocommit flows.",
            schema(&[space_id()], &[]),
            read_only_ann(),
            None,
        ),
        def(
            "get_svode_guide",
            "Return agent-facing guidance for working with Svode documents, collections, entries, metadata, and schema tools.",
            obj(vec![]),
            read_only_ann(),
            None,
        ),
    ]
}

pub fn is_public_tool(name: &str) -> bool {
    definitions()
        .iter()
        .any(|definition| definition.name == name)
}

pub fn guide_text() -> &'static str {
    r#"Svode MCP guide:
- Target: Svode MCP is a tools-only local product API. It currently negotiates protocolVersion 2025-06-18 for client compatibility while using 2025-11-25-friendly tool definitions: object inputSchema, optional outputSchema only when it matches structuredContent, annotations, and tools/list pagination tolerance.
- Mutating tools do not autocommit. They return changedPaths in structuredContent. Svode app owns commit/sync/autocommit policy.

Structure choice:
- Use a regular document for narrative notes, specs, plans, and one-off pages.
- Use a document folder when one page naturally owns subpages/assets.
- Use a collection for repeated structured data: tasks, backlog, CRM contacts, customers, OKRs, assets, inventory, bugs, sprints, meetings, or anything that should be queried, filtered, sorted, or shown as a table/board/calendar/list/gallery.
- Do not create a plain wrapper folder for one collection. create_collection already creates the directory collection with README.md identity plus schema.yaml.
- If a markdown leaf, folder document, or bare folder already exists and should become structured data, use convert_to_collection in place.
- Existing custom frontmatter values are user data. Adding a same-name column promotes those values into schema semantics.

Space targeting:
- Call list_spaces before cross-space work. The result includes the root project space and child spaces.
- Use spaceId "root" to explicitly target the project root space.
- Use a child space id from list_spaces to target a child space.
- Omit spaceId or pass null only when you intentionally want the active/default space; null is not a stable alias for root when a child space is active.

Metadata and fields:
- System metadata is title, icon, description, cover, created, and updated. Do not create custom columns for these and do not write them through update_entry_fields.
- Collection identity lives in README.md metadata. Schema.yaml stores columns, views, system field labels, document label, and template settings.
- Prefer domain tools over direct filesystem writes: update_document_metadata for title/icon/description/cover, schema tools for columns/views, write_document or update_entry_body for body replacement, and update_entry_fields for custom field values.

Property semantics:
- Always read get_collection_schema before schema changes.
- actor is for assignee/owner/reviewer/participants. Values are canonical email strings, or arrays of canonical emails when the column allows multiple actors. Use list_actors first; do not create select options from people names.
- status is workflow state with groups todo, in_progress, and done. A collection should have at most one status column.
- unique_id is read-only after creation/materialization. Do not write unique_id through update_entry_fields.
- date is for due dates, events, and calendar views. Calendar views require date_field.
- email and phone should use typed email/phone fields and sensitivity pii for contact data.
- relation columns use relation for the target collection path and optional relation_scope for a target outside the current scope. Omit relation_scope or set it null for the same scope; use "root" to target the project root; use {"type":"space","id":"<spaceId>"} to target a registered ready child space. Use list_spaces to discover space ids, and list_collections with that spaceId to discover target collection paths. Cross-scope relations do not support two_way.
- relation values are path refs inside the target collection, not row IDs. For cross-scope relations the value is still relative to the target collection; the target scope lives in the schema column.
- gallery views use card_cover. Board group_by should be status, select, or a single actor field.
- For select/status fields, define options with useful colors/icons when possible."#
}

fn def(
    name: &'static str,
    description: &'static str,
    input_schema: Value,
    annotations: ToolAnnotations,
    output_schema: Option<Value>,
) -> ToolDefinition {
    ToolDefinition {
        name,
        description,
        input_schema,
        output_schema,
        annotations: Some(annotations),
    }
}

fn read_only_ann() -> ToolAnnotations {
    ToolAnnotations {
        read_only_hint: Some(true),
        destructive_hint: Some(false),
        idempotent_hint: Some(true),
        open_world_hint: Some(false),
    }
}

fn write_ann(destructive: bool, idempotent: Option<bool>) -> ToolAnnotations {
    ToolAnnotations {
        read_only_hint: Some(false),
        destructive_hint: Some(destructive),
        idempotent_hint: idempotent,
        open_world_hint: Some(false),
    }
}

fn schema(props: &[(&'static str, Value)], required: &[&str]) -> Value {
    let mut properties = serde_json::Map::new();
    for (name, value) in props {
        properties.insert((*name).to_string(), value.clone());
    }
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    })
}

fn obj(props: Vec<(&'static str, Value)>) -> Value {
    schema(&props, &[])
}

fn nullable(schema: Value) -> Value {
    json!({ "anyOf": [schema, { "type": "null" }] })
}

fn space_id() -> (&'static str, Value) {
    (
        "spaceId",
        json!({"type": ["string", "null"], "description": "Svode MCP space id. Use \"root\" for the project root, a child id from list_spaces for a child space, or null/omit for the active/default space."}),
    )
}

fn str_req(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": "string"}))
}

fn str_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["string", "null"]}))
}

fn str_opt_desc(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({"type": ["string", "null"], "description": description}),
    )
}

fn path_req(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "string",
            "description": format!("{description} Must be repo-relative: no absolute paths, '..', .git/**, or .svode/**.")
        }),
    )
}

fn path_opt(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": ["string", "null"],
            "description": format!("{description} Must be repo-relative when provided: no absolute paths, '..', .git/**, or .svode/**.")
        }),
    )
}

fn document_path_req(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "string",
            "description": format!("{description} Must end with .md and be repo-relative: no absolute paths, '..', .git/**, or .svode/**.")
        }),
    )
}

fn collection_path_req(name: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "string",
            "description": "Repo-relative collection directory path that contains schema.yaml. Empty string targets a root collection. No absolute paths, '..', .git/**, or .svode/**."
        }),
    )
}

fn int_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["integer", "null"], "minimum": 0}))
}

fn bool_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["boolean", "null"]}))
}

fn bool_opt_desc(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({"type": ["boolean", "null"], "description": description}),
    )
}

fn fields_req(name: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "object",
            "description": "Custom schema field values keyed by column name. actor values are canonical emails; relation values are entry path refs; unique_id and system metadata are read-only here.",
            "additionalProperties": true
        }),
    )
}

fn fields_opt(name: &'static str) -> (&'static str, Value) {
    let mut schema = fields_req(name).1;
    schema["description"] = json!(
        "Optional custom schema field values keyed by column name. actor values are canonical emails; relation values are entry path refs; do not include unique_id or system metadata."
    );
    (name, nullable(schema))
}

fn cover_opt(name: &'static str) -> (&'static str, Value) {
    (
        name,
        nullable(json!({
            "description": "System metadata cover, not a custom column.",
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "type": { "type": "string", "enum": ["color"] },
                        "value": {
                            "type": "string",
                            "enum": ["neutral", "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown"],
                            "description": "Color name for color covers."
                        }
                    },
                    "required": ["type", "value"]
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "type": { "type": "string", "enum": ["image"] },
                        "path": { "type": "string", "description": "Repo-relative or asset path for image covers." },
                        "position": { "type": ["integer", "null"], "minimum": 0, "maximum": 100 }
                    },
                    "required": ["type", "path"]
                }
            ]
        })),
    )
}

fn columns_opt(name: &'static str) -> (&'static str, Value) {
    (
        name,
        nullable(json!({
            "type": "array",
            "items": column_schema(),
            "description": "Optional initial schema columns. Do not include title/icon/description/cover/created/updated as custom columns."
        })),
    )
}

fn column_req(name: &'static str) -> (&'static str, Value) {
    (name, column_schema())
}

fn column_patch_req(name: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "object",
            "description": "Partial column patch. Use get_collection_schema first; only include settings you intend to change.",
            "additionalProperties": false,
            "properties": column_properties(false)
        }),
    )
}

fn column_schema() -> Value {
    json!({
        "type": "object",
        "description": "Svode column definition. actor values are canonical emails; relation values are entry paths; status options should use todo/in_progress/done groups.",
        "additionalProperties": false,
        "properties": column_properties(true),
        "required": ["name", "type"]
    })
}

fn column_properties(include_name_type: bool) -> Value {
    let mut properties = serde_json::Map::new();
    if include_name_type {
        properties.insert("name".to_string(), json!({"type": "string"}));
        properties.insert(
            "type".to_string(),
            json!({
                "type": "string",
                "enum": ["text", "number", "unique_id", "select", "multi_select", "status", "date", "relation", "actor", "checkbox", "url", "email", "phone"]
            }),
        );
    }
    properties.insert("sensitivity".to_string(), json!({"type": ["string", "null"], "enum": ["pii", "none", null], "description": "Use pii for contact data such as email/phone when appropriate."}));
    properties.insert(
        "default".to_string(),
        json!({"description": "Default field value. Must match the column type."}),
    );
    properties.insert("options".to_string(), json!({"type": ["array", "null"], "items": option_schema(), "description": "select/multi_select/status options. status options may include group todo/in_progress/done."}));
    properties.insert("display".to_string(), json!({"type": ["string", "null"]}));
    properties.insert("min".to_string(), json!({"type": ["number", "null"]}));
    properties.insert("max".to_string(), json!({"type": ["number", "null"]}));
    properties.insert("color".to_string(), json!({"type": ["string", "null"]}));
    properties.insert("time_by_default".to_string(), json!({"type": ["boolean", "null"], "description": "date columns: include time by default."}));
    properties.insert(
        "range_by_default".to_string(),
        json!({"type": ["boolean", "null"], "description": "date columns: use ranges by default."}),
    );
    properties.insert("relation".to_string(), json!({"type": ["string", "null"], "description": "relation target collection path in the target scope. Relation field values are linked entry paths inside this collection, not row IDs."}));
    properties.insert("relation_scope".to_string(), relation_scope_schema());
    properties.insert(
        "limit".to_string(),
        json!({"type": ["string", "null"], "enum": ["one", null]}),
    );
    properties.insert("two_way".to_string(), json!({"type": ["string", "null"], "description": "Optional reverse relation column name."}));
    properties.insert(
        "prefix".to_string(),
        json!({"type": ["string", "null"], "description": "unique_id prefix."}),
    );
    properties.insert("next".to_string(), json!({"type": ["integer", "null"], "minimum": 1, "description": "unique_id next counter. unique_id values are read-only on entries."}));
    properties.insert("multiple".to_string(), json!({"type": ["boolean", "null"], "description": "actor columns: true allows multiple canonical email values."}));
    Value::Object(properties)
}

fn relation_scope_schema() -> Value {
    json!({
        "description": "Optional relation target scope. Omit or null for the current scope; use \"root\" for the project root; use {\"type\":\"space\",\"id\":\"<spaceId>\"} for a registered ready child space. Cross-scope relations do not support two_way.",
        "anyOf": [
            { "type": "null" },
            { "type": "string", "enum": ["root"] },
            {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "type": { "type": "string", "enum": ["space"] },
                    "id": { "type": "string", "description": "Svode child space id from list_spaces." }
                },
                "required": ["type", "id"]
            }
        ]
    })
}

fn option_schema() -> Value {
    json!({
        "anyOf": [
            { "type": "string" },
            {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "name": { "type": "string" },
                    "color": { "type": ["string", "null"] },
                    "icon": { "type": ["string", "null"] },
                    "group": { "type": ["string", "null"], "enum": ["todo", "in_progress", "done", null] }
                },
                "required": ["name"]
            }
        ]
    })
}

fn filters_opt(name: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "array",
            "items": filter_schema(),
            "description": "Optional filters. Omit when not filtering."
        }),
    )
}

fn filter_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "field": { "type": "string", "description": "Column name or supported system field." },
            "op": { "type": "string", "enum": ["eq", "neq", "contains", "not_contains", "contains_any", "not_contains_any", "in", "not_in", "gt", "lt", "gte", "lte", "before", "after", "is_empty", "is_not_empty", "group_eq", "group_neq", "group_in", "group_not_in"] },
            "value": { "description": "Single comparison value." },
            "values": { "type": ["array", "null"], "description": "Multiple comparison values for in/contains_any/group_in style operators." }
        },
        "required": ["field", "op"]
    })
}

fn sort_opt(name: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "array",
            "items": sort_schema(),
            "description": "Optional sort clauses. Omit when not sorting."
        }),
    )
}

fn sort_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "field": { "type": "string" },
            "desc": { "type": "boolean", "default": false }
        },
        "required": ["field"]
    })
}

fn views_opt(name: &'static str) -> (&'static str, Value) {
    (
        name,
        nullable(json!({
            "type": "array",
            "items": view_schema(),
            "description": "Optional initial collection views."
        })),
    )
}

fn view_req(name: &'static str) -> (&'static str, Value) {
    (name, view_schema())
}

fn view_patch_req(name: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({
            "type": "object",
            "description": "Partial view patch. Only include settings you intend to change.",
            "additionalProperties": false,
            "properties": view_properties(false)
        }),
    )
}

fn view_schema() -> Value {
    json!({
        "type": "object",
        "description": "Collection view definition. Calendar requires date_field; board group_by should be status/select/single actor; gallery uses card_cover.",
        "additionalProperties": false,
        "properties": view_properties(true),
        "required": ["type", "name"]
    })
}

fn view_properties(include_type_name: bool) -> Value {
    let mut properties = serde_json::Map::new();
    if include_type_name {
        properties.insert(
            "type".to_string(),
            json!({"type": "string", "enum": ["table", "board", "calendar", "list", "gallery"]}),
        );
        properties.insert("name".to_string(), json!({"type": "string"}));
    }
    properties.insert(
        "filter".to_string(),
        json!({"type": ["array", "null"], "items": filter_schema()}),
    );
    properties.insert(
        "sort".to_string(),
        json!({"type": ["array", "null"], "items": sort_schema()}),
    );
    properties.insert(
        "visible_fields".to_string(),
        json!({"type": ["array", "null"], "items": {"type": "string"}}),
    );
    properties.insert(
        "show_nested".to_string(),
        json!({"type": ["boolean", "null"]}),
    );
    properties.insert("group_by".to_string(), json!({"type": ["string", "null"], "description": "Board grouping field; prefer status, select, or single actor."}));
    properties.insert("date_field".to_string(), json!({"type": ["string", "null"], "description": "Calendar date column name. Required for calendar views."}));
    properties.insert(
        "color_field".to_string(),
        json!({"type": ["string", "null"]}),
    );
    properties.insert(
        "default_scope".to_string(),
        json!({"type": ["string", "null"]}),
    );
    properties.insert(
        "card_fields".to_string(),
        json!({"type": ["array", "null"], "items": {"type": "string"}}),
    );
    properties.insert("density".to_string(), json!({"type": ["string", "null"]}));
    properties.insert("card_cover".to_string(), json!({"type": ["array", "null"], "items": {"type": "string"}, "description": "Gallery cover source fields."}));
    properties.insert("cover_fit".to_string(), json!({"type": ["string", "null"]}));
    properties.insert(
        "cover_aspect".to_string(),
        json!({"type": ["string", "null"]}),
    );
    properties.insert("size".to_string(), json!({"type": ["string", "null"]}));
    Value::Object(properties)
}

fn list_actors_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "actors": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "email": { "type": "string", "description": "Canonical email value to write into actor fields." },
                        "name": { "type": "string" },
                        "lastCommitAt": { "type": ["integer", "null"], "description": "Unix timestamp from Git author history." },
                        "commitCount": { "type": "integer", "minimum": 0 },
                        "isMe": { "type": "boolean" }
                    },
                    "required": ["email", "name", "lastCommitAt", "commitCount", "isMe"]
                }
            }
        },
        "required": ["actors"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_publish_delete_and_actors_but_not_get_entry() {
        let names = definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"delete_entry"));
        assert!(names.contains(&"list_actors"));
        assert!(!names.contains(&"get_entry"));
    }

    #[test]
    fn definitions_do_not_emit_empty_output_schemas() {
        for definition in definitions() {
            assert_ne!(
                definition.output_schema,
                Some(obj(vec![])),
                "{}",
                definition.name
            );
        }
    }

    #[test]
    fn list_actors_has_matching_output_schema() {
        let definition = definitions()
            .into_iter()
            .find(|definition| definition.name == "list_actors")
            .expect("list_actors definition");
        assert!(definition.output_schema.is_some());
    }

    #[test]
    fn unique_id_next_schema_matches_backend_minimum() {
        assert_eq!(column_schema()["properties"]["next"]["minimum"], json!(1));
    }

    #[test]
    fn column_schema_documents_relation_scope() {
        let relation_scope = &column_schema()["properties"]["relation_scope"];
        assert_eq!(relation_scope["anyOf"][1]["enum"], json!(["root"]));
        assert_eq!(
            relation_scope["anyOf"][2]["properties"]["type"]["enum"],
            json!(["space"])
        );
    }

    #[test]
    fn space_id_schema_documents_root_target() {
        let (_, schema) = space_id();
        let description = schema["description"].as_str().expect("description");
        assert!(description.contains("\"root\""));
        assert!(description.contains("active/default"));
    }

    #[test]
    fn cover_schema_requires_variant_specific_fields() {
        let (_, schema) = cover_opt("cover");
        let cover_schema = &schema["anyOf"][0];
        let variants = cover_schema["anyOf"].as_array().expect("cover variants");
        let color = variants
            .iter()
            .find(|variant| variant["properties"]["type"]["enum"] == json!(["color"]))
            .expect("color cover variant");
        let image = variants
            .iter()
            .find(|variant| variant["properties"]["type"]["enum"] == json!(["image"]))
            .expect("image cover variant");

        assert_eq!(color["required"], json!(["type", "value"]));
        assert_eq!(image["required"], json!(["type", "path"]));
    }
}
