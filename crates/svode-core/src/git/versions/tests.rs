//! Smart versions over real repositories: the facts of the closed set, the
//! groups of an explicit commit and the messages in both interface
//! languages (Stage 11 1.G).

use std::collections::HashMap;
use std::path::Path;

use super::changes::Sources;
use super::facts::{ChangeFact, General, GroupFacts, Place, PlacedFact, Sensitive};
use super::{GroupKind, MessageLanguage, PendingOperation, PlannedVersion, compose, plan};
use crate::git::pending::{Relocation, StructuralChange, StructuralOp};
use crate::git::save::save;
use crate::git::staging_tests::{TestHost, cli, git, repo, write};
use crate::git::state::GitRuntime;

const EN: MessageLanguage = MessageLanguage::En;
const RU: MessageLanguage = MessageLanguage::Ru;

fn page(title: &str, fields: &str, body: &str) -> String {
    format!("---\ntitle: {title}\n{fields}---\n{body}")
}

async fn commit_all(root: &Path, message: &str) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    git(&cli, root, &["commit", "-q", "-m", message]).await;
}

/// Stage everything and plan its versions.
async fn planned(root: &Path, language: MessageLanguage) -> Vec<PlannedVersion> {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    plan(&cli, root, &[".".to_string()], &[], language)
        .await
        .expect("plan")
}

fn facts(versions: &[PlannedVersion]) -> Vec<ChangeFact> {
    versions
        .iter()
        .flat_map(|version| version.facts.facts.iter().map(|placed| placed.fact.clone()))
        .collect()
}

fn headers(versions: &[PlannedVersion]) -> Vec<String> {
    versions
        .iter()
        .map(|version| version.message.header.clone())
        .collect()
}

async fn log(root: &Path) -> Vec<String> {
    git(&cli(), root, &["log", "--format=%B%x00"])
        .await
        .split('\0')
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty())
        .collect()
}

/// The paths of every commit after the baseline, newest first.
async fn commits_since(root: &Path, base: &str) -> Vec<Vec<String>> {
    let revs = git(&cli(), root, &["rev-list", &format!("{base}..HEAD")]).await;
    let mut commits = Vec::new();
    for rev in revs.lines().filter(|rev| !rev.is_empty()) {
        commits.push(committed_paths(root, rev).await);
    }
    commits
}

async fn head(root: &Path) -> String {
    git(&cli(), root, &["rev-parse", "HEAD"])
        .await
        .trim()
        .to_string()
}

async fn committed_paths(root: &Path, rev: &str) -> Vec<String> {
    git(
        &cli(),
        root,
        &["show", "--name-only", "--format=", "--no-renames", rev],
    )
    .await
    .lines()
    .filter(|line| !line.is_empty())
    .map(str::to_string)
    .collect()
}

async fn save_all(root: &Path, runtime: &GitRuntime, language: MessageLanguage) {
    save(runtime, &TestHost::default(), None, root, None, language)
        .await
        .expect("save all");
}

const TASKS_SCHEMA: &str =
    "columns:\n  - name: Status\n    type: text\nviews:\n  - name: All\n    type: table\n";

