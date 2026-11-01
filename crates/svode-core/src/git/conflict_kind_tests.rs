//! The kind of a conflicted Page follows the merge of its index stages, not
//! its working file (DF-295 R2).

use super::*;
use crate::git::stage_merge::tests::Stand;

const ONBOARDING: &str = "---\ntitle: Онбординг\nstatus: Черновик\nowner: Анна\ndue: 2026-11-10\ntags:\n  - команда\n  - процесс\n---\nВводный абзац про онбординг.\n\n## Первый день\n\nПолучить доступы и пройти обзор продукта.\n\n## Первая неделя\n\nРазобрать три задачи с наставником.\n";

const PRICES: &str = "---\ntitle: Тарифы\nprice: 10\ncurrency: \"USD\"\nnote: |\n  Цена без налога.\n  Пересматривается раз в квартал.\n---\nТекст страницы тарифов без конфликта.\n";

const LOGIN: &str =
    "---\ntitle: Починить вход\nСтатус: Открыта\nИсполнитель: Анна\n---\nОписание задачи.\n";

fn edit(text: &str, replacements: &[(&str, &str)]) -> String {
    replacements
        .iter()
        .fold(text.to_owned(), |text, (from, to)| {
            assert!(text.contains(from), "{from:?}");
            text.replacen(from, to, 1)
        })
}

/// The review stand of DF-295: properties edited on both sides of three
/// Pages, the text of «Онбординг» too.
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

async fn kinds(stand: &Stand) -> Vec<(String, ConflictKind)> {
    let mut kinds: Vec<_> = unresolved(&stand.cli, &stand.repo)
        .await
        .unwrap()
        .into_iter()
        .map(|conflict| (conflict.path, conflict.kind))
        .collect();
    kinds.sort_by(|a, b| a.0.cmp(&b.0));
    kinds
}

fn expected(entries: &[(&str, ConflictKind)]) -> Vec<(String, ConflictKind)> {
    entries
        .iter()
        .map(|(path, kind)| ((*path).to_owned(), *kind))
        .collect()
}

#[tokio::test]
async fn the_pages_of_the_review_stand_are_in_their_properties() {
    let stand = review("").await;
    let all = expected(&[
        ("Задачи/Починить вход.md", ConflictKind::PageProperties),
        ("Онбординг.md", ConflictKind::PageProperties),
        ("Тарифы.md", ConflictKind::PageProperties),
    ]);
    assert_eq!(kinds(&stand).await, all);
    // The editor wrote the chosen properties without markers and left the
    // block of the text; another Page is written without any marker. The
    // stages stand, so the kinds do not change.
    let onboarding = stand.read("Онбординг.md");
    let (_, text) = onboarding
        .split_once(">>>>>>> theirs\n")
        .expect("a place in the properties");
    stand.write(
        "Онбординг.md",
        &format!("---\ntitle: Онбординг\nstatus: Готово\nowner: Анна Ли\n{text}"),
    );
    assert!(stand.read("Онбординг.md").contains("<<<<<<< HEAD\n"));
    stand.write("Тарифы.md", PRICES);
    assert_eq!(kinds(&stand).await, all);
}

#[tokio::test]
async fn the_marker_size_of_the_path_reads_the_merge() {
    let stand = review("*.md conflict-marker-size=10\n").await;
    assert!(stand.read("Тарифы.md").contains("<<<<<<<<<< HEAD\n"));
    assert_eq!(
        kinds(&stand).await,
        expected(&[
            ("Задачи/Починить вход.md", ConflictKind::PageProperties),
            ("Онбординг.md", ConflictKind::PageProperties),
            ("Тарифы.md", ConflictKind::PageProperties),
        ])
    );
}

#[tokio::test]
async fn places_of_the_text_alone_are_in_the_text_whatever_the_working_file() {
    let page = "---\ntitle: Заметки\n---\nОбщий абзац.\n\nИсходная строка.\n";
    let stand = Stand::merge(
        "",
        &[("Заметки.md", page)],
        &[(
            "Заметки.md",
            &page.replace("Исходная строка.", "Входящая строка."),
        )],
        &[(
            "Заметки.md",
            &page.replace("Исходная строка.", "Моя строка."),
        )],
    )
    .await;
    let text = expected(&[("Заметки.md", ConflictKind::PageText)]);
    assert_eq!(kinds(&stand).await, text);
    // Markers written into the frontmatter of the working file do not make
    // it a conflict of the properties.
    stand.write(
        "Заметки.md",
        "---\n<<<<<<< HEAD\ntitle: A\n=======\ntitle: B\n>>>>>>> theirs\n---\nТекст.\n",
    );
    assert_eq!(kinds(&stand).await, text);
}

#[tokio::test]
async fn a_place_through_the_closing_line_or_from_the_first_line_is_in_the_properties() {
    let span = "---\ntitle: A\nnote: x\n---\nText\n";
    let stand = Stand::merge(
        "",
        &[("span.md", span), ("first.md", "Hello\n")],
        &[
            (
                "span.md",
                &span.replace("note: x\n---\nText", "note: z\n---\nTheirs"),
            ),
            ("first.md", "Hello theirs\n"),
        ],
        &[
            (
                "span.md",
                &span.replace("note: x\n---\nText", "note: y\n---\nMine"),
            ),
            ("first.md", "---\ntitle: A\n---\nHello\n"),
        ],
    )
    .await;
    // Git writes one place over the closing `---` and one from the first line.
    assert!(
        stand
            .read("span.md")
            .contains("<<<<<<< HEAD\nnote: y\n---\nMine\n=======\n")
    );
    assert!(stand.read("first.md").starts_with("<<<<<<< HEAD\n---\n"));
    assert_eq!(
        kinds(&stand).await,
        expected(&[
            ("first.md", ConflictKind::PageProperties),
            ("span.md", ConflictKind::PageProperties),
        ])
    );
}
