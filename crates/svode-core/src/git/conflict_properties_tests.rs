use super::*;
use crate::git::conflict_file::{PlaceChoice, apply_choices, check_result};
use crate::page::frontmatter::{ParseStatus, parse_status};
use std::process::Command;

/// Conflict styles Git writes, as `git merge-file` flags.
const STYLES: [(&str, Option<&str>); 3] = [
    ("merge", None),
    ("diff3", Some("--diff3")),
    ("zdiff3", Some("--zdiff3")),
];

/// One merge of a Page: E4-like frontmatter with dates, quotes, lists,
/// block values, comments and adjacent fields edited on both sides.
struct Fixture {
    name: &'static str,
    base: String,
    ours: String,
    theirs: String,
}

const PLAN: &str = r#"---
title: "Release \"Q4\" plan"
status: draft
due: 2026-10-01
owner: 'Ann_Lee'
tags:
  - plan
  - q4
description: |
  First line with *stars* and [brackets]
  Second line ends with backslash \
# a YAML comment
---
# Heading

Body text with _underscores_.
"#;

const RECORD: &str = "---
title: Fix login
unique_id: 12
status: In progress
assignee:
  - people/ann.md
estimate: 3
created: 2026-10-02T09:15:00+03:00
---
Steps to reproduce.
";

fn edit(text: &str, replacements: &[(&str, &str)]) -> String {
    let mut text = text.to_owned();
    for (from, to) in replacements {
        assert!(text.contains(from), "{from:?} not in fixture");
        text = text.replacen(from, to, 1);
    }
    text
}

fn fixtures() -> Vec<Fixture> {
    let fixture = |name, base: &str, ours: &[(&str, &str)], theirs: &[(&str, &str)]| Fixture {
        name,
        base: base.to_owned(),
        ours: edit(base, ours),
        theirs: edit(base, theirs),
    };
    let crlf = |text: &str| text.replace('\n', "\r\n");
    let mut fixtures = vec![
        fixture(
            "adjacent fields",
            PLAN,
            &[
                ("status: draft", "status: done"),
                ("due: 2026-10-01", "due: 2026-11-15"),
            ],
            &[
                ("status: draft", "status: blocked"),
                ("due: 2026-10-01", "due: \"2026-12-01\""),
                ("  - q4\n", "  - q4\n  - release\n"),
            ],
        ),
        fixture(
            "properties and text",
            PLAN,
            &[
                ("status: draft", "status: done"),
                ("# Heading", "# Heading mine"),
            ],
            &[
                ("status: draft", "status: 'blocked'"),
                ("# Heading", "# Heading theirs"),
            ],
        ),
        fixture(
            "multiline values",
            PLAN,
            &[
                ("  - plan\n  - q4\n", "  - plan\n  - q4\n  - ours\n"),
                (
                    "description: |\n  First line",
                    "description: |\n  Mine: first line",
                ),
            ],
            &[
                ("  - plan\n  - q4\n", "  - q4\n"),
                (
                    "description: |\n  First line",
                    "description: >\n  Their first line",
                ),
            ],
        ),
        fixture(
            "place through the closing delimiter",
            "---\ntitle: Notes\nreviewed: 2026-10-01\n---\n# Notes\n\nText.\n",
            &[
                ("2026-10-01", "2026-10-20"),
                ("# Notes\n", "# Notes mine\n"),
            ],
            &[
                ("2026-10-01", "2026-10-25"),
                ("# Notes\n", "# Notes theirs\n"),
            ],
        ),
        fixture(
            "collection record",
            RECORD,
            &[
                ("status: In progress", "status: Done"),
                ("estimate: 3", "estimate: 5"),
            ],
            &[
                ("status: In progress", "status: Blocked"),
                ("estimate: 3", "estimate: 8"),
                (
                    "  - people/ann.md\n",
                    "  - people/ann.md\n  - people/bob.md\n",
                ),
            ],
        ),
    ];
    let windows = fixture(
        "CRLF line endings",
        &crlf(PLAN),
        &[("status: draft", "status: done")],
        &[("status: draft", "status: blocked")],
    );
    fixtures.push(windows);
    fixtures
}