#[tokio::test]
async fn each_fact_of_the_closed_set_is_recognized() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(
        root,
        "Onboarding.md",
        &page("Onboarding", "", "Intro\n\n## Pricing\nBasic: 10\n"),
    );
    write(
        root,
        "Old.md",
        &page(
            "Old note",
            "",
            "an old note\nwith its own lines\nabout the past\n",
        ),
    );
    write(root, "Roadmap.md", &page("Roadmap Q4", "", "plan\nmore\n"));
    write(root, "Planning/README.md", &page("Planning", "", ""));
    write(root, "Tasks/README.md", &page("Tasks", "", ""));
    write(root, "Tasks/schema.yaml", TASKS_SCHEMA);
    write(
        root,
        "Tasks/BQ-12.md",
        &page("BQ-12", "Status: In progress\n", "Body\n"),
    );
    write(
        root,
        "Onboarding/README.md",
        &page("Onboarding docs", "", ""),
    );
    write(root, "Onboarding/old.png", "AAAAAAAAAAAAAAAA");
    commit_all(root, "Baseline pages").await;

    write(
        root,
        "Onboarding.md",
        &page("Onboarding", "", "Intro\n\n## Pricing\nBasic: 12\n"),
    );
    std::fs::remove_file(root.join("Old.md")).unwrap();
    std::fs::rename(root.join("Roadmap.md"), root.join("Planning/Roadmap.md")).unwrap();
    write(
        root,
        "Fresh.md",
        &page("Fresh idea", "", "a brand new idea\nnothing alike\n"),
    );
    write(
        root,
        "Tasks/BQ-12.md",
        &page("BQ-12", "Status: Done\n", "Body\n"),
    );
    write(
        root,
        "Tasks/schema.yaml",
        "columns:\n  - name: Status\n    type: text\n  - name: Priority\n    type: text\nviews:\n  - name: All\n    type: table\n    show_nested: true\n",
    );
    write(root, "Onboarding/new.png", "zz");
    std::fs::remove_file(root.join("Onboarding/old.png")).unwrap();

    let versions = planned(root, RU).await;
    let facts = facts(&versions);
    for expected in [
        ChangeFact::SectionChanged {
            page: "Onboarding".into(),
            heading: Some("Pricing".into()),
            share: 50,
        },
        ChangeFact::PageDeleted {
            title: "Old note".into(),
        },
        ChangeFact::PageMoved {
            title: "Roadmap Q4".into(),
            folder: "Planning".into(),
        },
        ChangeFact::PageCreated {
            title: "Fresh idea".into(),
        },
        ChangeFact::FieldChanged {
            record: "BQ-12".into(),
            field: "Status".into(),
            from: Some("In progress".into()),
            to: Some("Done".into()),
        },
        ChangeFact::SchemaFieldAdded {
            field: "Priority".into(),
        },
        ChangeFact::ViewChanged { view: "All".into() },
        ChangeFact::AttachmentAdded {
            name: "new.png".into(),
        },
        ChangeFact::AttachmentRemoved {
            name: "old.png".into(),
        },
    ] {
        assert!(facts.contains(&expected), "{expected:?} in {facts:#?}");
    }
    let headers = headers(&versions);
    for expected in [
        "Onboarding: правка раздела «Pricing»",
        "Удалена «Old note»",
        "Перемещена «Roadmap Q4» в «Planning»",
        "Создана «Fresh idea»",
        "Tasks: BQ-12: «Status»: «In progress» → «Done»",
        "Onboarding docs: добавлено вложение «new.png» и ещё 1 изменение",
    ] {
        assert!(
            headers.iter().any(|header| header == expected),
            "{expected} in {headers:#?}"
        );
    }
    assert!(
        headers
            .iter()
            .any(|header| header.starts_with("Коллекция «Tasks»: ")),
        "{headers:#?}"
    );
}

#[tokio::test]
async fn renamed_title_and_schema_field_rename_and_removal_are_recognized() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "Note.md", &page("Draft", "", "text\n"));
    write(
        root,
        "Tasks/schema.yaml",
        "columns:\n  - name: Status\n    type: status\n  - name: Notes\n    type: text\n",
    );
    commit_all(root, "Baseline").await;
    write(root, "Note.md", &page("Final", "", "text\n"));
    write(
        root,
        "Tasks/schema.yaml",
        "columns:\n  - name: State\n    type: status\n",
    );

    let facts = facts(&planned(root, EN).await);
    for expected in [
        ChangeFact::PageRenamed {
            from: "Draft".into(),
            to: "Final".into(),
        },
        ChangeFact::SchemaFieldRenamed {
            from: "Status".into(),
            to: "State".into(),
        },
        ChangeFact::SchemaFieldRemoved {
            field: "Notes".into(),
        },
    ] {
        assert!(facts.contains(&expected), "{expected:?} in {facts:#?}");
    }
}

#[tokio::test]
async fn a_sensitive_collection_gets_messages_without_names_fields_or_values() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(
        root,
        "Contacts/schema.yaml",
        "columns:\n  - name: Phone\n    type: phone\n",
    );
    write(
        root,
        "Contacts/Ivan Petrov.md",
        &page("Ivan Petrov", "Phone: '+1 555'\n", ""),
    );
    commit_all(root, "Baseline").await;
    write(
        root,
        "Contacts/Ivan Petrov.md",
        &page("Ivan Petrov", "Phone: '+1 777'\n", ""),
    );
    write(
        root,
        "Contacts/Jane Roe.md",
        &page("Jane Roe", "Phone: '+2'\n", ""),
    );

    for language in [EN, RU] {
        let versions = planned(root, language).await;
        assert!(!versions.is_empty());
        for version in &versions {
            let text = version.message.text();
            for secret in ["Ivan", "Jane", "Phone", "555", "777", "+2"] {
                assert!(!text.contains(secret), "{secret} in {text}");
            }
        }
        let headers = headers(&versions);
        let expected = if language == EN {
            ["Update collection entry", "Create collection entry"]
        } else {
            ["Правка записи коллекции", "Создана запись коллекции"]
        };
        for header in expected {
            assert!(headers.iter().any(|known| known == header), "{headers:?}");
        }
    }
}

