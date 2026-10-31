#![cfg(unix)]
use super::*;
use crate::git::conflict_kind::{PathConflict, unresolved};
use crate::git::sync::sync;
use std::path::PathBuf;
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim_end().into()
}

fn write(repo: &Path, file: &str, value: &[u8]) {
    let path = repo.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value).unwrap();
}

fn text_of(repo: &Path, file: &str) -> String {
    std::fs::read_to_string(repo.join(file)).unwrap()
}

fn test_cli(temp: &Path) -> GitCli {
    let wrapper = temp.join("git-test");
    svode_testkit::write_executable(
        &wrapper,
        "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
    )
    .unwrap();
    GitCli::for_test(wrapper)
}

/// Two clones of one remote: `base` is committed and pushed, `theirs` runs
/// and pushes in the other clone, `ours` runs and commits in `local`, then
/// an explicit sync of `local` stops in a merge.
struct Merge {
    _temp: tempfile::TempDir,
    remote: PathBuf,
    local: PathBuf,
    cli: GitCli,
}

impl Merge {
    async fn new(
        attributes: &str,
        base: impl Fn(&Path),
        theirs: impl Fn(&Path),
        ours: impl Fn(&Path),
    ) -> (Self, SyncResult) {
        let temp = tempfile::tempdir().unwrap();
        let seed = temp.path().join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        git(&seed, &["config", "user.name", "Fixture"]);
        git(&seed, &["config", "user.email", "fixture@example.test"]);
        write(&seed, "README.md", b"# Project\n");
        base(&seed);
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-qm", "base"]);
        let remote = temp.path().join("remote.git");
        git(
            temp.path(),
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        let other = temp.path().join("other");
        let local = temp.path().join("local");
        for clone in [&other, &local] {
            git(
                temp.path(),
                &[
                    "clone",
                    "-q",
                    remote.to_str().unwrap(),
                    clone.to_str().unwrap(),
                ],
            );
            git(clone, &["config", "user.name", "Fixture"]);
            git(clone, &["config", "user.email", "fixture@example.test"]);
            crate::git::policy::exclude_device_local(clone);
        }
        theirs(&other);
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-qm", "theirs"]);
        git(&other, &["push", "-q", "origin", "main"]);
        ours(&local);
        git(&local, &["add", "-A"]);
        git(&local, &["commit", "-qm", "ours"]);
        write(&local, ".git/info/attributes", attributes.as_bytes());
        let cli = test_cli(temp.path());
        let result = sync(&cli, &local).await.unwrap();
        (
            Self {
                _temp: temp,
                remote,
                local,
                cli,
            },
            result,
        )
    }

    /// One text file changed on both sides.
    async fn text(path: &str, base: &str, theirs: &str, ours: &str) -> Self {
        let (path, base, theirs, ours) = (
            path.to_owned(),
            base.to_owned(),
            theirs.to_owned(),
            ours.to_owned(),
        );
        let (merge, result) = Self::new(
            "",
            |repo| write(repo, &path, base.as_bytes()),
            |repo| write(repo, &path, theirs.as_bytes()),
            |repo| write(repo, &path, ours.as_bytes()),
        )
        .await;
        assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
        merge
    }

    async fn kinds(&self) -> Vec<PathConflict> {
        let mut kinds = unresolved(&self.cli, &self.local).await.unwrap();
        kinds.sort_by(|a, b| a.path.cmp(&b.path));
        kinds
    }

    fn merging(&self) -> bool {
        self.local.join(".git/MERGE_HEAD").exists()
    }

    async fn places(&self, path: &str) -> ConflictFile {
        read(&self.cli, &self.local, path).await.unwrap()
    }

    async fn choose(&self, path: &str, choices: &[PlaceChoice]) -> SyncResult {
        let file = self.places(path).await;
        resolve(
            &self.cli,
            &self.local,
            path,
            &FileResolution::Places {
                version: file.version,
                choices: choices.to_vec(),
            },
        )
        .await
        .unwrap()
    }
}

fn conflict(path: &str, kind: ConflictKind) -> PathConflict {
    PathConflict {
        path: path.into(),
        kind,
    }
}

#[tokio::test]
async fn kinds_follow_the_index_stages() {
    let (merge, result) = Merge::new(
        "",
        |repo| {
            write(repo, "notes.txt", b"a\nb\nc\n");
            write(repo, "image.png", b"PNG\0base");
            write(repo, "edited.txt", b"one\n");
            write(repo, "gone.txt", b"keep\n");
            write(repo, "moved.txt", b"line 1\nline 2\nline 3\n");
            write(repo, "renamed.txt", b"rename me\nplease\n");
            write(repo, "page.md", b"---\ntitle: A\n---\nText\n");
            write(
                repo,
                "lfs.bin",
                b"version https://git-lfs.github.com/spec/v1\noid sha256:aaaa\nsize 1\n",
            );
        },
        |repo| {
            write(repo, "notes.txt", b"a\ntheirs\nc\n");
            write(repo, "image.png", b"PNG\0theirs");
            std::fs::remove_file(repo.join("edited.txt")).unwrap();
            write(repo, "gone.txt", b"keep, theirs\n");
            write(repo, "both.txt", b"theirs\n");
            git(repo, &["mv", "moved.txt", "moved-theirs.txt"]);
            std::fs::remove_file(repo.join("renamed.txt")).unwrap();
            write(repo, "page.md", b"---\ntitle: B\n---\nText\n");
            write(
                repo,
                "lfs.bin",
                b"version https://git-lfs.github.com/spec/v1\noid sha256:cccc\nsize 3\n",
            );
        },
        |repo| {
            write(repo, "notes.txt", b"a\nours\nc\n");
            write(repo, "image.png", b"PNG\0ours");
            write(repo, "edited.txt", b"one, ours\n");
            std::fs::remove_file(repo.join("gone.txt")).unwrap();
            write(repo, "both.txt", b"ours\n");
            git(repo, &["mv", "moved.txt", "moved-ours.txt"]);
            git(repo, &["mv", "renamed.txt", "renamed-ours.txt"]);
            write(repo, "page.md", b"---\ntitle: C\n---\nText\n");
            write(
                repo,
                "lfs.bin",
                b"version https://git-lfs.github.com/spec/v1\noid sha256:bbbb\nsize 2\n",
            );
        },
    )
    .await;
    let SyncResult::Conflict { kinds, .. } = result else {
        panic!("{result:?}");
    };
    let mut sorted = kinds.clone();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(sorted, merge.kinds().await);
    assert_eq!(
        merge.kinds().await,
        [
            conflict("both.txt", ConflictKind::AddAdd),
            conflict("edited.txt", ConflictKind::ModifyDelete),
            conflict("gone.txt", ConflictKind::ModifyDelete),
            conflict("image.png", ConflictKind::Binary),
            conflict("lfs.bin", ConflictKind::Binary),
            conflict("moved-ours.txt", ConflictKind::RenameRename),
            conflict("moved-theirs.txt", ConflictKind::RenameRename),
            conflict("moved.txt", ConflictKind::RenameRename),
            conflict("notes.txt", ConflictKind::Text),
            conflict("page.md", ConflictKind::PageProperties),
            conflict("renamed-ours.txt", ConflictKind::RenameDelete),
        ]
    );
}

#[tokio::test]
async fn an_unset_merge_attribute_makes_a_text_file_binary() {
    let (merge, _) = Merge::new(
        "",
        |repo| {
            write(repo, ".gitattributes", b"*.dat binary\n");
            write(repo, "table.dat", b"a\n");
        },
        |repo| write(repo, "table.dat", b"theirs\n"),
        |repo| write(repo, "table.dat", b"ours\n"),
    )
    .await;
    assert_eq!(
        merge.kinds().await,
        [conflict("table.dat", ConflictKind::Binary)]
    );
}

#[tokio::test]
async fn a_choice_replaces_only_its_place() {
    let merge = Merge::text(
        "notes.txt",
        "head\none\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\ntwo\ntail\n",
        "head\none theirs\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\ntwo theirs\ntail\n",
        "head\none ours\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\ntwo ours\ntail\n",
    )
    .await;
    let file = merge.places("notes.txt").await;
    assert_eq!(file.kind, ConflictKind::Text);
    let Some(Places::Places { places }) = &file.places else {
        panic!("{file:?}");
    };
    assert_eq!(places.len(), 2);
    assert_eq!(places[0].ours, "one ours");
    assert_eq!(places[0].theirs, "one theirs");
    let result = merge
        .choose("notes.txt", &[PlaceChoice::Theirs, PlaceChoice::Both])
        .await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        text_of(&merge.local, "notes.txt"),
        "head\none theirs\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\ntwo ours\ntwo theirs\ntail\n"
    );
    assert!(!merge.merging());
    // The merge is published.
    assert_eq!(
        git(&merge.remote, &["rev-parse", "main"]),
        git(&merge.local, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn the_last_resolved_path_finishes_the_merge() {
    let (merge, result) = Merge::new(
        "",
        |repo| {
            write(repo, "a.txt", b"a\n");
            write(repo, "b.yaml", b"key: base\n");
        },
        |repo| {
            write(repo, "a.txt", b"theirs\n");
            write(repo, "b.yaml", b"key: theirs\n");
        },
        |repo| {
            write(repo, "a.txt", b"ours\n");
            write(repo, "b.yaml", b"key: ours\n");
        },
    )
    .await;
    assert!(matches!(result, SyncResult::Conflict { .. }));
    let result = merge.choose("a.txt", &[PlaceChoice::Ours]).await;
    let SyncResult::Conflict { files, .. } = result else {
        panic!("{result:?}");
    };
    assert_eq!(files, ["b.yaml"]);
    assert!(merge.merging());
    // A repeated key does not read as YAML: nothing is written.
    let before = text_of(&merge.local, "b.yaml");
    let result = merge.choose("b.yaml", &[PlaceChoice::Both]).await;
    assert!(
        matches!(
            &result,
            SyncResult::Unresolved { path, finding: ResolutionFinding::Unreadable { .. } } if path == "b.yaml"
        ),
        "{result:?}"
    );
    assert_eq!(text_of(&merge.local, "b.yaml"), before);
    let result = merge.choose("b.yaml", &[PlaceChoice::Theirs]).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert!(!merge.merging());
    assert_eq!(text_of(&merge.local, "a.txt"), "ours\n");
    assert_eq!(text_of(&merge.local, "b.yaml"), "key: theirs\n");
}

#[tokio::test]
async fn unreadable_json_and_service_files_are_not_resolved() {
    let (merge, _) = Merge::new(
        "",
        |repo| {
            write(repo, "data.json", b"{\"a\": 1}\n");
            write(repo, "tasks/schema.yaml", b"properties: []\n");
        },
        |repo| {
            write(repo, "data.json", b"{\"a\": 2}\n");
            write(repo, "tasks/schema.yaml", b"properties: [x]\n");
        },
        |repo| {
            write(repo, "data.json", b"{\"a\": 3}\n");
            write(repo, "tasks/schema.yaml", b"properties: {}\n");
        },
    )
    .await;
    let result = merge.choose("data.json", &[PlaceChoice::Both]).await;
    assert!(
        matches!(
            result,
            SyncResult::Unresolved {
                finding: ResolutionFinding::Unreadable { .. },
                ..
            }
        ),
        "{result:?}"
    );
    assert!(text_of(&merge.local, "data.json").contains("<<<<<<<"));
    let result = merge.choose("data.json", &[PlaceChoice::Ours]).await;
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    assert_eq!(text_of(&merge.local, "data.json"), "{\"a\": 3}\n");
    // The schema reads with the Collections reader, not as any YAML.
    assert_eq!(
        check_result("tasks/schema.yaml", b"properties: {}\nproperties: []\n", 7)
            .map(|finding| matches!(finding, ResolutionFinding::Unreadable { .. })),
        Some(true)
    );
    assert_eq!(
        check_result(".svode/config.json", b"{\"name\": \"A\"}\n{}\n", 7)
            .map(|finding| matches!(finding, ResolutionFinding::Unreadable { .. })),
        Some(true)
    );
    assert_eq!(
        check_result("notes.txt", b"a\n<<<<<<< ours\n", 7),
        Some(ResolutionFinding::Markers)
    );
    assert_eq!(check_result("notes.txt", b"a\n=======\n", 7), None);
}

#[tokio::test]
async fn places_follow_the_marker_size_of_the_path() {
    let (merge, _) = Merge::new(
        "notes.txt conflict-marker-size=10\n",
        |repo| write(repo, "notes.txt", b"head\nbase\ntail\n"),
        |repo| write(repo, "notes.txt", b"head\ntheirs\ntail\n"),
        |repo| {
            write(
                repo,
                "notes.txt",
                b"head\nours\n=======\n<<<<<<< not a marker\ntail\n",
            )
        },
    )
    .await;
    let content = text_of(&merge.local, "notes.txt");
    assert!(content.contains("<<<<<<<<<< "), "{content}");
    let file = merge.places("notes.txt").await;
    let Some(Places::Places { places }) = &file.places else {
        panic!("{file:?}");
    };
    assert_eq!(places.len(), 1);
    assert_eq!(places[0].ours, "ours\n=======\n<<<<<<< not a marker");
    assert_eq!(places[0].theirs, "theirs");
    // The size of the path decides what is a marker line: the result keeps
    // the lines of 7 characters and resolves the path.
    let result = merge.choose("notes.txt", &[PlaceChoice::Ours]).await;
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        text_of(&merge.local, "notes.txt"),
        "head\nours\n=======\n<<<<<<< not a marker\ntail\n"
    );
}

#[tokio::test]
async fn an_ambiguous_file_takes_a_side_for_the_whole_file() {
    let merge = Merge::text(
        "notes.txt",
        "title\nbase\n",
        "title\ntheirs\n",
        "title\nours\n=======\n",
    )
    .await;
    let file = merge.places("notes.txt").await;
    assert_eq!(
        file.places,
        Some(Places::Unclear {
            reason: UnclearReason::Ambiguous
        })
    );
    assert!(file.ours && file.theirs);
    let refused = resolve(
        &merge.cli,
        &merge.local,
        "notes.txt",
        &FileResolution::Places {
            version: file.version,
            choices: vec![PlaceChoice::Ours],
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        refused,
        SyncResult::Unresolved {
            finding: ResolutionFinding::Changed,
            ..
        }
    ));
    let result = resolve(
        &merge.cli,
        &merge.local,
        "notes.txt",
        &FileResolution::Side { side: Side::Theirs },
    )
    .await
    .unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    // The version before the merge: the other side's edits in the file are gone.
    assert_eq!(text_of(&merge.local, "notes.txt"), "title\ntheirs\n");
}

#[tokio::test]
async fn a_side_the_index_lacks_cannot_be_taken() {
    let (merge, _) = Merge::new(
        "",
        |repo| write(repo, "notes.txt", b"a\n"),
        |repo| std::fs::remove_file(repo.join("notes.txt")).unwrap(),
        |repo| write(repo, "notes.txt", b"ours\n"),
    )
    .await;
    let file = merge.places("notes.txt").await;
    assert_eq!(file.kind, ConflictKind::ModifyDelete);
    assert!(file.ours && !file.theirs);
    let error = resolve(
        &merge.cli,
        &merge.local,
        "notes.txt",
        &FileResolution::Side { side: Side::Theirs },
    )
    .await
    .unwrap_err();
    assert!(matches!(error, GitError::Conflict(_)), "{error:?}");
    assert!(merge.merging());
}

#[tokio::test]
async fn files_in_conflict_without_a_merge_are_not_committed() {
    let merge = Merge::text("notes.txt", "a\n", "theirs\n", "ours\n").await;
    for name in ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
        let _ = std::fs::remove_file(merge.local.join(".git").join(name));
    }
    let head = git(&merge.local, &["rev-parse", "HEAD"]);
    let result = merge.choose("notes.txt", &[PlaceChoice::Ours]).await;
    assert!(matches!(result, SyncResult::Resolved), "{result:?}");
    assert_eq!(git(&merge.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(text_of(&merge.local, "notes.txt"), "ours\n");
    assert_eq!(git(&merge.local, &["ls-files", "--unmerged"]), "");
}

#[tokio::test]
async fn a_changed_file_refuses_stale_choices() {
    let merge = Merge::text("notes.txt", "a\n", "theirs\n", "ours\n").await;
    let file = merge.places("notes.txt").await;
    let edited = text_of(&merge.local, "notes.txt") + "more\n";
    write(&merge.local, "notes.txt", edited.as_bytes());
    let result = resolve(
        &merge.cli,
        &merge.local,
        "notes.txt",
        &FileResolution::Places {
            version: file.version,
            choices: vec![PlaceChoice::Ours],
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        result,
        SyncResult::Unresolved {
            finding: ResolutionFinding::Changed,
            ..
        }
    ));
    assert_eq!(text_of(&merge.local, "notes.txt"), edited);
}

#[test]
fn places_read_marker_lines_like_the_page_editor() {
    let places_of = |text: &str, size| places(text.as_bytes(), size);
    // `diff3`: the base section belongs to no side; CRLF endings stay out
    // of the sides.
    assert_eq!(
        places_of(
            "a\r\n<<<<<<< ours\r\nmine\r\n||||||| base\r\nold\r\n=======\r\nyours\r\n>>>>>>> theirs\r\nb\r\n",
            7
        ),
        Places::Places {
            places: vec![ConflictPlace {
                start_line: 1,
                end_line: 7,
                ours: "mine".into(),
                theirs: "yours".into(),
            }]
        }
    );
    // An empty side.
    assert_eq!(
        places_of("<<<<<<< ours\n=======\nyours\n>>>>>>> theirs\n", 7),
        Places::Places {
            places: vec![ConflictPlace {
                start_line: 0,
                end_line: 3,
                ours: String::new(),
                theirs: "yours".into(),
            }]
        }
    );
    let unclear = |reason| Places::Unclear { reason };
    // A second `=` line, a `>` line in "theirs" and a `<` line before the block.
    assert_eq!(
        places_of("<<<<<<< a\nx\n=======\ny\n=======\nz\n>>>>>>> b\n", 7),
        unclear(UnclearReason::Ambiguous)
    );
    assert_eq!(
        places_of("<<<<<<< a\nx\n=======\ny\n>>>>>>> b\nz\n>>>>>>> c\n", 7),
        unclear(UnclearReason::Ambiguous)
    );
    assert_eq!(
        places_of("<<<<<<< a\n<<<<<<< b\nx\n=======\ny\n>>>>>>> c\n", 7),
        unclear(UnclearReason::Ambiguous)
    );
    // Marker lines that do not fold into blocks.
    assert_eq!(
        places_of("<<<<<<< a\nx\n=======\ny\n", 7),
        unclear(UnclearReason::Broken)
    );
    assert_eq!(
        places_of("<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n||||||| stray\n", 7),
        unclear(UnclearReason::Broken)
    );
    assert_eq!(
        places_of("plain\n=======\n", 7),
        unclear(UnclearReason::NoMarkers)
    );
    // Markers of another size are text.
    assert_eq!(
        places_of("<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n", 10),
        unclear(UnclearReason::NoMarkers)
    );
    // "Both" keeps my side first; text outside the places is unchanged.
    assert_eq!(
        apply_choices(
            b"a\n<<<<<<< ours\nmine\n=======\nyours\n>>>>>>> theirs\nb\n",
            7,
            &[PlaceChoice::Both]
        )
        .unwrap(),
        b"a\nmine\nyours\nb\n"
    );
    // Choices must cover every place.
    assert_eq!(
        apply_choices(
            b"<<<<<<< ours\nmine\n=======\nyours\n>>>>>>> theirs\n",
            7,
            &[]
        ),
        None
    );
}
