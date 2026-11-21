//! Files without markers resolved as a whole (module 01, 1.F, items 4–6):
//! the version of a side, the deletion of the path and «Сохранить обе».
use super::*;

const POINTER_BASE: &[u8] =
    b"version https://git-lfs.github.com/spec/v1\noid sha256:aaaa\nsize 1\n";
const POINTER_THEIRS: &[u8] =
    b"version https://git-lfs.github.com/spec/v1\noid sha256:cccc\nsize 3000\n";
const POINTER_OURS: &[u8] =
    b"version https://git-lfs.github.com/spec/v1\noid sha256:bbbb\nsize 2000\n";

async fn resolve_as(merge: &Merge, path: &str, resolution: FileResolution) -> SyncResult {
    resolve(&merge.cli, &merge.local, path, &resolution)
        .await
        .unwrap()
}

fn bytes_of(repo: &Path, file: &str) -> Vec<u8> {
    std::fs::read(repo.join(file)).unwrap()
}

fn keep_both(language: MessageLanguage) -> FileResolution {
    FileResolution::KeepBoth { language }
}

fn unmerged(merge: &Merge) -> String {
    git(&merge.local, &["ls-files", "--unmerged"])
}

/// One binary file changed on both sides.
async fn binary(path: &'static str, extra: &'static [(&'static str, &'static [u8])]) -> Merge {
    let (merge, result) = Merge::new(
        "",
        |repo| {
            write(repo, path, b"PNG\0base");
            for (file, content) in extra {
                write(repo, file, content);
            }
        },
        |repo| write(repo, path, b"PNG\0theirs"),
        |repo| write(repo, path, b"PNG\0ours, longer"),
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    merge
}

#[tokio::test]
async fn a_binary_file_names_what_each_side_did() {
    let merge = binary("image.png", &[]).await;
    let file = merge.places("image.png").await;
    assert_eq!(file.kind, ConflictKind::Binary);
    assert!(file.binary);
    assert_eq!(file.places, None);
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.change, Change::Modified);
    assert_eq!(changes.ours.size, Some(16));
    assert_eq!(changes.theirs.change, Change::Modified);
    assert_eq!(changes.theirs.size, Some(10));
}

#[tokio::test]
async fn a_binary_file_takes_the_version_of_a_side() {
    let (merge, _) = Merge::new(
        "",
        |repo| {
            write(repo, "a.png", b"PNG\0base");
            write(repo, "b.png", b"PNG\0base");
        },
        |repo| {
            write(repo, "a.png", b"PNG\0theirs");
            write(repo, "b.png", b"PNG\0theirs");
        },
        |repo| {
            write(repo, "a.png", b"PNG\0ours");
            write(repo, "b.png", b"PNG\0ours");
        },
    )
    .await;
    let result = resolve_as(&merge, "a.png", FileResolution::Side { side: Side::Theirs }).await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "a.png"), b"PNG\0theirs");
    let result = resolve_as(&merge, "b.png", FileResolution::Side { side: Side::Ours }).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "b.png"), b"PNG\0ours");
    assert!(!merge.merging());
    // No temporary version is left behind.
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn keep_both_puts_the_incoming_version_beside_mine_with_a_number_when_taken() {
    let merge = binary(
        "media/image.png",
        &[("media/image (incoming).png", b"taken")],
    )
    .await;
    let result = resolve_as(&merge, "media/image.png", keep_both(MessageLanguage::En)).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        bytes_of(&merge.local, "media/image.png"),
        b"PNG\0ours, longer"
    );
    assert_eq!(
        bytes_of(&merge.local, "media/image (incoming)-1.png"),
        b"PNG\0theirs"
    );
    assert_eq!(
        bytes_of(&merge.local, "media/image (incoming).png"),
        b"taken"
    );
    // The copy is part of the merge.
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
    assert_eq!(
        git(&merge.local, &["show", "HEAD:media/image (incoming)-1.png"]),
        "PNG\0theirs"
    );
}