#[tokio::test]
async fn a_group_without_facts_gets_the_general_wording() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, ".svode/order.json", "{\"\":[\"a\"]}\n");
    write(root, "Plain.md", &page("Plain", "", "same\n"));
    commit_all(root, "Baseline").await;
    write(root, ".svode/order.json", "{\"\":[\"b\"]}\n");
    write(
        root,
        "Plain.md",
        "---\ntitle: Plain\nupdated: 2026-10-31\n---\nsame\n",
    );

    let versions = planned(root, EN).await;
    let headers = headers(&versions);
    assert!(
        headers.contains(&"Plain: edit page".to_string()),
        "{headers:?}"
    );
    let root_name = root.file_name().unwrap().to_string_lossy();
    assert!(
        headers.contains(&format!("{root_name}: reorder")),
        "{headers:?}"
    );
}

#[tokio::test]
async fn commit_all_makes_one_commit_per_group_without_mixing_kinds() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "A.md", &page("Alpha", "", "a\n"));
    write(root, "B.md", &page("Beta", "", "b\n"));
    write(root, ".svode/config.json", "{\"name\":\"Root\"}\n");
    commit_all(root, "Baseline").await;
    let base = git(&cli, root, &["rev-parse", "HEAD"])
        .await
        .trim()
        .to_string();
    write(root, "A.md", &page("Alpha", "", "a2\n"));
    write(root, "B.md", &page("Beta", "", "b2\n"));
    write(root, ".svode/config.json", "{\"name\":\"Root 2\"}\n");
    write(root, ".gitignore", "*.tmp\n");

    save_all(root, &GitRuntime::new(), EN).await;

    let count = git(
        &cli,
        root,
        &["rev-list", "--count", &format!("{base}..HEAD")],
    )
    .await;
    assert_eq!(count.trim(), "3");
    let mut commits = Vec::new();
    for rev in ["HEAD", "HEAD~1", "HEAD~2"] {
        commits.push(committed_paths(root, rev).await);
    }
    assert!(commits.contains(&vec!["A.md".to_string()]), "{commits:?}");
    assert!(commits.contains(&vec!["B.md".to_string()]), "{commits:?}");
    assert!(
        commits.contains(&vec![
            ".gitignore".to_string(),
            ".svode/config.json".to_string()
        ]),
        "{commits:?}"
    );
    assert_eq!(git(&cli, root, &["status", "--porcelain"]).await, "");
}

#[tokio::test]
async fn a_space_pointer_lands_apart_from_content() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let child_repo = repo(&cli, true).await;
    git(
        &cli,
        root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &child_repo.path().to_string_lossy(),
            "space",
        ],
    )
    .await;
    write(root, "Page.md", &page("Page", "", "text\n"));
    let versions = planned(root, EN).await;
    let kinds = versions
        .iter()
        .map(|version| version.group.kind)
        .collect::<Vec<_>>();
    assert!(kinds.contains(&GroupKind::Structural), "{kinds:?}");
    assert!(kinds.contains(&GroupKind::Page), "{kinds:?}");
    let structural = versions
        .iter()
        .find(|version| version.group.kind == GroupKind::Structural)
        .unwrap();
    assert!(
        structural
            .group
            .paths()
            .iter()
            .all(|path| path == ".gitmodules" || path == "space")
    );
}

#[tokio::test]
async fn a_page_created_and_renamed_before_its_first_commit_is_one_commit_without_the_draft_path() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let base = head(root).await;
    let runtime = GitRuntime::new();
    // Created as «Untitled», edited, then renamed by its title.
    write(root, "Final.md", &page("Final plan", "", "body\n"));
    write(root, "Other.md", &page("Other", "", "x\n"));
    runtime.pending().record(
        root,
        Some(
            StructuralChange::new(StructuralOp::Rename {
                old: "Untitled.md".into(),
                new: "Final.md".into(),
            })
            .relocating(Relocation {
                source: root.join("Untitled.md"),
                target: root.join("Final.md"),
            }),
        ),
        vec![root.join("Untitled.md"), root.join("Final.md")],
    );

    save_all(root, &runtime, RU).await;

    let messages = log(root).await;
    assert!(
        messages.contains(&"Создана «Final plan»".to_string()),
        "{messages:?}"
    );
    let commits = commits_since(root, &base).await;
    assert!(
        commits.contains(&vec!["Final.md".to_string()]),
        "{commits:?}"
    );
    let tree = git(&cli, root, &["ls-tree", "-r", "--name-only", "HEAD"]).await;
    assert!(!tree.contains("Untitled.md"));
}

