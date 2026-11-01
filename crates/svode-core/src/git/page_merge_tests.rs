use super::*;
use crate::git::stage_merge::tests::Stand;
use std::io::Write as _;
use std::process::{Command, Stdio};

const ONBOARDING: &str = "---\ntitle: Онбординг\nstatus: Черновик\nowner: Анна\ndue: 2026-11-10\ntags:\n  - команда\n  - процесс\n---\nВводный абзац про онбординг.\n\n## Первый день\n\nПолучить доступы и пройти обзор продукта.\n\n## Первая неделя\n\nРазобрать три задачи с наставником.\n";

const PRICES: &str = "---\ntitle: Тарифы\nprice: 10\ncurrency: \"USD\"\nnote: |\n  Цена без налога.\n  Пересматривается раз в квартал.\n---\nТекст страницы тарифов без конфликта.\n";

const LOGIN: &str =
    "---\ntitle: Починить вход\nСтатус: Открыта\nИсполнитель: Анна\n---\nОписание задачи.\n";

/// E4-like frontmatter: quotes, a date, a list, a block value with Markdown
/// characters and a trailing backslash, a YAML comment.
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

fn edit(text: &str, replacements: &[(&str, &str)]) -> String {
    replacements
        .iter()
        .fold(text.to_owned(), |text, (from, to)| {
            assert!(text.contains(from), "{from:?}");
            text.replacen(from, to, 1)
        })
}

fn yaml(text: &str) -> Value {
    serde_norway::from_str(text).unwrap()
}

/// The review stand of DF-292 and DF-295. `Stand::merge` takes the incoming
/// edits before mine.
async fn review(attributes: &str) -> Stand {
    Stand::merge(
        attributes,
        &[
            ("Онбординг.md", ONBOARDING),
            ("Тарифы.md", PRICES),
            ("Задачи/Починить вход.md", LOGIN),
        ],
        &[
            (
                "Онбординг.md",
                &edit(
                    ONBOARDING,
                    &[
                        (
                            "status: Черновик\nowner: Анна",
                            "status: На проверке\nowner: Борис",
                        ),
                        (
                            "Получить доступы и пройти обзор продукта.",
                            "Получить доступы, ноутбук и пропуск.",
                        ),
                    ],
                ),
            ),
            (
                "Тарифы.md",
                &edit(
                    PRICES,
                    &[
                        (
                            "price: 10\ncurrency: \"USD\"",
                            "price: 12\ncurrency: \"EUR\"",
                        ),
                        ("  Цена без налога.\n", "  Цена с налогом.\n"),
                    ],
                ),
            ),
            (
                "Задачи/Починить вход.md",
                &edit(
                    LOGIN,
                    &[(
                        "Статус: Открыта\nИсполнитель: Анна",
                        "Статус: Готово\nИсполнитель: Борис",
                    )],
                ),
            ),
        ],
        &[
            (
                "Онбординг.md",
                &edit(
                    ONBOARDING,
                    &[
                        (
                            "status: Черновик\nowner: Анна",
                            "status: Готово\nowner: Анна Ли",
                        ),
                        (
                            "Получить доступы и пройти обзор продукта.",
                            "Получить доступы и встретиться с командой.",
                        ),
                    ],
                ),
            ),
            (
                "Тарифы.md",
                &edit(
                    PRICES,
                    &[
                        (
                            "price: 10\ncurrency: \"USD\"",
                            "price: 11\ncurrency: \"USD\"  # базовая",
                        ),
                        ("  Цена без налога.\n", "  Цена без налога, без скидок.\n"),
                    ],
                ),
            ),
            (
                "Задачи/Починить вход.md",
                &edit(
                    LOGIN,
                    &[(
                        "Статус: Открыта\nИсполнитель: Анна",
                        "Статус: Открыта\nИсполнитель: Вера",
                    )],
                ),
            ),
        ],
    )
    .await
}

async fn merged(stand: &Stand, path: &str) -> (Vec<MergedProperty>, String) {
    match read(&stand.cli, &stand.repo, path).await.unwrap() {
        PageMerge::Merged { properties, body } => (properties, body),
        other => panic!("{path}: {other:?}"),
    }
}

fn disputed(properties: &[MergedProperty]) -> Vec<&str> {
    properties
        .iter()
        .filter(|property| property.disputed)
        .map(|property| property.key.as_str())
        .collect()
}