#[tokio::test]
async fn keep_both_names_the_copy_in_the_interface_language() {
    let merge = binary("image.png", &[]).await;
    let result = resolve_as(&merge, "image.png", keep_both(MessageLanguage::Ru)).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        bytes_of(&merge.local, "image (входящая).png"),
        b"PNG\0theirs"
    );
    assert_eq!(incoming_suffix(MessageLanguage::En), "(incoming)");
    assert_eq!(incoming_suffix(MessageLanguage::Ru), "(входящая)");
    // The host fills the language in; the transport carries only the action.
    let parsed: FileResolution = serde_json::from_str(r#"{"type":"keepBoth"}"#).unwrap();
    assert_eq!(
        parsed.in_language(MessageLanguage::Ru),
        keep_both(MessageLanguage::Ru)
    );
    let parsed: FileResolution = serde_json::from_str(r#"{"type":"delete"}"#).unwrap();
    assert_eq!(parsed, FileResolution::Delete);
}

/// An LFS file changed on both sides; `filters` sets the LFS filter of the
/// local clone after the merge stopped.
async fn lfs(filters: &[(&str, &str)]) -> Merge {
    let (merge, result) = Merge::new(
        "lfs.bin filter=lfs\n",
        |repo| write(repo, "lfs.bin", POINTER_BASE),
        |repo| write(repo, "lfs.bin", POINTER_THEIRS),
        |repo| write(repo, "lfs.bin", POINTER_OURS),
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    for (key, value) in filters {
        git(&merge.local, &["config", key, value]);
    }
    merge
}

#[tokio::test]
async fn a_failing_lfs_filter_leaves_the_path_unresolved_with_the_reason() {
    let merge = lfs(&[
        ("filter.lfs.smudge", "false"),
        ("filter.lfs.required", "true"),
    ])
    .await;
    let file = merge.places("lfs.bin").await;
    assert_eq!(file.kind, ConflictKind::Binary);
    // The sizes of the objects, not of the pointers.
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.size, Some(2000));
    assert_eq!(changes.theirs.size, Some(3000));
    // Git merged the pointers as text; that working file stays as it is.
    let before = bytes_of(&merge.local, "lfs.bin");
    for resolution in [
        FileResolution::Side { side: Side::Theirs },
        keep_both(MessageLanguage::En),
    ] {
        let result = resolve_as(&merge, "lfs.bin", resolution).await;
        let SyncResult::Unresolved {
            path,
            finding: ResolutionFinding::LfsObject { message },
        } = result
        else {
            panic!("{result:?}");
        };
        assert_eq!(path, "lfs.bin");
        assert!(message.contains("smudge filter lfs failed"), "{message}");
        // Nothing was written: my version stays, no copy, still in conflict.
        assert_eq!(bytes_of(&merge.local, "lfs.bin"), before);
        assert!(!merge.local.join("lfs (incoming).bin").exists());
        assert!(unmerged(&merge).contains("lfs.bin"));
        assert!(merge.merging());
    }
}

#[tokio::test]
async fn the_incoming_lfs_version_is_taken_as_its_pointer() {
    // Resolving downloads no LFS content (DF-377 R6): the pointer is the
    // version; the download after the sync brings its object.
    let merge = lfs(&[]).await;
    let result = resolve_as(
        &merge,
        "lfs.bin",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "lfs.bin"), POINTER_THEIRS);
    assert!(!merge.merging());
}