#[tokio::test]
async fn an_operation_on_a_committed_page_is_its_own_commit_with_its_links() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "Plan.md", &page("Plan", "", "plan\n"));
    write(root, "Index.md", &page("Index", "", "see [[Plan]]\n"));
    write(root, "Notes.md", &page("Notes", "", "n\n"));
    commit_all(root, "Baseline").await;
    let base = head(root).await;
    let runtime = GitRuntime::new();
    std::fs::remove_file(root.join("Plan.md")).unwrap();
    write(root, "Plan 2026.md", &page("Plan 2026", "", "plan\n"));
    write(root, "Index.md", &page("Index", "", "see [[Plan 2026]]\n"));
    write(root, "Notes.md", &page("Notes", "", "n2\n"));
    runtime.pending().record(
        root,
        Some(
            StructuralChange::new(StructuralOp::Rename {
                old: "Plan.md".into(),
                new: "Plan 2026.md".into(),
            })
            .relocating(Relocation {
                source: root.join("Plan.md"),
                target: root.join("Plan 2026.md"),
            }),
        ),
        vec![
            root.join("Plan.md"),
            root.join("Plan 2026.md"),
            root.join("Index.md"),
        ],
    );

    save_all(root, &runtime, RU).await;

    let messages = log(root).await;
    assert!(
        messages.contains(&"Переименована «Plan» в «Plan 2026», обновлена 1 ссылка".to_string()),
        "{messages:?}"
    );
    let commits = commits_since(root, &base).await;
    assert!(
        commits.contains(&vec![
            "Index.md".to_string(),
            "Plan 2026.md".to_string(),
            "Plan.md".to_string()
        ]),
        "{commits:?}"
    );
    assert!(
        commits.contains(&vec!["Notes.md".to_string()]),
        "{commits:?}"
    );
    assert_eq!(git(&cli, root, &["status", "--porcelain"]).await, "");
}

#[tokio::test]
async fn after_a_restart_groups_come_back_by_owner() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "Tasks/schema.yaml", TASKS_SCHEMA);
    for (name, status) in [("BQ-12", "New"), ("BQ-14", "In progress")] {
        write(
            root,
            &format!("Tasks/{name}.md"),
            &page(name, &format!("Status: {status}\n"), "Body\n"),
        );
    }
    write(root, "Guide.md", &page("Guide", "", "## Setup\nold\n"));
    commit_all(root, "Baseline").await;
    for name in ["BQ-12", "BQ-14"] {
        write(
            root,
            &format!("Tasks/{name}.md"),
            &page(name, "Status: Done\n", "Body\n"),
        );
    }
    write(root, "Guide.md", &page("Guide", "", "## Setup\nnew\n"));

    // A fresh runtime holds no pending operations, as after a restart.
    save_all(root, &GitRuntime::new(), RU).await;

    let messages = log(root).await;
    assert!(
        messages
            .iter()
            .any(|message| message.starts_with("Tasks: BQ-12 и BQ-14 → «Done»\n")),
        "{messages:?}"
    );
    assert!(
        messages.contains(&"Guide: правка раздела «Setup»".to_string()),
        "{messages:?}"
    );
}

#[tokio::test]
async fn a_failed_group_keeps_the_landed_ones_and_returns_the_rest_to_pending() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "A.md", &page("Alpha", "", "a\n"));
    write(root, "B.md", &page("Beta", "", "b\n"));
    commit_all(root, "Baseline").await;
    write(root, "A.md", &page("Alpha", "", "a2\n"));
    write(root, "B.md", &page("Beta", "", "b2\n"));
    // The second commit is refused by the hook.
    svode_testkit::write_executable(
        root.join(".git/hooks/pre-commit"),
        "#!/bin/sh\nif [ -f .git/first-done ]; then exit 1; fi\ntouch .git/first-done\n",
    )
    .unwrap();
    let operations = vec![
        PendingOperation {
            id: None,
            op: None,
            relocation: None,
            paths: vec!["A.md".into()],
        },
        PendingOperation {
            id: None,
            op: None,
            relocation: None,
            paths: vec!["B.md".into()],
        },
    ];
    let failure = super::commit_grouped(&cli, root, &[".".into()], &operations, EN)
        .await
        .expect_err("second group refused");
    assert_eq!(failure.report.commits, 1);
    assert_eq!(failure.report.settled, vec![0]);
}