fn property<'a>(properties: &'a [MergedProperty], key: &str) -> &'a MergedProperty {
    properties
        .iter()
        .find(|property| property.key == key)
        .unwrap_or_else(|| panic!("no {key} in {properties:?}"))
}

fn decisions(items: &[(&str, PropertyDecision)]) -> BTreeMap<String, PropertyDecision> {
    items
        .iter()
        .map(|(key, decision)| ((*key).to_owned(), decision.clone()))
        .collect()
}

async fn compose_page(
    stand: &Stand,
    path: &str,
    items: &[(&str, PropertyDecision)],
    body: &str,
) -> PageMergeResult {
    compose(&stand.cli, &stand.repo, path, &decisions(items), body)
        .await
        .unwrap()
}

async fn composed(
    stand: &Stand,
    path: &str,
    items: &[(&str, PropertyDecision)],
    body: &str,
) -> String {
    match compose_page(stand, path, items, body).await {
        PageMergeResult::Composed { content } => {
            assert_stable(&content);
            content
        }
        other => panic!("{path}: {other:?}"),
    }
}

/// The content reads as a Page and the writer writes it again byte for byte.
fn assert_stable(content: &str) {
    let ParseStatus::Valid { meta, body } = frontmatter::parse_status(content) else {
        panic!("not a Page with frontmatter: {content}");
    };
    assert_eq!(frontmatter::serialize(&meta, &body), content);
}

fn meta_of(content: &str) -> PageMeta {
    match frontmatter::parse_status(content) {
        ParseStatus::Valid { meta, .. } => meta,
        _ => panic!("{content}"),
    }
}

#[tokio::test]
async fn the_review_pages_dispute_only_the_keys_both_sides_changed() {
    let stand = review("").await;

    let (properties, body) = merged(&stand, "Онбординг.md").await;
    assert_eq!(disputed(&properties), ["status", "owner"]);
    let status = property(&properties, "status");
    assert_eq!(status.base, Some(yaml("Черновик")));
    assert_eq!(status.ours, Some(yaml("Готово")));
    assert_eq!(status.theirs, Some(yaml("На проверке")));
    assert_eq!(status.merged, None);
    assert_eq!(
        property(&properties, "due").merged,
        Some(yaml("2026-11-10"))
    );
    assert_eq!(
        property(&properties, "tags").merged,
        Some(yaml("[команда, процесс]"))
    );
    assert_eq!(
        properties
            .iter()
            .map(|property| property.key.as_str())
            .collect::<Vec<_>>(),
        ["title", "status", "owner", "due", "tags"]
    );
    // The text below the properties is a merge of text with its own block.
    assert!(body.starts_with("Вводный абзац про онбординг.\n"), "{body}");
    assert!(
        body.contains(
            "<<<<<<< ours\nПолучить доступы и встретиться с командой.\n=======\nПолучить доступы, ноутбук и пропуск.\n>>>>>>> theirs\n"
        ),
        "{body}"
    );

    let (properties, body) = merged(&stand, "Задачи/Починить вход.md").await;
    assert_eq!(disputed(&properties), ["Исполнитель"]);
    // Only the incoming side changed «Статус»: it is taken on its own.
    assert_eq!(property(&properties, "Статус").merged, Some(yaml("Готово")));
    assert_eq!(body, "Описание задачи.\n");

    let (properties, body) = merged(&stand, "Тарифы.md").await;
    assert_eq!(disputed(&properties), ["price", "note"]);
    // `"USD"  # базовая` of my side is the base value `"USD"`.
    assert_eq!(property(&properties, "currency").merged, Some(yaml("EUR")));
    assert_eq!(
        property(&properties, "note").ours,
        // The reader of Pages reads the frontmatter up to the line break
        // before its closing `---`: a block value at its end keeps no final
        // line break.
        Some(Value::String(
            "Цена без налога, без скидок.\nПересматривается раз в квартал.".into()
        ))
    );
    assert_eq!(body, "Текст страницы тарифов без конфликта.\n");
}

