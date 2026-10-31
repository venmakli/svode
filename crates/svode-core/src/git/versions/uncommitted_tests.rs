//! The uncommitted groups «Зафиксировать с агентом» hands to an agent
//! (Stage 11 1.G «Пересказ смысла»): the groups of the area only, with
//! their facts and repository paths, nothing staged, and a sensitive
//! Collection without names and values.

use std::path::Path;

use super::{GroupKind, HiddenFiles, MessageLanguage, uncommitted};
use crate::git::staging_tests::{cli, git, repo, write};
use crate::git::state::GitRuntime;

fn page(title: &str, fields: &str, body: &str) -> String {
    format!("---\ntitle: {title}\n{fields}---\n{body}")
}

async fn commit_all(root: &Path) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    git(&cli, root, &["commit", "-q", "-m", "Baseline"]).await;
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|path| path.to_string()).collect()
}

#[tokio::test]
async fn the_groups_of_the_area_carry_their_facts_and_paths_and_nothing_is_staged() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(
        root,
        "Onboarding.md",
        &page("Onboarding", "", "# Prices\nOld\n"),
    );
    write(root, "Other.md", &page("Other", "", "Text\n"));
    write(root, ".svode/config.json", "{\"name\":\"Root\"}\n");
    commit_all(root).await;
    write(
        root,
        "Onboarding.md",
        &page("Onboarding", "", "# Prices\nNew\n"),
    );
    write(root, "Other.md", &page("Other", "", "Changed\n"));
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    let runtime = GitRuntime::with_cli(cli.clone());

    let found = uncommitted(
        &runtime,
        root,
        &paths(&["Onboarding.md", ".svode/config.json"]),
        MessageLanguage::En,
    )
    .await
    .expect("uncommitted");

    assert_eq!(found.repository, root);
    assert_eq!(found.groups.len(), 2, "{:#?}", found.groups);
    let content = found
        .groups
        .iter()
        .find(|group| group.kind == GroupKind::Page)
        .expect("page group");
    assert_eq!(content.paths, ["Onboarding.md"]);
    assert!(content.header.contains("Onboarding"), "{}", content.header);
    assert!(content.header.contains("Prices"), "{}", content.header);
    let system = found
        .groups
        .iter()
        .find(|group| group.kind == GroupKind::System)
        .expect("system group");
    assert_eq!(system.paths, [".svode/config.json"]);
    assert!(
        found
            .groups
            .iter()
            .all(|group| !group.paths.iter().any(|path| path == "Other.md"))
    );
    assert_eq!(
        git(&cli, root, &["diff", "--cached", "--name-only"]).await,
        ""
    );

    let ru = uncommitted(
        &runtime,
        root,
        &paths(&["Onboarding.md"]),
        MessageLanguage::Ru,
    )
    .await
    .expect("uncommitted");
    assert!(
        ru.groups[0].header.contains("правка"),
        "{}",
        ru.groups[0].header
    );
}

#[tokio::test]
async fn paths_of_an_inline_space_are_given_relative_to_its_repository() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "Team/Plan.md", &page("Plan", "", "Text\n"));
    commit_all(root).await;
    write(root, "Team/Plan.md", &page("Plan", "", "Changed\n"));
    write(root, "Team/New.md", &page("New", "", "Text\n"));

    let found = uncommitted(
        &GitRuntime::with_cli(cli),
        &root.join("Team"),
        &paths(&["Plan.md", "New.md"]),
        MessageLanguage::En,
    )
    .await
    .expect("uncommitted");

    assert_eq!(found.repository, root);
    let all = found
        .groups
        .iter()
        .flat_map(|group| group.paths.clone())
        .collect::<Vec<_>>();
    assert!(all.contains(&"Team/Plan.md".to_string()), "{all:?}");
    assert!(all.contains(&"Team/New.md".to_string()), "{all:?}");
    assert!(found.groups.len() >= 2, "a creation and an edit: {all:?}");
}

#[tokio::test]
async fn a_sensitive_collection_is_named_by_its_folder_without_names_or_values() {
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
    commit_all(root).await;
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

    for language in [MessageLanguage::En, MessageLanguage::Ru] {
        let found = uncommitted(
            &GitRuntime::with_cli(cli.clone()),
            root,
            &paths(&["Contacts/Ivan Petrov.md", "Contacts/Jane Roe.md"]),
            language,
        )
        .await
        .expect("uncommitted");
        assert!(!found.groups.is_empty());
        let text = serde_json::to_string(&found).expect("json");
        for secret in ["Ivan", "Petrov", "Jane", "Roe", "Phone", "555", "777", "+2"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        let hidden = found
            .groups
            .iter()
            .flat_map(|group| group.hidden.clone())
            .map(|hidden| hidden.files)
            .sum::<usize>();
        assert_eq!(hidden, 2);
        assert!(found.groups.iter().all(|group| group.paths.is_empty()));
        assert!(found.groups.iter().all(|group| {
            group
                .hidden
                .iter()
                .all(|HiddenFiles { folder, .. }| folder == "Contacts")
        }));
    }
}

#[tokio::test]
async fn an_area_without_changes_has_no_groups() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, "a.md", &page("A", "", "A\n"));
    commit_all(root).await;
    let runtime = GitRuntime::with_cli(cli);

    for area in [paths(&[]), paths(&["a.md"])] {
        let found = uncommitted(&runtime, root, &area, MessageLanguage::En)
            .await
            .expect("uncommitted");
        assert!(found.groups.is_empty(), "{:#?}", found.groups);
    }
}
