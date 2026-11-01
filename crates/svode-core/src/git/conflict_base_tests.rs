use super::*;
use crate::git::stage_merge::tests::Stand;
use std::process::Command;

const ONBOARDING: &str = "---\ntitle: Онбординг\nstatus: Черновик\n---\nВводный абзац про онбординг.\n\n## Первый день\n\nПолучить доступы и пройти обзор продукта.\n\n## Первая неделя\n\nРазобрать три задачи с наставником.\n\nПознакомиться с процессом релиза.\n\n## Первый месяц\n\nВзять первую задачу целиком.\n";

const FIRST_DAY: &str = "Получить доступы и пройти обзор продукта.";

/// A merge of «Онбординг» that stopped at a conflict in «Первый день».
async fn first_day(attributes: &str) -> Stand {
    Stand::merge(
        attributes,
        &[("Онбординг.md", ONBOARDING)],
        &[(
            "Онбординг.md",
            &ONBOARDING.replace(FIRST_DAY, "Получить доступы, ноутбук и пропуск."),
        )],
        &[(
            "Онбординг.md",
            &ONBOARDING.replace(FIRST_DAY, "Получить доступы и встретиться с командой."),
        )],
    )
    .await
}

/// The text of a Page after its frontmatter, as the editor reads it.
fn body(page: &str) -> &str {
    let close = page[3..].find("\n---").unwrap() + 3 + 4;
    let rest = &page[close..];
    rest.strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .unwrap_or(rest)
}

/// Git writes the conflict of `file` again in `style`.
fn rewrite_conflict(stand: &Stand, file: &str, style: &str) {
    let out = Command::new("git")
        .args(["checkout", &format!("--conflict={style}"), "--", file])
        .current_dir(&stand.repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

async fn bases(stand: &Stand, file: &str, content: &str, size: usize) -> Vec<Option<String>> {
    place_bases(
        Some(&stand.cli),
        &stand.repo.join(file),
        content.as_bytes(),
        size,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_place_of_the_merge_style_takes_its_base_from_the_stages() {
    let stand = first_day("").await;
    let page = stand.read("Онбординг.md");
    assert!(page.contains("<<<<<<< HEAD\n"));
    assert!(!page.contains("|||||||"));
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 7).await,
        vec![Some(FIRST_DAY.to_owned())]
    );
}

#[tokio::test]
async fn a_place_of_the_diff3_or_zdiff3_style_holds_its_base_without_git() {
    for style in ["diff3", "zdiff3"] {
        let stand = first_day("").await;
        rewrite_conflict(&stand, "Онбординг.md", style);
        let page = stand.read("Онбординг.md");
        assert!(page.contains("||||||| "), "{style}: {page}");
        let expected = vec![Some(FIRST_DAY.to_owned())];
        assert_eq!(
            bases(&stand, "Онбординг.md", body(&page), 7).await,
            expected
        );
        let without_git = place_bases(
            None,
            &stand.repo.join("Онбординг.md"),
            body(&page).as_bytes(),
            7,
        )
        .await
        .unwrap();
        assert_eq!(without_git, expected, "{style}");
    }
}

#[tokio::test]
async fn the_marker_size_of_the_path_reads_the_places() {
    let stand = first_day("*.md conflict-marker-size=10\n").await;
    let page = stand.read("Онбординг.md");
    assert!(page.contains("<<<<<<<<<< HEAD\n"));
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 10).await,
        vec![Some(FIRST_DAY.to_owned())]
    );
    rewrite_conflict(&stand, "Онбординг.md", "diff3");
    let page = stand.read("Онбординг.md");
    assert!(page.contains("|||||||||| "));
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 10).await,
        vec![Some(FIRST_DAY.to_owned())]
    );
}

#[tokio::test]
async fn every_place_takes_its_own_base_also_where_git_joins_places() {
    const PLAN: &str = "## Первый день\n\nДоступы.\n\nОбзор продукта.\n\n## Первая неделя\n\nЗадачи с наставником.\nПроцесс релиза.\nДежурство.\nРетро.\n\n## Первый месяц\n\nПервая задача.\n";
    let edit = |access: &str, review: &str, task: &str| {
        PLAN.replace("Доступы.", access)
            .replace("Обзор продукта.", review)
            .replace("Первая задача.", task)
    };
    let stand = Stand::merge(
        "",
        &[("План.md", PLAN)],
        &[(
            "План.md",
            &edit("Ноутбук.", "Обзор и демо.", "Задача с наставником."),
        )],
        &[("План.md", &edit("Пропуск.", "Обзор кода.", "Две задачи."))],
    )
    .await;
    let page = stand.read("План.md");
    // Two paragraphs a blank line apart are one place of Git, two of diff3.
    assert_eq!(page.matches("<<<<<<< HEAD\n").count(), 2, "{page}");
    assert!(
        page.contains("<<<<<<< HEAD\nПропуск.\n\nОбзор кода.\n=======\n"),
        "{page}"
    );
    assert_eq!(
        bases(&stand, "План.md", &page, 7).await,
        vec![
            Some("Доступы.\n\nОбзор продукта.".to_owned()),
            Some("Первая задача.".to_owned()),
        ]
    );
}