/// The output of `git merge-file -p` for the fixture with `flags`.
fn merge_file(fixture: &Fixture, flags: &[&str]) -> Vec<u8> {
    let temp = tempfile::tempdir().unwrap();
    for (name, text) in [
        ("ours", &fixture.ours),
        ("base", &fixture.base),
        ("theirs", &fixture.theirs),
    ] {
        std::fs::write(temp.path().join(name), text).unwrap();
    }
    let out = Command::new("git")
        .args([
            "merge-file",
            "-p",
            "-L",
            "ours",
            "-L",
            "base",
            "-L",
            "theirs",
        ])
        .args(flags)
        .args(["ours", "base", "theirs"])
        .current_dir(temp.path())
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    // The exit code is the number of conflicts; a negative one is an error.
    assert!(
        out.status
            .code()
            .is_some_and(|code| (0..127).contains(&code)),
        "{}: {}",
        fixture.name,
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn place_count(places: &Places) -> usize {
    match places {
        Places::Places { places } => places.len(),
        Places::Unclear { reason } => panic!("places are unclear: {reason:?}"),
    }
}

/// The file the editor saves after `side` in every place of the block and,
/// as today, in every text block below it.
fn save(content: &[u8], side: Side) -> String {
    let conflict = properties(content, 7).expect("markers in the frontmatter");
    let choices = vec![side; place_count(&conflict.places)];
    let PropertiesResolution::Resolved { frontmatter } = resolve_properties(content, 7, &choices)
    else {
        panic!("the choice does not resolve the properties");
    };
    let text_choice = match side {
        Side::Ours => PlaceChoice::Ours,
        Side::Theirs => PlaceChoice::Theirs,
    };
    let body = match conflict_file::places(conflict.body.as_bytes(), 7) {
        Places::Places { places } => String::from_utf8(
            apply_choices(
                conflict.body.as_bytes(),
                7,
                &vec![text_choice; places.len()],
            )
            .unwrap(),
        )
        .unwrap(),
        Places::Unclear { .. } => conflict.body.clone(),
    };
    frontmatter + &body
}

fn body_of(content: &str) -> String {
    match parse_status(content) {
        ParseStatus::Valid { body, .. } => body,
        _ => panic!("the frontmatter does not read:\n{content}"),
    }
}

#[test]
fn a_side_in_every_place_gives_the_frontmatter_git_would_give() {
    for fixture in fixtures() {
        for (style, flag) in STYLES {
            let conflicted = merge_file(&fixture, flag.as_slice());
            let case = format!("{} ({style})", fixture.name);
            assert!(
                properties(&conflicted, 7).is_some(),
                "{case}: no markers in the frontmatter:\n{}",
                String::from_utf8_lossy(&conflicted)
            );
            for (side, flag) in [(Side::Ours, "--ours"), (Side::Theirs, "--theirs")] {
                let expected = String::from_utf8(merge_file(&fixture, &[flag])).unwrap();
                let saved = save(&conflicted, side);
                assert_eq!(saved, expected, "{case}, {side:?}");
                body_of(&saved);
            }
        }
    }
}

#[test]
fn the_saved_frontmatter_is_stable_on_later_saves() {
    for fixture in fixtures() {
        for (style, flag) in STYLES {
            let case = format!("{} ({style})", fixture.name);
            let conflicted = merge_file(&fixture, flag.as_slice());
            let space = tempfile::tempdir().unwrap();
            let root = space.path().to_str().unwrap();
            let file = space.path().join("page.md");
            std::fs::write(&file, &conflicted).unwrap();
            let write = |content: &str| {
                crate::page::entry::write(
                    root, "page.md", content, None, None, None, None, None, true,
                )
                .unwrap();
                std::fs::read_to_string(&file).unwrap()
            };
            // The first save writes the whole resolved file over the conflict.
            let saved = save(&conflicted, Side::Theirs);
            assert_eq!(write(&saved), saved, "{case}");
            // Later saves write the body and keep the frontmatter as it is.
            let body = body_of(&saved);
            assert_eq!(write(&body), saved, "{case}: unchanged body");
            let edited = write(&format!("{body}More text.\n"));
            let frontmatter = &saved[..saved.len() - body.len()];
            assert!(edited.starts_with(frontmatter), "{case}: {edited}");
            assert_eq!(body_of(&edited), format!("{body}More text.\n"));
        }
    }
}

#[test]
fn the_text_below_the_frontmatter_keeps_its_own_blocks() {
    let fixture = &fixtures()[1];
    for (style, flag) in STYLES {
        let conflicted = merge_file(fixture, flag.as_slice());
        let conflict = properties(&conflicted, 7).unwrap();
        assert_eq!(place_count(&conflict.places), 1, "{style}");
        assert!(!conflict.reaches_text, "{style}");
        assert!(
            conflict.body.starts_with("<<<<<<< ours\n# Heading mine\n"),
            "{style}: {}",
            conflict.body
        );
        let Places::Places { places } = &conflict.places else {
            unreachable!()
        };
        assert_eq!(places[0].ours, "status: done");
        assert_eq!(places[0].theirs, "status: 'blocked'");
    }
}

#[test]
fn a_place_through_the_closing_delimiter_belongs_to_the_frontmatter() {
    let fixture = &fixtures()[3];
    let conflicted = merge_file(fixture, &[]);
    let conflict = properties(&conflicted, 7).unwrap();
    assert!(conflict.reaches_text);
    assert_eq!(conflict.body, "\nText.\n");
    let Places::Places { places } = &conflict.places else {
        panic!("{:?}", conflict.places)
    };
    assert_eq!(places[0].ours, "reviewed: 2026-10-20\n---\n# Notes mine");
    assert_eq!(
        resolve_properties(&conflicted, 7, &[Side::Theirs]),
        PropertiesResolution::Resolved {
            frontmatter: "---\ntitle: Notes\nreviewed: 2026-10-25\n---\n# Notes theirs\n".into()
        }
    );
    // In the `diff3` style Git keeps the delimiter out of the places.
    let conflicted = merge_file(fixture, &["--diff3"]);
    let conflict = properties(&conflicted, 7).unwrap();
    assert!(!conflict.reaches_text);
    assert!(conflict.body.starts_with("<<<<<<< ours\n# Notes mine\n"));
}

#[test]
fn a_conflict_from_the_first_line_holds_the_opening_delimiter() {
    let content = b"<<<<<<< ours\n---\ntitle: A\n---\nMine\n=======\n---\ntitle: B\n---\nTheirs\n>>>>>>> theirs\nShared\n";
    let conflict = properties(content, 7).unwrap();
    assert!(conflict.reaches_text);
    assert_eq!(conflict.body, "Shared\n");
    assert_eq!(
        resolve_properties(content, 7, &[Side::Ours]),
        PropertiesResolution::Resolved {
            frontmatter: "---\ntitle: A\n---\nMine\n".into()
        }
    );
}

#[test]
fn text_conflicts_alone_are_not_in_the_properties() {
    let content = b"---\ntitle: A\n---\n<<<<<<< ours\nMine\n=======\nTheirs\n>>>>>>> theirs\n";
    assert_eq!(properties(content, 7), None);
    assert_eq!(
        resolve_properties(content, 7, &[]),
        PropertiesResolution::Unresolved {
            finding: ResolutionFinding::Changed
        }
    );
}

#[test]
fn places_that_are_not_told_apart_leave_the_whole_file() {
    let ambiguous = b"---\ntitle: A\n<<<<<<< ours\nnote: x\n=======\nnote: y\n=======\n>>>>>>> theirs\n---\nText\n";
    let broken = b"---\ntitle: A\n<<<<<<< ours\nnote: x\n---\nText\n";
    // A text block below the frontmatter does not make its places unclear.
    let text = b"---\ntitle: A\n<<<<<<< ours\nnote: x\n=======\nnote: y\n>>>>>>> theirs\n---\n<<<<<<< ours\nA\n=======\nB\n=======\n>>>>>>> theirs\n";
    for (content, reason) in [
        (&ambiguous[..], UnclearReason::Ambiguous),
        (&broken[..], UnclearReason::Broken),
    ] {
        let conflict = properties(content, 7).unwrap();
        assert_eq!(conflict.places, Places::Unclear { reason });
        assert_eq!(
            resolve_properties(content, 7, &[Side::Ours]),
            PropertiesResolution::Unresolved {
                finding: ResolutionFinding::Changed
            }
        );
    }
    let conflict = properties(text, 7).unwrap();
    assert_eq!(place_count(&conflict.places), 1);
    assert!(conflict.body.starts_with("<<<<<<< ours\nA\n"));
}

#[test]
fn places_follow_the_marker_size_of_the_path() {
    let content = b"---\ntitle: A\n<<<<<<<<<< ours\n<<<<<<< note: x\n==========\nnote: y\n>>>>>>>>>> theirs\n---\nText\n";
    // With Git's default size the text line is a broken marker.
    assert_eq!(
        properties(content, 7).unwrap().places,
        Places::Unclear {
            reason: UnclearReason::Broken
        }
    );
    let conflict = properties(content, 10).unwrap();
    assert_eq!(place_count(&conflict.places), 1);
    assert_eq!(
        resolve_properties(content, 10, &[Side::Theirs]),
        PropertiesResolution::Resolved {
            frontmatter: "---\ntitle: A\nnote: y\n---\n".into()
        }
    );
}

#[test]
fn a_frontmatter_that_does_not_read_is_not_resolved() {
    let content = b"---\ntitle: A\n<<<<<<< ours\nstatus: [open\n=======\nstatus: done\n>>>>>>> theirs\n---\nText\n";
    assert!(matches!(
        resolve_properties(content, 7, &[Side::Ours]),
        PropertiesResolution::Unresolved {
            finding: ResolutionFinding::Unreadable { .. }
        }
    ));
    assert!(matches!(
        resolve_properties(content, 7, &[Side::Theirs]),
        PropertiesResolution::Resolved { .. }
    ));
    // A side without the closing delimiter leaves the frontmatter open.
    let open = b"---\ntitle: A\n<<<<<<< ours\nnote: x\n---\nMine\n=======\nnote: y\nTheirs\n>>>>>>> theirs\nText\n";
    assert!(properties(open, 7).unwrap().reaches_text);
    assert!(matches!(
        resolve_properties(open, 7, &[Side::Theirs]),
        PropertiesResolution::Unresolved {
            finding: ResolutionFinding::Unreadable { .. }
        }
    ));
}

#[test]
fn the_result_of_a_page_must_read_as_frontmatter() {
    assert!(matches!(
        check_result("notes/page.md", b"---\ntitle: [\n---\nText\n", 7),
        Some(ResolutionFinding::Unreadable { .. })
    ));
    assert_eq!(
        check_result("notes/page.md", b"---\ntitle: A\n---\nText\n", 7),
        None
    );
    assert_eq!(
        check_result("notes/page.md", b"# No frontmatter\n", 7),
        None
    );
}