#[tokio::test]
async fn modify_delete_keeps_the_edited_file_or_deletes_it() {
    let (merge, _) = Merge::new(
        "",
        |repo| {
            write(repo, "edited.txt", b"one\n");
            write(repo, "gone.txt", b"keep\n");
        },
        |repo| {
            std::fs::remove_file(repo.join("edited.txt")).unwrap();
            write(repo, "gone.txt", b"keep, theirs\n");
        },
        |repo| {
            write(repo, "edited.txt", b"one, ours\n");
            std::fs::remove_file(repo.join("gone.txt")).unwrap();
        },
    )
    .await;
    let file = merge.places("edited.txt").await;
    assert_eq!(file.kind, ConflictKind::ModifyDelete);
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.change, Change::Modified);
    assert_eq!(changes.theirs.change, Change::Deleted);
    let file = merge.places("gone.txt").await;
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.change, Change::Deleted);
    assert_eq!(changes.theirs.change, Change::Modified);
    // Both sides of an edit and a deletion cannot be kept.
    let error = resolve(
        &merge.cli,
        &merge.local,
        "gone.txt",
        &keep_both(MessageLanguage::En),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, GitError::Conflict(_)), "{error:?}");
    let result = resolve_as(&merge, "edited.txt", FileResolution::Delete).await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert!(!merge.local.join("edited.txt").exists());
    // «Оставить с правками» of the incoming edit.
    let result = resolve_as(
        &merge,
        "gone.txt",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "gone.txt"), "keep, theirs\n");
    assert_eq!(git(&merge.local, &["ls-files", "edited.txt"]), "");
}

#[tokio::test]
async fn keep_with_edits_resolves_modify_delete_with_the_edited_side() {
    let (merge, result) = Merge::new(
        "",
        |repo| {
            write(repo, "mine.txt", b"one\n");
            write(repo, "incoming.txt", b"two\n");
        },
        |repo| {
            std::fs::remove_file(repo.join("mine.txt")).unwrap();
            write(repo, "incoming.txt", b"two, theirs\n");
        },
        |repo| {
            write(repo, "mine.txt", b"one, ours\n");
            std::fs::remove_file(repo.join("incoming.txt")).unwrap();
        },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(
        git(&merge.local, &["status", "--porcelain"]),
        "DU incoming.txt\nUD mine.txt"
    );
    // `DU`: «Оставить с правками» keeps the incoming edited version.
    let result = resolve_as(
        &merge,
        "incoming.txt",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "incoming.txt"), "two, theirs\n");
    assert_eq!(git(&merge.local, &["show", ":incoming.txt"]), "two, theirs");
    assert_eq!(unmerged(&merge).lines().count(), 2, "{}", unmerged(&merge));
    assert!(!unmerged(&merge).contains("incoming.txt"));
    assert!(merge.merging());
    // `UD`: «Оставить с правками» keeps my edited version; the last resolved
    // path finishes the merge.
    let result = resolve_as(
        &merge,
        "mine.txt",
        FileResolution::Side { side: Side::Ours },
    )
    .await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert!(!merge.merging());
    assert_eq!(unmerged(&merge), "");
    assert_eq!(text_of(&merge.local, "mine.txt"), "one, ours\n");
    assert_eq!(git(&merge.local, &["show", ":mine.txt"]), "one, ours");
    assert_eq!(git(&merge.local, &["show", "HEAD:mine.txt"]), "one, ours");
    assert_eq!(
        git(&merge.local, &["show", "HEAD:incoming.txt"]),
        "two, theirs"
    );
    assert_eq!(git(&merge.local, &["rev-list", "--count", "HEAD^@"]), "3");
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn add_add_keeps_both_versions_of_a_text_file() {
    let (merge, _) = Merge::new(
        "",
        |_| {},
        |repo| write(repo, "notes/both.txt", b"theirs\n"),
        |repo| write(repo, "notes/both.txt", b"ours\n"),
    )
    .await;
    let file = merge.places("notes/both.txt").await;
    assert_eq!(file.kind, ConflictKind::AddAdd);
    assert!(!file.binary);
    // A text file of its kind: places, and what each side did.
    assert!(matches!(file.places, Some(Places::Places { .. })));
    assert!(file.changes.is_none());
    let result = resolve_as(&merge, "notes/both.txt", keep_both(MessageLanguage::En)).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "notes/both.txt"), "ours\n");
    assert_eq!(
        text_of(&merge.local, "notes/both (incoming).txt"),
        "theirs\n"
    );
}

