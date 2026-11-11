use std::collections::BTreeSet;
use std::fs;

use tempfile::TempDir;

use super::*;

fn rules(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|path| path.to_string()).collect()
}

#[test]
fn an_inline_space_delete_drops_the_rules_of_its_repository_relative_paths() {
    let tmp = TempDir::new().unwrap();
    let project = tmp.path();
    let space = project.join("eng");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&space).unwrap();
    let gitignore = project.join(".gitignore");
    let before = rewrite_managed_path_block(
        "node_modules/\n",
        LOCAL_PATHS_START,
        LOCAL_PATHS_END,
        &rules(&["Notes/scan.bin", "eng/Notes/scan.bin", "eng/Notes.bin"]),
        false,
    );
    fs::write(&gitignore, &before).unwrap();

    let dropped =
        drop_managed_attachment_local_routes(space.to_str().unwrap(), project.to_str(), "Notes")
            .unwrap()
            .expect("a rule of the deleted tree");

    assert_eq!(dropped.path(), gitignore);
    let after = fs::read_to_string(&gitignore).unwrap();
    assert_eq!(
        parse_managed_paths(&after, LOCAL_PATHS_START, LOCAL_PATHS_END).unwrap(),
        rules(&["Notes/scan.bin", "eng/Notes.bin"])
    );
    assert!(after.starts_with("node_modules/\n"));

    dropped.restore().unwrap();
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);
}

#[test]
fn a_space_repository_delete_without_a_ruled_path_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join(".git")).unwrap();
    let space = space.to_str().unwrap();

    // No `.gitignore` at all.
    assert!(
        drop_managed_attachment_local_routes(space, None, "Notes")
            .unwrap()
            .is_none()
    );
    assert!(!tmp.path().join(".gitignore").exists());

    let gitignore = tmp.path().join(".gitignore");
    let before = rewrite_managed_path_block(
        "",
        LOCAL_PATHS_START,
        LOCAL_PATHS_END,
        &rules(&["Other/scan.bin"]),
        false,
    );
    fs::write(&gitignore, &before).unwrap();
    assert!(
        drop_managed_attachment_local_routes(space, Some("/elsewhere"), "Notes")
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);

    // The only rule gone removes the generated-only file.
    let dropped = drop_managed_attachment_local_routes(space, None, "Other")
        .unwrap()
        .expect("the ruled path");
    assert!(!gitignore.exists());
    dropped.restore().unwrap();
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);
}
