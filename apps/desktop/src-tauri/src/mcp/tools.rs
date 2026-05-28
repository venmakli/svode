use serde_json::{Value, json};

use super::protocol::ToolDefinition;

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        def(
            "get_project_info",
            "Return the active Svode project and capabilities.",
            obj(vec![]),
            obj(vec![]),
        ),
        def(
            "list_spaces",
            "List spaces in the active project.",
            obj(vec![]),
            obj(vec![]),
        ),
        def(
            "list_documents",
            "List markdown documents in a space. spaceId null uses the active/default space.",
            schema(
                &[
                    space_id(),
                    str_opt("path"),
                    int_opt("limit"),
                    int_opt("offset"),
                ],
                &[],
            ),
            obj(vec![]),
        ),
        def(
            "read_document",
            "Read a markdown document by repo-relative path.",
            schema(&[space_id(), str_req("path")], &["path"]),
            obj(vec![]),
        ),
        def(
            "write_document",
            "Replace a markdown document body. Use this instead of direct filesystem writes so Svode preserves metadata, validates paths, and reports changedPaths. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("path"),
                    str_req("content"),
                    str_opt("title"),
                ],
                &["path", "content"],
            ),
            obj(vec![]),
        ),
        def(
            "create_document",
            "Create a regular Svode markdown document, not a collection. Use create_collection for structured data like tasks, CRM contacts, OKRs, backlog rows, assets, or any list/table/board/calendar content. Paths without extension become .md; trailing slash creates README.md.",
            schema(
                &[
                    space_id(),
                    str_req("path"),
                    str_opt("content"),
                    str_opt("title"),
                    str_opt("icon"),
                    str_opt("description"),
                    obj_opt("cover"),
                ],
                &["path"],
            ),
            obj(vec![]),
        ),
        def(
            "update_document_metadata",
            "Update document or collection README metadata: title, icon, description, and cover. Does not change body and does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("path"),
                    str_opt("title"),
                    str_opt("icon"),
                    str_opt("description"),
                    obj_opt("cover"),
                ],
                &["path"],
            ),
            obj(vec![]),
        ),
        def(
            "create_collection",
            "Create a Svode collection: a directory with README.md identity plus schema.yaml. Use for structured data, tables, boards, calendars, CRM, OKRs, tasks, backlog, inventories, and repeated records. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("path"),
                    str_req("title"),
                    str_opt("icon"),
                    str_opt("description"),
                    obj_opt("cover"),
                    str_opt("body"),
                    arr_opt("columns"),
                    arr_opt("views"),
                    str_opt("documentLabel"),
                ],
                &["path", "title"],
            ),
            obj(vec![]),
        ),
        def(
            "convert_to_collection",
            "Convert an existing markdown leaf, folder document, or bare folder into a Svode collection by adding schema.yaml. Use when content already exists but should become structured records. Does not autocommit.",
            schema(&[space_id(), str_req("path")], &["path"]),
            obj(vec![]),
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
            obj(vec![]),
        ),
        def(
            "list_collections",
            "List collections in a space.",
            schema(&[space_id()], &[]),
            obj(vec![]),
        ),
        def(
            "get_collection_schema",
            "Read a collection schema including sensitivity metadata.",
            schema(
                &[space_id(), str_req("collectionPath")],
                &["collectionPath"],
            ),
            obj(vec![]),
        ),
        def(
            "query_entries",
            "Query entries from an existing collection. Use list_collections first if you are unsure whether a collection exists.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    arr_opt("filters"),
                    arr_opt("sort"),
                    int_opt("limit"),
                    int_opt("offset"),
                ],
                &["collectionPath"],
            ),
            obj(vec![]),
        ),
        def(
            "create_entry",
            "Create one record inside an existing collection. The collectionPath must already contain schema.yaml; this tool does not create collections. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    str_req("title"),
                    str_opt("body"),
                    str_opt("icon"),
                    str_opt("description"),
                    obj_opt("cover"),
                    obj_opt("fields"),
                ],
                &["collectionPath", "title"],
            ),
            obj(vec![]),
        ),
        def(
            "update_entry_fields",
            "Update entry frontmatter fields. Does not autocommit.",
            schema(
                &[space_id(), str_req("path"), obj_req("fields")],
                &["path", "fields"],
            ),
            obj(vec![]),
        ),
        def(
            "update_entry_body",
            "Replace entry body. Does not autocommit.",
            schema(
                &[space_id(), str_req("path"), str_req("body")],
                &["path", "body"],
            ),
            obj(vec![]),
        ),
        def(
            "add_collection_column",
            "Add a schema column to an existing collection. Column is a Svode Column object with name, type, and type-specific options. Does not autocommit.",
            schema(
                &[space_id(), str_req("collectionPath"), obj_req("column")],
                &["collectionPath", "column"],
            ),
            obj(vec![]),
        ),
        def(
            "update_collection_column",
            "Patch configurable settings of an existing collection column, such as options, display, color, sensitivity, relation, or date settings. For new fields prefer add_collection_column. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    str_req("columnName"),
                    obj_req("patch"),
                ],
                &["collectionPath", "columnName", "patch"],
            ),
            obj(vec![]),
        ),
        def(
            "delete_collection_column",
            "Delete a collection column. Set deleteValues true only when the stored values should also be removed from entries. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    str_req("columnName"),
                    bool_opt("deleteValues"),
                ],
                &["collectionPath", "columnName"],
            ),
            obj(vec![]),
        ),
        def(
            "add_collection_view",
            "Add a table, board, calendar, list, or gallery view to an existing collection schema. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    obj_req("view"),
                    int_opt("position"),
                ],
                &["collectionPath", "view"],
            ),
            obj(vec![]),
        ),
        def(
            "update_collection_view",
            "Patch an existing collection view: filters, sort, visible_fields, card_fields, group_by, date_field, gallery cover settings, and related view settings. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    str_req("viewName"),
                    obj_req("patch"),
                ],
                &["collectionPath", "viewName", "patch"],
            ),
            obj(vec![]),
        ),
        def(
            "delete_collection_view",
            "Delete a named collection view. The implicit README Document tab is not a schema view and cannot be deleted through this tool. Does not autocommit.",
            schema(
                &[space_id(), str_req("collectionPath"), str_req("viewName")],
                &["collectionPath", "viewName"],
            ),
            obj(vec![]),
        ),
        def(
            "get_git_status",
            "Return read-only Git status for the active/default or selected space. This is only for review/reporting pending changes; Svode app owns commit/sync/autocommit flows.",
            schema(&[space_id()], &[]),
            obj(vec![]),
        ),
        def(
            "get_svode_guide",
            "Return agent-facing guidance for working with Svode documents, collections, entries, metadata, and schema tools.",
            obj(vec![]),
            obj(vec![]),
        ),
    ]
}