#[tokio::test]
async fn the_page_is_composed_by_the_writer_of_page_frontmatter() {
    let stand = review("").await;
    let content = composed(
        &stand,
        "Тарифы.md",
        &[
            ("price", PropertyDecision::Ours),
            ("note", PropertyDecision::Theirs),
        ],
        "Текст страницы тарифов без конфликта.\n",
    )
    .await;
    assert_eq!(
        content,
        "---\ntitle: Тарифы\nprice: 11\ncurrency: EUR\nnote: |-\n  Цена с налогом.\n  Пересматривается раз в квартал.\n---\nТекст страницы тарифов без конфликта.\n"
    );

    let content = composed(
        &stand,
        "Задачи/Починить вход.md",
        &[(
            "Исполнитель",
            PropertyDecision::Value {
                value: serde_json::json!("Галина"),
            },
        )],
        "Описание задачи.\n",
    )
    .await;
    assert_eq!(
        content,
        "---\ntitle: Починить вход\nСтатус: Готово\nИсполнитель: Галина\n---\nОписание задачи.\n"
    );
}

#[tokio::test]
async fn changes_of_one_side_and_same_changes_merge_in_any_spelling() {
    let stand = Stand::merge(
        "",
        &[("plan.md", PLAN)],
        &[(
            "plan.md",
            &edit(
                PLAN,
                &[
                    ("status: draft", "status: done"),
                    ("due: 2026-10-01", "due: 2026-11-15"),
                    ("owner: 'Ann_Lee'", "owner: \"Ann_Lee\""),
                    ("  Second line", "  Changed second line"),
                ],
            ),
        )],
        &[(
            "plan.md",
            &edit(
                PLAN,
                &[
                    ("status: draft", "status: \"done\""),
                    ("due: 2026-10-01", "due: '2026-10-01'"),
                    ("tags:\n  - plan\n  - q4\n", "tags: [plan, q4]\n"),
                ],
            ),
        )],
    )
    .await;
    assert!(stand.read("plan.md").contains("<<<<<<< HEAD\n"));
    let (properties, body) = merged(&stand, "plan.md").await;
    assert!(disputed(&properties).is_empty(), "{properties:?}");
    assert_eq!(property(&properties, "status").merged, Some(yaml("done")));
    assert_eq!(
        property(&properties, "due").merged,
        Some(yaml("2026-11-15"))
    );
    assert_eq!(property(&properties, "owner").merged, Some(yaml("Ann_Lee")));
    assert_eq!(
        property(&properties, "tags").merged,
        Some(yaml("[plan, q4]"))
    );
    let description =
        "First line with *stars* and [brackets]\nChanged second line ends with backslash \\\n";
    assert_eq!(
        property(&properties, "description").merged,
        Some(Value::String(description.into()))
    );
    assert_eq!(body, "# Heading\n\nBody text with _underscores_.\n");

    // No disputed key: the merged properties are accepted as they are.
    let content = composed(&stand, "plan.md", &[], &body).await;
    let meta = meta_of(&content);
    assert_eq!(meta.title, "Release \"Q4\" plan");
    assert_eq!(meta.description.as_deref(), Some(description));
    assert_eq!(meta.extra.get("owner"), Some(&yaml("Ann_Lee")));
    assert_eq!(meta.extra.get("due"), Some(&yaml("2026-11-15")));
    // The writer keeps no YAML comment.
    assert!(!content.contains("# a YAML comment"), "{content}");
    assert!(content.ends_with("---\n# Heading\n\nBody text with _underscores_.\n"));
}

#[tokio::test]
async fn an_edit_against_a_deletion_is_disputed_and_a_lone_deletion_merges() {
    const RECORD: &str = "---\ntitle: Fix login\nunique_id: 12\nstatus: In progress\nestimate: 3\nnotes: keep\n---\nSteps.\n";
    let stand = Stand::merge(
        "",
        &[("record.md", RECORD)],
        &[(
            "record.md",
            &edit(
                RECORD,
                &[("unique_id: 12\n", ""), ("estimate: 3", "estimate: 5")],
            ),
        )],
        &[("record.md", &edit(RECORD, &[("estimate: 3\n", "")]))],
    )
    .await;
    let (properties, _) = merged(&stand, "record.md").await;
    assert_eq!(disputed(&properties), ["estimate"]);
    let estimate = property(&properties, "estimate");
    assert_eq!(estimate.base, Some(yaml("3")));
    assert_eq!(estimate.ours, None);
    assert_eq!(estimate.theirs, Some(yaml("5")));
    // Deleted by the incoming side alone: no key is left.
    assert!(
        properties
            .iter()
            .all(|property| property.key != "unique_id")
    );

    let mine = composed(
        &stand,
        "record.md",
        &[("estimate", PropertyDecision::Ours)],
        "Steps.\n",
    )
    .await;
    assert_eq!(
        mine,
        "---\ntitle: Fix login\nstatus: In progress\nnotes: keep\n---\nSteps.\n"
    );
    let incoming = composed(
        &stand,
        "record.md",
        &[("estimate", PropertyDecision::Theirs)],
        "Steps.\n",
    )
    .await;
    assert_eq!(meta_of(&incoming).extra.get("estimate"), Some(&yaml("5")));
}