#[tokio::test]
async fn add_add_of_a_binary_file_resolves_as_a_binary_file() {
    let (merge, _) = Merge::new(
        "",
        |_| {},
        |repo| write(repo, "image.png", b"PNG\0theirs"),
        |repo| write(repo, "image.png", b"PNG\0ours"),
    )
    .await;
    let file = merge.places("image.png").await;
    assert_eq!(file.kind, ConflictKind::AddAdd);
    assert!(file.binary);
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.change, Change::Added);
    assert_eq!(changes.theirs.size, Some(10));
    let result = resolve_as(
        &merge,
        "image.png",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "image.png"), b"PNG\0theirs");
}

#[tokio::test]
async fn a_page_copy_goes_right_after_the_original() {
    let order = "{\n  \".\": [\n    \"README.md\",\n    \"Plan.md\",\n    \"Last.md\"\n  ]\n}";
    let (merge, _) = Merge::new(
        "",
        |repo| {
            write(repo, ".svode/order.json", order.as_bytes());
            write(repo, "Last.md", b"---\ntitle: Last\n---\n");
        },
        |repo| write(repo, "Plan.md", b"---\ntitle: Plan\n---\nTheirs\n"),
        |repo| write(repo, "Plan.md", b"---\ntitle: Plan\n---\nOurs\n"),
    )
    .await;
    let result = resolve_as(&merge, "Plan.md", keep_both(MessageLanguage::Ru)).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        text_of(&merge.local, "Plan.md"),
        "---\ntitle: Plan\n---\nOurs\n"
    );
    let copy = text_of(&merge.local, "Plan (входящая).md");
    assert!(copy.contains("title: Plan (входящая)"), "{copy}");
    assert!(copy.ends_with("Theirs\n"), "{copy}");
    let order: serde_json::Value =
        serde_json::from_str(&text_of(&merge.local, ".svode/order.json")).unwrap();
    assert_eq!(
        order["."],
        serde_json::json!(["README.md", "Plan.md", "Plan (входящая).md", "Last.md"])
    );
    // The copy and its place in the order are part of the merge.
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
}