fn placed(place: &str, fact: ChangeFact) -> PlacedFact {
    PlacedFact {
        place: Place::Named(place.into()),
        fact,
    }
}

fn group(place: Place, facts: Vec<PlacedFact>, pages: usize) -> GroupFacts {
    GroupFacts {
        place,
        facts,
        links: 0,
        general: General::Files,
        pages,
        files: pages,
        sensitive: None,
    }
}

fn field(record: &str, to: &str) -> ChangeFact {
    ChangeFact::FieldChanged {
        record: record.into(),
        field: "Status".into(),
        from: Some("In progress".into()),
        to: Some(to.into()),
    }
}

#[test]
fn one_fact_is_said_as_it_is() {
    let one = group(
        Place::Named("Onboarding".into()),
        vec![placed(
            "Onboarding",
            ChangeFact::SectionChanged {
                page: "Onboarding".into(),
                heading: Some("Тарифы".into()),
                share: 20,
            },
        )],
        1,
    );
    let ru = compose(&one, RU);
    assert_eq!(ru.header, "Onboarding: правка раздела «Тарифы»");
    assert!(ru.body.is_empty());
    assert_eq!(ru.text(), "Onboarding: правка раздела «Тарифы»");
    assert_eq!(
        compose(&one, EN).header,
        "Onboarding: edit section “Тарифы”"
    );
}

#[test]
fn many_alike_facts_are_counted_and_listed_in_the_body() {
    let two = group(
        Place::Named("Задачи".into()),
        vec![
            placed("Задачи", field("BQ-12", "Готово")),
            placed("Задачи", field("BQ-14", "Готово")),
        ],
        2,
    );
    let message = compose(&two, RU);
    assert_eq!(message.header, "Задачи: BQ-12 и BQ-14 → «Готово»");
    assert_eq!(
        message.body,
        vec![
            "Задачи: BQ-12: «Status»: «In progress» → «Готово»",
            "Задачи: BQ-14: «Status»: «In progress» → «Готово»",
        ]
    );
    assert_eq!(
        message.text(),
        "Задачи: BQ-12 и BQ-14 → «Готово»\n\n- Задачи: BQ-12: «Status»: «In progress» → «Готово»\n- Задачи: BQ-14: «Status»: «In progress» → «Готово»"
    );
    assert_eq!(
        compose(&two, EN).header,
        "Задачи: BQ-12 and BQ-14 → “Готово”"
    );

    let eight = group(
        Place::Named("Задачи".into()),
        (1..=8)
            .map(|index| placed("Задачи", field(&format!("BQ-{index}"), "Готово")))
            .collect(),
        8,
    );
    assert_eq!(
        compose(&eight, RU).header,
        "Задачи: «Status» → «Готово» у 8 записей"
    );
    assert_eq!(
        compose(&eight, EN).header,
        "Задачи: “Status” → “Готово” in 8 entries"
    );
    assert_eq!(compose(&eight, RU).body.len(), 8);

    let attachments = group(
        Place::Named("Онбординг".into()),
        (0..3)
            .map(|index| {
                placed(
                    "Онбординг",
                    ChangeFact::AttachmentAdded {
                        name: format!("{index}.png"),
                    },
                )
            })
            .collect(),
        0,
    );
    assert_eq!(
        compose(&attachments, RU).header,
        "Онбординг: добавлены 3 вложения"
    );
    assert_eq!(
        compose(&attachments, EN).header,
        "Онбординг: add 3 attachments"
    );
}

#[test]
fn different_facts_lead_with_the_main_one() {
    let mixed = group(
        Place::Named("Онбординг".into()),
        vec![
            placed(
                "Онбординг",
                ChangeFact::AttachmentAdded {
                    name: "a.png".into(),
                },
            ),
            placed(
                "Онбординг",
                ChangeFact::SectionChanged {
                    page: "Онбординг".into(),
                    heading: Some("Тарифы".into()),
                    share: 40,
                },
            ),
            placed(
                "Онбординг",
                ChangeFact::SectionChanged {
                    page: "Онбординг".into(),
                    heading: Some("FAQ".into()),
                    share: 5,
                },
            ),
        ],
        1,
    );
    let ru = compose(&mixed, RU);
    assert_eq!(
        ru.header,
        "Онбординг: правка раздела «Тарифы» и ещё 2 изменения"
    );
    assert_eq!(ru.body.len(), 3);
    assert_eq!(ru.body[1], "Онбординг: правка раздела «Тарифы» (40% строк)");
    assert_eq!(
        compose(&mixed, EN).header,
        "Онбординг: edit section “Тарифы” and 2 more changes"
    );
}

