use super::*;

fn values<'a>(text: &'a str) -> Vec<&'a str> {
    next_spans(text)
        .unwrap()
        .into_iter()
        .map(|span| &text[span])
        .collect()
}

#[test]
fn the_value_of_next_of_the_unique_id_column_is_found_in_block_and_flow_style() {
    let block = "columns:\n- name: Заметка\n  type: text\n- name: Key\n  type: unique_id\n  prefix: Т\n  next: 12\nviews: []\n";
    assert_eq!(values(block), ["12"]);

    let flow = "columns:\n  - { name: Ключ, type: unique_id, prefix: T, next: 7 }\nviews: []\n";
    assert_eq!(values(flow), ["7"]);

    let next_first = "columns:\n  - next: 4\n    name: Key\n    type: unique_id\n";
    assert_eq!(values(next_first), ["4"]);
}

#[test]
fn next_outside_the_unique_id_column_is_not_its_value() {
    let text = "next: 1\ncolumns:\n- name: Count\n  type: number\n  next: 2\n- name: Key\n  type: unique_id\n  options:\n  - next: 3\n  next: 4\nviews:\n- name: next\n  next: 5\n";
    assert_eq!(values(text), ["4"]);
    assert_eq!(values("columns: []\nviews: []\n"), Vec::<&str>::new());
    assert!(next_spans("columns: [\n").is_none());
}

#[test]
fn masking_changes_only_the_value_of_next() {
    let text = "columns:\n- name: Заметка\n  type: text\n- name: Key\n  type: unique_id\n  next: 12 # counter\nviews: []\n";
    assert_eq!(
        mask(text).unwrap(),
        format!(
            "columns:\n- name: Заметка\n  type: text\n- name: Key\n  type: unique_id\n  next: {MASK} # counter\nviews: []\n"
        )
    );
}

#[test]
fn only_a_collection_schema_path_is_claimed() {
    assert!(is_schema_path("schema.yaml"));
    assert!(is_schema_path("tasks/schema.yaml"));
    assert!(!is_schema_path("tasks/old-schema.yaml"));
    assert!(!is_schema_path("tasks/schema.yaml.md"));
    assert_eq!(
        collection_dir("tasks/sub/schema.yaml"),
        Path::new("tasks/sub")
    );
    assert_eq!(collection_dir("schema.yaml"), Path::new(""));
}