#[tokio::test]
async fn added_on_both_sides_disputes_every_key_that_differs() {
    let stand = Stand::merge(
        "",
        &[],
        &[(
            "new.md",
            "---\ntitle: B\nstatus: open\nowner: Ann\n---\nSame\n",
        )],
        &[(
            "new.md",
            "---\ntitle: A\nstatus: open\npriority: high\n---\nSame\n",
        )],
    )
    .await;
    let (properties, body) = merged(&stand, "new.md").await;
    assert_eq!(disputed(&properties), ["title", "priority", "owner"]);
    assert!(properties.iter().all(|property| property.base.is_none()));
    assert_eq!(property(&properties, "status").merged, Some(yaml("open")));
    assert_eq!(body, "Same\n");
}

#[tokio::test]
async fn system_keys_merge_by_the_same_rule() {
    const PAGE: &str = "---\ntitle: Plan\nicon: 📄\ndescription: Old\nstatus: a\n---\nBody\n";
    let stand = Stand::merge(
        "",
        &[("page.md", PAGE)],
        &[(
            "page.md",
            &edit(
                PAGE,
                &[("title: Plan", "title: Plan B"), ("icon: 📄", "icon: 🚀")],
            ),
        )],
        &[(
            "page.md",
            &edit(
                PAGE,
                &[
                    ("title: Plan", "title: Plan A"),
                    ("description: Old", "description: New"),
                ],
            ),
        )],
    )
    .await;
    let (properties, _) = merged(&stand, "page.md").await;
    assert_eq!(disputed(&properties), ["title"]);
    assert_eq!(property(&properties, "icon").merged, Some(yaml("🚀")));
    assert_eq!(
        property(&properties, "description").merged,
        Some(yaml("New"))
    );

    let content = composed(
        &stand,
        "page.md",
        &[(
            "title",
            PropertyDecision::Value {
                value: serde_json::json!("Plan C"),
            },
        )],
        "Body\n",
    )
    .await;
    assert_eq!(
        content,
        "---\ntitle: Plan C\nicon: 🚀\ndescription: New\nstatus: a\n---\nBody\n"
    );
    // A value the field rules refuse does not read.
    assert_eq!(
        compose_page(
            &stand,
            "page.md",
            &[(
                "title",
                PropertyDecision::Value {
                    value: serde_json::json!(5),
                },
            )],
            "Body\n",
        )
        .await,
        PageMergeResult::Unresolved {
            finding: ResolutionFinding::Unreadable {
                message: "invalid entry field: title must be a string".into()
            }
        }
    );
}

#[tokio::test]
async fn a_place_through_the_closing_delimiter_is_a_property_and_a_text_block() {
    const PAGE: &str = "---\ntitle: T\nstatus: a\n---\nFirst line.\nRest.\n";
    let stand = Stand::merge(
        "",
        &[("page.md", PAGE)],
        &[(
            "page.md",
            &edit(
                PAGE,
                &[("status: a", "status: c"), ("First line.", "First theirs.")],
            ),
        )],
        &[(
            "page.md",
            &edit(
                PAGE,
                &[("status: a", "status: b"), ("First line.", "First mine.")],
            ),
        )],
    )
    .await;
    let written = stand.read("page.md");
    assert!(
        written.contains("<<<<<<< HEAD\nstatus: b\n---\nFirst mine.\n"),
        "{written}"
    );
    let (properties, body) = merged(&stand, "page.md").await;
    assert_eq!(disputed(&properties), ["status"]);
    assert_eq!(
        body,
        "<<<<<<< ours\nFirst mine.\n=======\nFirst theirs.\n>>>>>>> theirs\nRest.\n"
    );
    let content = composed(
        &stand,
        "page.md",
        &[("status", PropertyDecision::Theirs)],
        "First mine.\nRest.\n",
    )
    .await;
    assert_eq!(
        content,
        "---\ntitle: T\nstatus: c\n---\nFirst mine.\nRest.\n"
    );
}

