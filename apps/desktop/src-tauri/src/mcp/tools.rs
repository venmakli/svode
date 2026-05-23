use serde_json::{Value, json};

use super::protocol::ToolDefinition;

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        def(
            "get_project_info",
            "Return the active CombAI project and capabilities.",
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
            "Replace a markdown document body. Does not autocommit.",
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
            "Create a markdown document. Paths without extension become .md; trailing slash creates README.md.",
            schema(
                &[
                    space_id(),
                    str_req("path"),
                    str_opt("content"),
                    str_opt("title"),
                ],
                &["path"],
            ),
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
            "Query collection entries with filters, sorts, limit and offset.",
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
            "get_entry",
            "Read a collection entry frontmatter and body.",
            schema(&[space_id(), str_req("path")], &["path"]),
            obj(vec![]),
        ),
        def(
            "create_entry",
            "Create a collection entry. Does not autocommit.",
            schema(
                &[
                    space_id(),
                    str_req("collectionPath"),
                    str_req("title"),
                    str_opt("body"),
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
            "get_git_status",
            "Return git status for the active/default or selected space.",
            schema(&[space_id()], &[]),
            obj(vec![]),
        ),
    ]
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
        json!({"type": ["string", "null"], "description": "CombAI space id. null uses the active/default space."}),
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

fn obj_req(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": "object"}))
}

fn obj_opt(name: &'static str) -> (&'static str, Value) {
    (name, json!({"type": ["object", "null"]}))
}
