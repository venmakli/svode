use super::merge_order;
use serde_json::{Value, json};

fn merge(base: Option<Value>, ours: Option<Value>, theirs: Option<Value>) -> String {
    let text = |side: &Option<Value>| side.as_ref().map(|value| value.to_string());
    let (base, ours, theirs) = (text(&base), text(&ours), text(&theirs));
    merge_order(
        base.as_deref().map(str::as_bytes),
        ours.as_deref().map(str::as_bytes),
        theirs.as_deref().map(str::as_bytes),
    )
    .expect("readable sides merge")
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

/// Section keys of the merged text in file order.
fn keys(text: &str) -> Vec<String> {
    crate::content_tree::parse_order(text)
        .unwrap()
        .into_keys()
        .collect()
}

#[test]
fn a_list_changed_by_one_side_is_taken_from_it() {
    let base = json!({".": ["a", "b"], "docs": ["x", "y"]});
    let ours = json!({".": ["b", "a"], "docs": ["x", "y"]});
    let theirs = json!({".": ["a", "b"], "docs": ["y", "x", "z"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(
        parsed(&merged),
        json!({".": ["b", "a"], "docs": ["y", "x", "z"]})
    );
}

#[test]
fn additions_of_both_sides_are_kept_after_their_local_neighbour() {
    let base = json!({".": ["a", "b", "c"]});
    // Local adds `x` after `a` and `w` first; incoming adds `y` at the end.
    let ours = json!({".": ["w", "a", "x", "b", "c"]});
    let theirs = json!({".": ["a", "b", "c", "y"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(
        parsed(&merged),
        json!({".": ["w", "a", "x", "b", "c", "y"]})
    );
}

#[test]
fn consecutive_local_additions_keep_their_order() {
    let base = json!({".": ["a", "b"]});
    let ours = json!({".": ["a", "x", "y", "b"]});
    let theirs = json!({".": ["b", "a", "z"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(parsed(&merged), json!({".": ["b", "a", "x", "y", "z"]}));
}

#[test]
fn removals_of_either_side_are_applied() {
    let base = json!({".": ["a", "b", "c", "d"]});
    let ours = json!({".": ["a", "c", "d", "e"]});
    let theirs = json!({".": ["a", "b", "c", "f"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    // `b` removed locally, `d` removed by the incoming side.
    assert_eq!(parsed(&merged), json!({".": ["a", "c", "e", "f"]}));
}

#[test]
fn a_folder_removed_by_one_side_and_changed_by_the_other_is_kept() {
    let base = json!({".": ["a"], "docs": ["x"], "notes": ["n"]});
    let ours = json!({".": ["a"], "docs": ["x", "y"]});
    let theirs = json!({".": ["a"], "docs": ["x"], "notes": ["n", "m"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(
        parsed(&merged),
        json!({".": ["a"], "docs": ["x", "y"], "notes": ["n", "m"]})
    );
}

#[test]
fn a_folder_removed_by_one_side_and_kept_unchanged_by_the_other_goes() {
    let base = json!({".": ["a"], "docs": ["x"], "notes": ["n"]});
    let ours = json!({".": ["a"], "docs": ["x"]});
    let theirs = json!({".": ["a", "b"], "notes": ["n"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(parsed(&merged), json!({".": ["a", "b"]}));
}

#[test]
fn both_sides_reordering_a_folder_keep_the_incoming_order() {
    let base = json!({".": ["a", "b", "c"]});
    let ours = json!({".": ["c", "b", "a"]});
    let theirs = json!({".": ["b", "c", "a"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(parsed(&merged), json!({".": ["b", "c", "a"]}));
}

#[test]
fn duplicates_are_removed() {
    let base = json!({".": ["a"], "docs": ["x"]});
    let ours = json!({".": ["a", "b", "b"], "docs": ["x", "x"]});
    let theirs = json!({".": ["a", "c", "a"], "docs": ["x"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(
        parsed(&merged),
        json!({".": ["a", "b", "c"], "docs": ["x"]})
    );
}

#[test]
fn a_missing_side_is_an_empty_order() {
    // Both sides added the file.
    let ours = json!({".": ["a", "mine"]});
    let theirs = json!({".": ["a", "theirs"]});

    let merged = merge(None, Some(ours), Some(theirs));

    assert_eq!(parsed(&merged), json!({".": ["a", "mine", "theirs"]}));
}

#[test]
fn the_result_is_deterministic() {
    let base = json!({".": ["a"], "m": ["1"]});
    let theirs = json!({".": ["a", "t"], "m": ["1"], "z": ["9"]});
    // The same local content written in two key orders.
    let ours_one = r#"{".": ["a", "o"], "b": ["2"], "m": ["1"]}"#;
    let ours_two = r#"{"m": ["1"], "b": ["2"], ".": ["a", "o"]}"#;
    let base_text = base.to_string();
    let theirs_text = theirs.to_string();
    let run = |ours: &str| {
        merge_order(
            Some(base_text.as_bytes()),
            Some(ours.as_bytes()),
            Some(theirs_text.as_bytes()),
        )
        .unwrap()
    };

    let first = run(ours_one);

    assert_eq!(first, run(ours_two));
    assert_eq!(first, run(ours_one));
    // Incoming sections keep their place; the local one goes before the
    // first greater key, as the order writer inserts a section.
    assert_eq!(keys(&first), [".", "b", "m", "z"]);
    // The text is the writer's: pretty JSON without a trailing newline.
    assert_eq!(
        first,
        serde_json::to_string_pretty(&parsed(&first)).unwrap()
    );
}

#[test]
fn backslash_keys_are_read_as_slash_keys() {
    let base = json!({"docs/a": ["x"]});
    let ours = json!({"docs\\a": ["x", "y"]});
    let theirs = json!({"docs/a": ["x"]});

    let merged = merge(Some(base), Some(ours), Some(theirs));

    assert_eq!(parsed(&merged), json!({"docs/a": ["x", "y"]}));
}

#[test]
fn an_unreadable_side_is_not_merged() {
    let base = br#"{".": ["a"]}"#;
    let ours = b"<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n";
    let theirs = br#"{".": ["a", "b"]}"#;

    assert_eq!(merge_order(Some(base), Some(ours), Some(theirs)), None);
    assert_eq!(
        merge_order(Some(base), Some(&[0xff, 0xfe]), Some(theirs)),
        None
    );
}