#[tokio::test]
async fn decisions_must_be_exactly_those_of_the_disputed_keys() {
    let stand = review("").await;
    let changed = PageMergeResult::Unresolved {
        finding: ResolutionFinding::Changed,
    };
    let body = "Текст страницы тарифов без конфликта.\n";
    assert_eq!(
        compose_page(
            &stand,
            "Тарифы.md",
            &[("price", PropertyDecision::Ours)],
            body
        )
        .await,
        changed
    );
    assert_eq!(
        compose_page(
            &stand,
            "Тарифы.md",
            &[
                ("price", PropertyDecision::Ours),
                ("note", PropertyDecision::Ours),
                ("currency", PropertyDecision::Ours),
            ],
            body,
        )
        .await,
        changed
    );
    // A text block left unresolved keeps the path unresolved.
    let (_, merged_body) = merged(&stand, "Онбординг.md").await;
    assert_eq!(
        compose_page(
            &stand,
            "Онбординг.md",
            &[
                ("status", PropertyDecision::Ours),
                ("owner", PropertyDecision::Theirs),
            ],
            &merged_body,
        )
        .await,
        PageMergeResult::Unresolved {
            finding: ResolutionFinding::Markers
        }
    );
    // Nothing is written.
    assert!(stand.read("Онбординг.md").contains("<<<<<<< HEAD\n"));
}

#[tokio::test]
async fn the_text_below_takes_the_marker_size_of_the_path() {
    let stand = review("*.md conflict-marker-size=10\n").await;
    let (properties, body) = merged(&stand, "Онбординг.md").await;
    assert_eq!(disputed(&properties), ["status", "owner"]);
    assert!(body.contains("<<<<<<<<<< ours\n"), "{body}");
    assert!(body.contains("\n==========\n"), "{body}");
    assert_eq!(
        compose_page(
            &stand,
            "Онбординг.md",
            &[
                ("status", PropertyDecision::Ours),
                ("owner", PropertyDecision::Theirs),
            ],
            &body,
        )
        .await,
        PageMergeResult::Unresolved {
            finding: ResolutionFinding::Markers
        }
    );
    // Markers of the default size are text for this path.
    let text = "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n";
    let content = composed(
        &stand,
        "Онбординг.md",
        &[
            ("status", PropertyDecision::Ours),
            ("owner", PropertyDecision::Theirs),
        ],
        text,
    )
    .await;
    assert!(
        content.contains("status: Готово\nowner: Борис\n"),
        "{content}"
    );
}

#[tokio::test]
async fn an_unreadable_side_gives_no_choice_by_properties() {
    const PAGE: &str = "---\ntitle: T\nstatus: a\n---\nBody\n";
    let stand = Stand::merge(
        "",
        &[("page.md", PAGE)],
        &[(
            "page.md",
            &edit(PAGE, &[("status: a", "status: [unclosed")]),
        )],
        &[("page.md", &edit(PAGE, &[("status: a", "status: b")]))],
    )
    .await;
    match read(&stand.cli, &stand.repo, "page.md").await.unwrap() {
        PageMerge::Unavailable {
            reason:
                NoMerge::Unreadable {
                    stage: Stage::Theirs,
                    ..
                },
        } => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(
        compose_page(&stand, "page.md", &[], "Body\n").await,
        PageMergeResult::Unresolved {
            finding: ResolutionFinding::Changed
        }
    );
}

#[tokio::test]
async fn a_missing_stage_gives_no_choice_by_properties() {
    let stand = review("").await;
    // The incoming side deleted the path: only the base and mine stay.
    let git = |args: &[&str], input: Option<&str>| {
        let mut child = Command::new("git")
            .args(args)
            .current_dir(&stand.repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8(out.stdout).unwrap()
    };
    let stages = git(
        &[
            "-c",
            "core.quotePath=false",
            "ls-files",
            "-s",
            "--",
            "Тарифы.md",
        ],
        None,
    );
    let kept: String = stages
        .lines()
        .filter(|line| !line.contains(" 3\t"))
        .map(|line| format!("{line}\n"))
        .collect();
    let input = format!("0 {} 0\tТарифы.md\n{kept}", "0".repeat(40));
    git(&["update-index", "--index-info"], Some(&input));
    assert_eq!(
        read(&stand.cli, &stand.repo, "Тарифы.md").await.unwrap(),
        PageMerge::Unavailable {
            reason: NoMerge::MissingStage
        }
    );
}