pub fn guide_text() -> &'static str {
    r#"Svode MCP guide:
- A regular document is a markdown file or a folder README.md. Use create_document for narrative notes, specs, plans, and one-off pages.
- A collection is a directory with schema.yaml plus README.md identity. Use create_collection for repeated structured data: tasks, backlog, CRM contacts, customers, OKRs, assets, inventory, bugs, sprints, meetings, or anything that should be queried, filtered, sorted, or shown as a table/board/calendar/list/gallery.
- A collection entry is a markdown document inside an existing collection. Use create_entry only after the collection exists. It creates one record and stores schema fields in frontmatter.
- Collection identity lives in README.md metadata: title, icon, description, cover. Schema.yaml stores structure only: columns, views, system field labels, document label, and template settings.
- Prefer domain operations over direct filesystem writes. Use update_document_metadata for title/icon/description/cover, schema tools for columns/views, write_document for body replacement, and update_entry_fields for entry properties.
- Do not create plain folders full of loose documents when the user asks for a database, table, tracker, CRM, OKR tree, backlog, kanban, calendar, or structured list. Create a collection with meaningful columns and views, then create entries.
- For select/status fields, define options with useful colors/icons when possible. For email and phone fields, use type email/phone and sensitivity pii when appropriate.
- Mutating tools do not autocommit. They return changedPaths. Use get_git_status only when you need a read-only review of pending repository changes; the user commits/syncs in Svode."#
}

fn def(
    name: &'static str,
    description: &'static str,
    input_schema: Value,
    output_schema: Value,
) -> ToolDefinition {
    ToolDefinition {
        name,
        description,
        input_schema,
        output_schema,
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

fn space_id() -> (&'static str, Value) {
    (
        "spaceId",
        json!({"type": ["string", "null"], "description": "Svode space id. null uses the active/default space."}),
    )
}

fn str_req(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": "string"}))
}

fn str_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["string", "null"]}))
}

fn int_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["integer", "null"], "minimum": 0}))
}

fn arr_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["array", "null"]}))
}

fn bool_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["boolean", "null"]}))
}

fn obj_req(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": "object"}))
}

fn obj_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["object", "null"]}))
}