#[tokio::test]
async fn lines_both_sides_added_around_a_place_stay_out_of_its_base() {
    let stand = Stand::merge(
        "",
        &[("План.md", "# План\n\nШаг.\n")],
        &[("План.md", "# План\n\nВступление.\nВходящий шаг.\nИтог.\n")],
        &[("План.md", "# План\n\nВступление.\nМой шаг.\nИтог.\n")],
    )
    .await;
    let page = stand.read("План.md");
    assert!(
        page.contains("Вступление.\n<<<<<<< HEAD\nМой шаг.\n=======\n"),
        "{page}"
    );
    assert_eq!(
        bases(&stand, "План.md", &page, 7).await,
        vec![Some("Шаг.".to_owned())]
    );
}

#[tokio::test]
async fn a_page_with_crlf_line_endings_matches_the_stages() {
    let stand = first_day("*.md text eol=crlf\n").await;
    let page = stand.read("Онбординг.md");
    assert!(page.contains("<<<<<<< HEAD\r\n"), "{page:?}");
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 7).await,
        vec![Some(FIRST_DAY.to_owned())]
    );
    rewrite_conflict(&stand, "Онбординг.md", "diff3");
    let page = stand.read("Онбординг.md");
    assert!(page.contains("||||||| "));
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 7).await,
        vec![Some(FIRST_DAY.to_owned())]
    );
}

#[tokio::test]
async fn sides_that_both_added_the_page_have_no_base() {
    let stand = Stand::merge(
        "",
        &[],
        &[("План.md", "# План\n\nВходящий план.\n")],
        &[("План.md", "# План\n\nМой план.\n")],
    )
    .await;
    let page = stand.read("План.md");
    assert!(page.contains("<<<<<<< HEAD\n"));
    assert_eq!(bases(&stand, "План.md", &page, 7).await, vec![None]);
}

#[tokio::test]
async fn sides_that_both_added_the_page_have_no_base_in_the_diff3_or_zdiff3_style() {
    for style in ["diff3", "zdiff3"] {
        let stand = Stand::merge(
            "",
            &[],
            &[("План.md", "# План\n\nВходящий план.\n")],
            &[("План.md", "# План\n\nМой план.\n")],
        )
        .await;
        rewrite_conflict(&stand, "План.md", style);
        let page = stand.read("План.md");
        assert!(page.contains("||||||| "), "{style}: {page}");
        assert_eq!(
            bases(&stand, "План.md", &page, 7).await,
            vec![None],
            "{style}"
        );
    }
}

#[tokio::test]
async fn an_empty_base_of_a_path_with_a_base_stage_is_a_base() {
    let stand = Stand::merge(
        "",
        &[("План.md", "# План\n")],
        &[("План.md", "# План\nВходящий шаг.\n")],
        &[("План.md", "# План\nМой шаг.\n")],
    )
    .await;
    rewrite_conflict(&stand, "План.md", "diff3");
    let page = stand.read("План.md");
    assert!(page.contains("||||||| "), "{page}");
    assert_eq!(
        bases(&stand, "План.md", &page, 7).await,
        vec![Some(String::new())]
    );
}

#[tokio::test]
async fn a_place_of_the_diff3_style_without_stages_holds_its_base() {
    let stand = Stand::merge(
        "",
        &[],
        &[("План.md", "# План\n\nВходящий план.\n")],
        &[("План.md", "# План\n\nМой план.\n")],
    )
    .await;
    // Marker lines from history: the path is out of conflict.
    let text = "# План\n\n<<<<<<< ours\nМой план.\n||||||| base\nПлан.\n=======\nВходящий план.\n>>>>>>> theirs\n";
    stand.write("Другой.md", text);
    assert_eq!(
        bases(&stand, "Другой.md", text, 7).await,
        vec![Some("План.".to_owned())]
    );
}

#[tokio::test]
async fn a_place_edited_after_the_merge_has_no_base() {
    let stand = Stand::merge(
        "",
        &[("Онбординг.md", ONBOARDING)],
        &[(
            "Онбординг.md",
            &ONBOARDING.replace(FIRST_DAY, "Получить ноутбук.").replace(
                "Взять первую задачу целиком.",
                "Вести задачу с наставником.",
            ),
        )],
        &[(
            "Онбординг.md",
            &ONBOARDING
                .replace(FIRST_DAY, "Получить пропуск.")
                .replace("Взять первую задачу целиком.", "Вести две задачи."),
        )],
    )
    .await;
    let page = stand
        .read("Онбординг.md")
        .replace("Получить пропуск.", "Получить пропуск и ключи.");
    stand.write("Онбординг.md", &page);
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 7).await,
        vec![None, Some("Взять первую задачу целиком.".to_owned())]
    );
}

#[tokio::test]
async fn a_path_out_of_conflict_or_an_ambiguous_place_has_no_base() {
    let stand = first_day("").await;
    let page = stand.read("Онбординг.md");
    // A setext underline of seven `=` in my side allows another split.
    let ambiguous = body(&page).replace(
        "Получить доступы и встретиться с командой.",
        "Заголовок\n=======\nПолучить доступы и встретиться с командой.",
    );
    assert_eq!(
        bases(&stand, "Онбординг.md", &ambiguous, 7).await,
        vec![None]
    );
    let out = Command::new("git")
        .args(["add", "Онбординг.md"])
        .current_dir(&stand.repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        bases(&stand, "Онбординг.md", body(&page), 7).await,
        vec![None]
    );
    assert_eq!(
        bases(&stand, "Онбординг.md", "Текст без конфликта.\n", 7).await,
        Vec::<Option<String>>::new()
    );
}

#[test]
fn the_longest_marker_run_counts_only_runs_that_open_a_line() {
    assert_eq!(longest_marker_run(b"text\n=====\n>> a\nx<<<<<<<<<<\n"), 5);
    assert_eq!(longest_marker_run(b"plain\n"), 0);
}