#[test]
fn a_motley_group_gets_the_general_wording_with_its_places() {
    let places = ["Каталог", "Онбординг", "Задачи", "Roadmap"];
    let motley = group(
        Place::Named("Каталог".into()),
        places
            .iter()
            .map(|place| {
                placed(
                    place,
                    ChangeFact::SectionChanged {
                        page: (*place).into(),
                        heading: None,
                        share: 10,
                    },
                )
            })
            .collect(),
        12,
    );
    let ru = compose(&motley, RU);
    assert_eq!(ru.header, "Каталог и ещё 3 раздела: правки 12 страниц");
    assert_eq!(ru.body.len(), 4);
    assert_eq!(
        compose(&motley, EN).header,
        "Каталог and 3 more sections: edit 12 pages"
    );
}

#[test]
fn an_operation_names_its_page_and_its_links() {
    let mut moved = group(
        Place::Named("Root".into()),
        vec![placed(
            "Root",
            ChangeFact::PageMoved {
                title: "Roadmap Q4".into(),
                folder: "Планирование".into(),
            },
        )],
        4,
    );
    moved.links = 3;
    assert_eq!(
        compose(&moved, RU).header,
        "Перемещена «Roadmap Q4» в «Планирование», обновлены 3 ссылки"
    );
    assert_eq!(
        compose(&moved, EN).header,
        "Move “Roadmap Q4” to “Планирование”, update 3 links"
    );
    let schema = group(
        Place::Collection("Задачи".into()),
        vec![PlacedFact {
            place: Place::Collection("Задачи".into()),
            fact: ChangeFact::SchemaFieldAdded {
                field: "Приоритет".into(),
            },
        }],
        0,
    );
    assert_eq!(
        compose(&schema, RU).header,
        "Коллекция «Задачи»: новое поле «Приоритет»"
    );
}

#[test]
fn general_and_sensitive_wordings_exist_in_both_languages() {
    let mut empty = group(Place::Named("Docs".into()), Vec::new(), 12);
    assert_eq!(compose(&empty, RU).header, "Docs: правки 12 страниц");
    assert_eq!(compose(&empty, EN).header, "Docs: edit 12 pages");
    empty.files = 13;
    assert_eq!(compose(&empty, RU).header, "Docs: изменения 13 файлов");
    empty.general = General::Settings;
    assert_eq!(compose(&empty, RU).header, "Docs: настройки");
    assert_eq!(compose(&empty, EN).header, "Docs: settings");
    empty.sensitive = Some(Sensitive::Entries(3));
    assert_eq!(compose(&empty, RU).header, "Правки 3 записей коллекции");
    assert_eq!(compose(&empty, EN).header, "Update 3 collection entries");
}

#[test]
fn no_message_names_an_agent_or_a_routine() {
    // Facts carry no actor: the message is made of the data only.
    let facts = group(
        Place::Named("Docs".into()),
        vec![placed(
            "Docs",
            ChangeFact::PageCreated {
                title: "New".into(),
            },
        )],
        1,
    );
    for language in [EN, RU] {
        let text = compose(&facts, language).text().to_lowercase();
        for word in [
            "agent",
            "агент",
            "routine",
            "рутин",
            "co-authored",
            "session",
        ] {
            assert!(!text.contains(word), "{word} in {text}");
        }
    }
}

#[test]
fn sources_read_their_working_versions_only_within_the_repository() {
    let tmp = tempfile::TempDir::new().unwrap();
    write(tmp.path(), "a.md", "text");
    let sources = Sources::of(tmp.path(), HashMap::new());
    assert_eq!(sources.work("a.md").as_deref(), Some("text"));
    assert_eq!(sources.work("missing.md"), None);
    assert_eq!(sources.head("a.md"), None);
}

#[test]
fn the_message_language_follows_the_interface_locale() {
    assert_eq!(MessageLanguage::from_locale("ru"), RU);
    assert_eq!(MessageLanguage::from_locale("ru-RU"), RU);
    assert_eq!(MessageLanguage::from_locale("en"), EN);
    assert_eq!(MessageLanguage::from_locale("de"), EN);
}