/// An add/add Page `Plan.md` beside `Alpha.md` and `Zeta.md`; `order` is the
/// order file of the base, if any.
async fn page_add_add(order: Option<&'static str>) -> Merge {
    let (merge, result) = Merge::new(
        "",
        |repo| {
            if let Some(order) = order {
                write(repo, ".svode/order.json", order.as_bytes());
            }
            write(repo, "Alpha.md", b"---\ntitle: Alpha\n---\n");
            write(repo, "Zeta.md", b"---\ntitle: Zeta\n---\n");
        },
        |repo| write(repo, "Plan.md", b"---\ntitle: Plan\n---\nTheirs\n"),
        |repo| write(repo, "Plan.md", b"---\ntitle: Plan\n---\nOurs\n"),
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    merge
}

fn visible_names(repo: &Path) -> Vec<String> {
    crate::content_tree::list_tree_children(repo.to_str().unwrap(), None)
        .unwrap()
        .into_iter()
        .map(|child| child.name)
        .collect()
}

fn order_of(repo: &Path) -> serde_json::Value {
    serde_json::from_str(&text_of(repo, ".svode/order.json")).unwrap()
}

#[tokio::test]
async fn a_page_copy_goes_right_after_the_original_without_an_explicit_order() {
    let merge = page_add_add(None).await;
    assert!(!merge.local.join(".svode/order.json").exists());
    assert_eq!(
        visible_names(&merge.local),
        ["Alpha.md", "Plan.md", "Zeta.md"]
    );
    let result = resolve_as(&merge, "Plan.md", keep_both(MessageLanguage::En)).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    let expected = ["Alpha.md", "Plan.md", "Plan (incoming).md", "Zeta.md"];
    assert_eq!(visible_names(&merge.local), expected);
    assert_eq!(order_of(&merge.local), serde_json::json!({ ".": expected }));
    // The new order file is part of the merge.
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
    assert!(git(&merge.local, &["show", "HEAD:.svode/order.json"]).contains("Plan (incoming).md"));
}

#[tokio::test]
async fn a_page_copy_goes_right_after_the_original_missing_from_a_partial_order() {
    let order = "{\n  \".\": [\n    \"Zeta.md\"\n  ],\n  \"zz\": [\n    \"x.md\"\n  ]\n}";
    let merge = page_add_add(Some(order)).await;
    assert_eq!(
        visible_names(&merge.local),
        ["Zeta.md", "Alpha.md", "Plan.md"]
    );
    let result = resolve_as(&merge, "Plan.md", keep_both(MessageLanguage::En)).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    let expected = ["Zeta.md", "Alpha.md", "Plan.md", "Plan (incoming).md"];
    assert_eq!(visible_names(&merge.local), expected);
    // Another section stays as it is, in its place.
    let text = text_of(&merge.local, ".svode/order.json");
    assert_eq!(
        crate::content_tree::parse_order(&text)
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>(),
        [
            (".".to_string(), expected.map(str::to_string).to_vec()),
            ("zz".to_string(), vec!["x.md".to_string()]),
        ]
    );
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn a_page_copy_leaves_an_order_in_conflict_untouched() {
    // Both sides change the order and mine is not an order: it stays in
    // conflict with its markers.
    let (merge, result) = Merge::new(
        "",
        |repo| write(repo, ".svode/order.json", br#"{".": ["Alpha.md"]}"#),
        |repo| {
            write(
                repo,
                ".svode/order.json",
                br#"{".": ["Alpha.md", "Plan.md"]}"#,
            );
            write(repo, "Plan.md", b"---\ntitle: Plan\n---\nTheirs\n");
        },
        |repo| {
            write(repo, ".svode/order.json", br#"{".": "mine"}"#);
            write(repo, "Plan.md", b"---\ntitle: Plan\n---\nOurs\n");
        },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    let before = bytes_of(&merge.local, ".svode/order.json");
    assert!(String::from_utf8_lossy(&before).contains("<<<<<<<"));
    let result = resolve_as(&merge, "Plan.md", keep_both(MessageLanguage::En)).await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    // The Page is resolved with its copy; the order is neither written nor
    // staged.
    assert_eq!(bytes_of(&merge.local, ".svode/order.json"), before);
    let unmerged = unmerged(&merge);
    assert!(!unmerged.contains("Plan"), "{unmerged}");
    assert!(unmerged.contains(".svode/order.json"), "{unmerged}");
    assert!(merge.local.join("Plan (incoming).md").exists());
    assert!(!git(&merge.local, &["ls-files", "--stage", "Plan (incoming).md"]).is_empty());
}

async fn renames() -> Merge {
    let (merge, _) = Merge::new(
        "",
        |repo| {
            write(repo, "moved.txt", b"line 1\nline 2\nline 3\nline 4\n");
            write(repo, "renamed.txt", b"rename me\nplease\n");
            write(repo, "dropped.txt", b"drop me\nplease\n");
        },
        |repo| {
            git(repo, &["mv", "moved.txt", "moved-theirs.txt"]);
            write(
                repo,
                "moved-theirs.txt",
                b"line 1\nline 2\nline 3\nline 4 theirs\n",
            );
            std::fs::remove_file(repo.join("renamed.txt")).unwrap();
            git(repo, &["mv", "dropped.txt", "dropped-theirs.txt"]);
        },
        |repo| {
            git(repo, &["mv", "moved.txt", "moved-ours.txt"]);
            write(
                repo,
                "moved-ours.txt",
                b"line 1 ours\nline 2\nline 3\nline 4\n",
            );
            git(repo, &["mv", "renamed.txt", "renamed-ours.txt"]);
            std::fs::remove_file(repo.join("dropped.txt")).unwrap();
        },
    )
    .await;
    merge
}

#[tokio::test]
async fn rename_rename_keeps_the_name_of_a_side() {
    let merge = renames().await;
    let file = merge.places("moved-ours.txt").await;
    assert_eq!(file.kind, ConflictKind::RenameRename);
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.change, Change::Renamed);
    assert_eq!(changes.ours.path.as_deref(), Some("moved-ours.txt"));
    assert_eq!(changes.theirs.path.as_deref(), Some("moved-theirs.txt"));
    // Any name of the conflict reads the same pair.
    let other = merge.places("moved.txt").await;
    assert_eq!(
        other.changes.unwrap().theirs.path.as_deref(),
        Some("moved-theirs.txt")
    );
    let result = resolve_as(
        &merge,
        "moved-ours.txt",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    // The incoming name with the content Git merged; the other names are gone.
    assert_eq!(
        text_of(&merge.local, "moved-theirs.txt"),
        "line 1 ours\nline 2\nline 3\nline 4 theirs\n"
    );
    assert!(!merge.local.join("moved-ours.txt").exists());
    let left = unmerged(&merge);
    assert!(!left.contains("moved"), "{left}");
}

#[tokio::test]
async fn rename_delete_keeps_the_new_name_or_deletes_it() {
    let merge = renames().await;
    let file = merge.places("renamed-ours.txt").await;
    assert_eq!(file.kind, ConflictKind::RenameDelete);
    let changes = file.changes.unwrap();
    assert_eq!(changes.ours.change, Change::Renamed);
    assert_eq!(changes.ours.path.as_deref(), Some("renamed-ours.txt"));
    assert_eq!(changes.theirs.change, Change::Deleted);
    let result = resolve_as(
        &merge,
        "moved-ours.txt",
        FileResolution::Side { side: Side::Ours },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    let result = resolve_as(&merge, "renamed-ours.txt", FileResolution::Delete).await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert!(!merge.local.join("renamed-ours.txt").exists());
    // «Оставить под новым именем» of the incoming rename.
    let result = resolve_as(
        &merge,
        "dropped-theirs.txt",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        text_of(&merge.local, "dropped-theirs.txt"),
        "drop me\nplease\n"
    );
    assert_eq!(
        text_of(&merge.local, "moved-ours.txt"),
        "line 1 ours\nline 2\nline 3\nline 4 theirs\n"
    );
    assert!(!merge.merging());
}

/// Two Pages edited against a deletion: mine is edited by me and deleted by
/// the colleague (`UD`), the incoming one the other way round (`DU`).
async fn edited_against_deleted() -> Merge {
    let (merge, result) = Merge::new(
        "",
        |repo| {
            write(repo, "mine.md", b"---\ntitle: Mine\n---\nOne\n");
            write(repo, "incoming.md", b"---\ntitle: Incoming\n---\nTwo\n");
        },
        |repo| {
            std::fs::remove_file(repo.join("mine.md")).unwrap();
            write(
                repo,
                "incoming.md",
                b"---\ntitle: Incoming\n---\nTwo, theirs\n",
            );
        },
        |repo| {
            write(repo, "mine.md", b"---\ntitle: Mine\n---\nOne, ours\n");
            std::fs::remove_file(repo.join("incoming.md")).unwrap();
        },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(
        git(&merge.local, &["status", "--porcelain"]),
        "DU incoming.md\nUD mine.md"
    );
    merge
}

#[tokio::test]
async fn keep_with_edits_keeps_the_working_file_edited_after_the_merge() {
    // DF-354 R6: what was written after the merge, by the editor after
    // «Позже», an agent or another editor, is what «Оставить с правками»
    // keeps, in both directions.
    let merge = edited_against_deleted().await;
    let incoming = "---\ntitle: Incoming\n---\nTwo, theirs\nTyped after Later.\n";
    let mine = "---\ntitle: Mine\n---\nOne, ours\nTyped after Later.\n";
    write(&merge.local, "incoming.md", incoming.as_bytes());
    write(&merge.local, "mine.md", mine.as_bytes());
    let result = resolve_as(
        &merge,
        "incoming.md",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "incoming.md"), incoming);
    assert_eq!(
        git(&merge.local, &["show", ":incoming.md"]),
        incoming.trim_end()
    );
    assert!(!unmerged(&merge).contains("incoming.md"));
    let result = resolve_as(&merge, "mine.md", FileResolution::Side { side: Side::Ours }).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert!(!merge.merging());
    assert_eq!(text_of(&merge.local, "mine.md"), mine);
    assert_eq!(
        git(&merge.local, &["show", "HEAD:mine.md"]),
        mine.trim_end()
    );
    assert_eq!(
        git(&merge.local, &["show", "HEAD:incoming.md"]),
        incoming.trim_end()
    );
    assert_eq!(git(&merge.local, &["rev-list", "--count", "HEAD^@"]), "3");
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn keep_with_edits_takes_the_version_of_the_side_without_a_working_file() {
    let merge = edited_against_deleted().await;
    // No file at the path, or no regular file there: the version of the side.
    std::fs::remove_file(merge.local.join("mine.md")).unwrap();
    std::fs::remove_file(merge.local.join("incoming.md")).unwrap();
    std::os::unix::fs::symlink("README.md", merge.local.join("incoming.md")).unwrap();
    let result = resolve_as(
        &merge,
        "incoming.md",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    let metadata = std::fs::symlink_metadata(merge.local.join("incoming.md")).unwrap();
    assert!(metadata.is_file());
    assert_eq!(
        text_of(&merge.local, "incoming.md"),
        "---\ntitle: Incoming\n---\nTwo, theirs\n"
    );
    let result = resolve_as(&merge, "mine.md", FileResolution::Side { side: Side::Ours }).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        text_of(&merge.local, "mine.md"),
        "---\ntitle: Mine\n---\nOne, ours\n"
    );
    assert_eq!(
        git(&merge.local, &["show", "HEAD:mine.md"]),
        "---\ntitle: Mine\n---\nOne, ours"
    );
    assert_eq!(git(&merge.local, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn keep_with_edits_leaves_a_working_page_that_does_not_resolve_untouched() {
    let merge = edited_against_deleted().await;
    let marked = "---\ntitle: Mine\n---\n<<<<<<< ours\nOne\n=======\nTwo\n>>>>>>> theirs\n";
    let unreadable = "---\ntitle: [Incoming\n---\nTwo, theirs\n";
    write(&merge.local, "mine.md", marked.as_bytes());
    write(&merge.local, "incoming.md", unreadable.as_bytes());
    let result = resolve_as(&merge, "mine.md", FileResolution::Side { side: Side::Ours }).await;
    let SyncResult::Unresolved { path, finding } = result else {
        panic!("{result:?}");
    };
    assert_eq!(path, "mine.md");
    assert_eq!(finding, ResolutionFinding::Markers);
    let result = resolve_as(
        &merge,
        "incoming.md",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    let SyncResult::Unresolved { path, finding } = result else {
        panic!("{result:?}");
    };
    assert_eq!(path, "incoming.md");
    assert!(
        matches!(finding, ResolutionFinding::Unreadable { .. }),
        "{finding:?}"
    );
    // Neither file nor index changed; the merge waits.
    assert_eq!(text_of(&merge.local, "mine.md"), marked);
    assert_eq!(text_of(&merge.local, "incoming.md"), unreadable);
    assert_eq!(
        git(&merge.local, &["status", "--porcelain"]),
        "DU incoming.md\nUD mine.md"
    );
    assert!(merge.merging());
}

#[tokio::test]
async fn keep_with_edits_of_an_untouched_lfs_pointer_keeps_the_pointer() {
    // The object of the pointer is not here; the file as the merge left it
    // resolves as the version of the side always did.
    let (merge, result) = Merge::new(
        "lfs.bin filter=lfs\n",
        |repo| write(repo, "lfs.bin", POINTER_BASE),
        |repo| std::fs::remove_file(repo.join("lfs.bin")).unwrap(),
        |repo| write(repo, "lfs.bin", POINTER_OURS),
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(
        merge.places("lfs.bin").await.kind,
        ConflictKind::ModifyDelete
    );
    let result = resolve_as(&merge, "lfs.bin", FileResolution::Side { side: Side::Ours }).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "lfs.bin"), POINTER_OURS);
    assert_eq!(
        git(&merge.local, &["show", "HEAD:lfs.bin"]).as_bytes(),
        POINTER_OURS.trim_ascii_end()
    );
}

#[tokio::test]
async fn keep_new_name_keeps_the_working_file_edited_under_it() {
    let merge = renames().await;
    let renamed = "rename me\nplease\nedited under the new name\n";
    write(&merge.local, "renamed-ours.txt", renamed.as_bytes());
    let result = resolve_as(
        &merge,
        "renamed-ours.txt",
        FileResolution::Side { side: Side::Ours },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "renamed-ours.txt"), renamed);
    assert_eq!(
        git(&merge.local, &["show", ":renamed-ours.txt"]),
        renamed.trim_end()
    );
    assert!(!unmerged(&merge).contains("renamed"));
}

#[tokio::test]
async fn rename_rename_keeps_the_working_file_edited_under_the_chosen_name() {
    let merge = renames().await;
    let moved = "line 1 ours\nline 2 edited\nline 3\nline 4 theirs\n";
    write(&merge.local, "moved-theirs.txt", moved.as_bytes());
    let result = resolve_as(
        &merge,
        "moved-ours.txt",
        FileResolution::Side { side: Side::Theirs },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "moved-theirs.txt"), moved);
    assert_eq!(
        git(&merge.local, &["show", ":moved-theirs.txt"]),
        moved.trim_end()
    );
    // The other names are gone, as before.
    assert!(!merge.local.join("moved-ours.txt").exists());
    assert!(!merge.local.join("moved.txt").exists());
    assert_eq!(
        git(&merge.local, &["ls-files", "moved-ours.txt", "moved.txt"]),
        ""
    );
    assert!(!unmerged(&merge).contains("moved"));
}

#[tokio::test]
async fn a_binary_file_takes_the_version_of_a_side_over_an_edited_working_file() {
    // R6 leaves binary files and binary add/add on the version in the index.
    let (merge, _) = Merge::new(
        "",
        |repo| write(repo, "a.png", b"PNG\0base"),
        |repo| {
            write(repo, "a.png", b"PNG\0theirs");
            write(repo, "b.png", b"PNG\0theirs");
        },
        |repo| {
            write(repo, "a.png", b"PNG\0ours");
            write(repo, "b.png", b"PNG\0ours");
        },
    )
    .await;
    assert_eq!(merge.places("a.png").await.kind, ConflictKind::Binary);
    assert_eq!(merge.places("b.png").await.kind, ConflictKind::AddAdd);
    write(&merge.local, "a.png", b"PNG\0edited");
    write(&merge.local, "b.png", b"PNG\0edited");
    let result = resolve_as(&merge, "a.png", FileResolution::Side { side: Side::Ours }).await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "a.png"), b"PNG\0ours");
    let result = resolve_as(&merge, "b.png", FileResolution::Side { side: Side::Ours }).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(bytes_of(&merge.local, "b.png"), b"PNG\0ours");
}
