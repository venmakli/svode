//! Page and Collection create under a leaf Page parent: the parent becomes a
//! folder Page by the conversion step of a move under a leaf, with all its
//! effects in every Space, as one operation with one rollback.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tempfile::TempDir;

use crate::git::pending::StructuralChange;
use crate::index::state::IndexRuntimeState;
use crate::page::PageError;
use crate::page::create::{PageCreate, PageCreateOutcome};
use crate::page::dates::SystemGitDateExecutor;
use crate::page::test_support::{scaffold_space, update_state};

use super::{CollectionCreate, StructuralCommitSink, StructureRuntime};

/// One history registration: Space, whether it went through `commit_now`,
/// the operation label, whether it owns a relocation or a created entity,
/// and its paths.
#[derive(Debug, Clone)]
struct Registration {
    space: PathBuf,
    content: bool,
    op: String,
    relocates: bool,
    creates: bool,
    paths: Vec<PathBuf>,
}

#[derive(Default)]
struct HistorySink(Mutex<Vec<Registration>>);

impl HistorySink {
    fn take(&self) -> Vec<Registration> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl StructuralCommitSink for HistorySink {
    fn schedule(&self, _: &Path, space: &Path, change: StructuralChange, paths: Vec<PathBuf>) {
        self.0.lock().unwrap().push(Registration {
            space: space.to_path_buf(),
            content: false,
            op: format!("{:?}", change.op),
            relocates: change.relocation().is_some(),
            creates: change.created().is_some(),
            paths,
        });
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        space: &'a Path,
        paths: Vec<PathBuf>,
        message: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        self.0.lock().unwrap().push(Registration {
            space: space.to_path_buf(),
            content: true,
            op: message,
            relocates: false,
            creates: false,
            paths,
        });
        Box::pin(async {})
    }
}

fn runtime<'a>(
    index: &'a IndexRuntimeState,
    sink: Option<&'a HistorySink>,
) -> StructureRuntime<'a, SystemGitDateExecutor> {
    StructureRuntime {
        index,
        updates: update_state(),
        git_dates: None,
        commits: sink.map(|sink| sink as &dyn StructuralCommitSink),
    }
}

fn write_tree(root: &Path, files: &[(&str, &str)]) {
    for (path, content) in files {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

/// Source files and directories of the tree with their bytes, without Git
/// and the device-local state the index and the write guard keep.
fn sources(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let local = name == ".git"
                || name == "local.json"
                || name == "write.lock"
                || name.starts_with("variables.")
                || name.contains(".db");
            if local {
                continue;
            }
            if path.is_dir() {
                files.push((rel, String::new()));
                dirs.push(path);
            } else {
                files.push((rel, fs::read_to_string(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

/// Project with the root Space and the child Spaces `dela` and `atlas`, as
/// in the dogfood report. `dela/Ideas/X.md` links into `atlas` inline and by
/// a reference definition; `dela/Ideas/Y.md` links `X.md`; `dela/Same.md` and
/// `atlas/Cross.md` link `X.md`. The order of `Ideas` is `A, X, B, Y`.
fn two_space_project(root: &Path) {
    scaffold_space(root, "Root");
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Root","spaces":[{"id":"dela","path":"dela"},{"id":"atlas","path":"atlas"}]}"#,
    )
    .unwrap();
    scaffold_space(&root.join("dela"), "dela");
    scaffold_space(&root.join("atlas"), "atlas");
    for repository in [root.to_path_buf(), root.join("dela"), root.join("atlas")] {
        fs::create_dir_all(repository.join(".git")).unwrap();
    }
    write_tree(
        root,
        &[
            (
                "dela/Ideas/X.md",
                "---\ntitle: X\n---\nSee [Note](../../atlas/Note.md) and [Ref][note].\n\n[note]: ../../atlas/Note.md\n",
            ),
            ("dela/Ideas/Y.md", "---\ntitle: Y\n---\nSee [X](X.md).\n"),
            ("dela/Ideas/A.md", "---\ntitle: A\n---\n"),
            ("dela/Ideas/B.md", "---\ntitle: B\n---\n"),
            ("dela/Same.md", "---\ntitle: Same\n---\n[X](Ideas/X.md)\n"),
            (
                "dela/.svode/order.json",
                r#"{".":["Ideas","Same.md"],"Ideas":["A.md","X.md","B.md","Y.md"]}"#,
            ),
            ("atlas/Note.md", "---\ntitle: Note\n---\n"),
            (
                "atlas/Cross.md",
                "---\ntitle: Cross\n---\n[X](../dela/Ideas/X.md)\n",
            ),
        ],
    );
}

/// Index state of an open Project with its Spaces ready, as a host opens it.
async fn project_state(root: &Path) -> IndexRuntimeState {
    let state = IndexRuntimeState::default();
    for id in ["dela", "atlas"] {
        state
            .upsert_space(
                root,
                id,
                id,
                crate::index::resolver::SpaceStatus::Ready,
                None,
            )
            .await;
    }
    state
}

fn page_request(space: &Path, parent: &str, project: Option<&Path>) -> PageCreate {
    PageCreate {
        space: space.to_string_lossy().into_owned(),
        parent_path: Some(parent.to_string()),
        title: "Child".into(),
        body: Some("Child body".into()),
        icon: None,
        description: None,
        cover: None,
        properties: None,
        contextual_defaults: false,
        allocate_unique_title: false,
        as_readme: false,
        project: project.map(|project| project.to_string_lossy().into_owned()),
        publish_projection: true,
    }
}

async fn create_page(
    request: PageCreate,
    state: &IndexRuntimeState,
    sink: Option<&HistorySink>,
) -> Result<PageCreateOutcome, PageError> {
    super::create_page(request, runtime(state, sink), |paths| async move {
        Ok::<_, PageError>(paths)
    })
    .await
}

fn order(space: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(space.join(".svode/order.json")).unwrap()).unwrap()
}

#[tokio::test]
async fn a_create_under_a_leaf_converts_it_with_the_effects_of_a_conversion_in_every_space() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    two_space_project(&root);
    let dela = root.join("dela");
    let state = project_state(&root).await;

    let outcome = create_page(page_request(&dela, "Ideas/X.md", Some(&root)), &state, None)
        .await
        .unwrap();

    assert_eq!(outcome.page.path, "Ideas/X/Child.md");
    assert!(!dela.join("Ideas/X.md").exists());
    // The links of the Page itself, inline and the reference definition,
    // are rebased against the new folder.
    assert_eq!(
        fs::read_to_string(dela.join("Ideas/X/README.md")).unwrap(),
        "---\ntitle: X\n---\nSee [Note](../../../atlas/Note.md) and [Ref][note].\n\n[note]: ../../../atlas/Note.md\n"
    );
    // Links to the leaf in its own and in another Space follow it.
    assert_eq!(
        fs::read_to_string(dela.join("Same.md")).unwrap(),
        "---\ntitle: Same\n---\n[X](Ideas/X/README.md)\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("atlas/Cross.md")).unwrap(),
        "---\ntitle: Cross\n---\n[X](../dela/Ideas/X/README.md)\n"
    );
    // The order entry is renamed in place.
    assert_eq!(
        order(&dela)["Ideas"],
        serde_json::json!(["A.md", "X", "B.md", "Y.md"])
    );
    for changed in [
        root.join("atlas/Cross.md"),
        dela.join("Same.md"),
        dela.join("Ideas/X.md"),
        dela.join("Ideas/X/README.md"),
        dela.join("Ideas/X/Child.md"),
        dela.join(".svode/order.json"),
    ] {
        assert!(
            outcome.changed_paths.contains(&changed),
            "{} not in {:?}",
            changed.display(),
            outcome.changed_paths
        );
    }
    // The index of every touched Space follows the new paths.
    let space_id = state.space_id_for_dir(&dela).await;
    let plan = state
        .plan_links_on_rename_project(&root, space_id.as_deref(), "Ideas/X/README.md")
        .await
        .unwrap();
    assert!(
        plan.mutation_paths().contains(&root.join("atlas/Cross.md")),
        "{:?}",
        plan.mutation_paths()
    );

    // A link the conversion of a neighbor rewrote is rebased when the
    // neighbor's linking Page becomes a folder Page itself.
    assert_eq!(
        fs::read_to_string(dela.join("Ideas/Y.md")).unwrap(),
        "---\ntitle: Y\n---\nSee [X](X/README.md).\n"
    );
    create_page(page_request(&dela, "Ideas/Y.md", Some(&root)), &state, None)
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(dela.join("Ideas/Y/README.md")).unwrap(),
        "---\ntitle: Y\n---\nSee [X](../X/README.md).\n"
    );
    assert_eq!(
        order(&dela)["Ideas"],
        serde_json::json!(["A.md", "X", "B.md", "Y"])
    );
}

#[tokio::test]
async fn a_collection_create_under_a_leaf_converts_it_with_the_same_effects() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    two_space_project(&root);
    let dela = root.join("dela");
    let state = project_state(&root).await;
    let sink = HistorySink::default();

    let outcome = super::create_collection(
        CollectionCreate {
            space: dela.to_string_lossy().into_owned(),
            parent_path: Some("Ideas/X.md".into()),
            title: "Board".into(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            schema: crate::collections::engine::default_collection_schema(),
            allocate_unique_title: false,
            project: Some(root.to_string_lossy().into_owned()),
        },
        runtime(&state, Some(&sink)),
        |paths| async move { Ok::<_, PageError>(paths) },
    )
    .await
    .unwrap();

    assert_eq!(outcome.collection_path, "Ideas/X/Board");
    assert_eq!(
        fs::read_to_string(dela.join("Ideas/X/README.md")).unwrap(),
        "---\ntitle: X\n---\nSee [Note](../../../atlas/Note.md) and [Ref][note].\n\n[note]: ../../../atlas/Note.md\n"
    );
    assert_eq!(
        fs::read_to_string(dela.join("Same.md")).unwrap(),
        "---\ntitle: Same\n---\n[X](Ideas/X/README.md)\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("atlas/Cross.md")).unwrap(),
        "---\ntitle: Cross\n---\n[X](../dela/Ideas/X/README.md)\n"
    );
    assert_eq!(
        order(&dela)["Ideas"],
        serde_json::json!(["A.md", "X", "B.md", "Y.md"])
    );
    assert!(outcome.changed_paths.contains(&root.join("atlas/Cross.md")));
    let history = sink.take();
    assert!(
        history
            .iter()
            .any(|entry| entry.space == dela && entry.op.starts_with("ConvertToFolder")),
        "{history:?}"
    );
    assert!(
        history
            .iter()
            .any(|entry| entry.space == dela && entry.op.starts_with("Create") && entry.creates),
        "{history:?}"
    );
    assert!(
        history.iter().any(|entry| entry.space == root.join("atlas")
            && entry.paths.contains(&root.join("atlas/Cross.md"))
            && !entry.creates
            && !entry.relocates),
        "{history:?}"
    );
}

#[tokio::test]
async fn a_create_under_a_leaf_without_a_project_has_the_effects_of_a_conversion_without_one() {
    // The conversion alone on a twin of the fixture.
    let twin = TempDir::new().unwrap();
    let twin_root = twin.path().canonicalize().unwrap();
    two_space_project(&twin_root);
    let twin_state = IndexRuntimeState::default();
    super::convert_to_folder(
        twin_root.join("dela").to_str().unwrap(),
        "Ideas/X.md",
        None,
        runtime(&twin_state, None),
    )
    .await
    .unwrap();

    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    two_space_project(&root);
    let dela = root.join("dela");
    let state = IndexRuntimeState::default();
    let outcome = create_page(page_request(&dela, "Ideas/X.md", None), &state, None)
        .await
        .unwrap();

    assert_eq!(outcome.page.path, "Ideas/X/Child.md");
    // Every source but the created Page and its order key is as the
    // conversion without a Project leaves it.
    fs::remove_file(dela.join("Ideas/X/Child.md")).unwrap();
    let mut order = order(&dela);
    order.as_object_mut().unwrap().remove("Ideas/X");
    fs::write(
        dela.join(".svode/order.json"),
        serde_json::to_string(&order).unwrap(),
    )
    .unwrap();
    let twin_order = self::order(&twin_root.join("dela"));
    fs::write(
        twin_root.join("dela/.svode/order.json"),
        serde_json::to_string(&twin_order).unwrap(),
    )
    .unwrap();
    assert_eq!(sources(&root), sources(&twin_root));
    assert_eq!(
        fs::read_to_string(dela.join("Same.md")).unwrap(),
        "---\ntitle: Same\n---\n[X](Ideas/X/README.md)\n"
    );
    assert_eq!(
        twin_order["Ideas"],
        serde_json::json!(["A.md", "X", "B.md", "Y.md"])
    );
}

#[tokio::test]
async fn a_failed_step_after_the_conversion_restores_both_spaces_and_allows_a_retry() {
    // (checkpoint of a Page create step, Page create stage or write stage)
    for (stage, create_stage) in [
        ("create_parent_folder", false),
        ("create", true),
        ("properties", true),
        ("body", true),
    ] {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        two_space_project(&root);
        let dela = root.join("dela");
        let state = project_state(&root).await;
        let sink = HistorySink::default();
        let before = sources(&root);

        if create_stage {
            crate::page::create::inject_failure(Some(stage));
        } else {
            crate::page::write::inject_failure(Some(stage), None);
        }
        let error = create_page(
            page_request(&dela, "Ideas/X.md", Some(&root)),
            &state,
            Some(&sink),
        )
        .await
        .err()
        .unwrap();
        crate::page::create::inject_failure(None);
        crate::page::write::inject_failure(None, None);

        assert!(
            matches!(&error, PageError::General(cause) if cause.contains(&format!("injected {stage} failure"))),
            "{stage}: {error:?}"
        );
        assert_eq!(sources(&root), before, "{stage}");
        assert!(dela.join("Ideas/X.md").is_file(), "{stage}");
        assert!(!dela.join("Ideas/X").exists(), "{stage}");
        assert!(sink.take().is_empty(), "{stage}");

        let retried = create_page(
            page_request(&dela, "Ideas/X.md", Some(&root)),
            &state,
            Some(&sink),
        )
        .await
        .unwrap();
        assert_eq!(retried.page.path, "Ideas/X/Child.md", "{stage}");
    }
}

#[tokio::test]
async fn a_refused_repository_of_another_space_refuses_the_create_before_any_write() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    two_space_project(&root);
    let dela = root.join("dela");
    let atlas = root.join("atlas");
    let state = project_state(&root).await;
    let before = sources(&root);

    let refused = atlas.clone();
    let error = super::create_page(
        page_request(&dela, "Ideas/X.md", Some(&root)),
        runtime(&state, None),
        |paths| async move {
            if paths.iter().any(|path| path.starts_with(&refused)) {
                Err(PageError::General("atlas is read-only".into()))
            } else {
                Ok(paths)
            }
        },
    )
    .await
    .err()
    .unwrap();

    assert!(
        matches!(&error, PageError::General(cause) if cause == "atlas is read-only"),
        "{error:?}"
    );
    assert_eq!(sources(&root), before);
}

#[tokio::test]
async fn history_of_a_create_under_a_leaf_is_its_conversion_its_creation_and_companions() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    two_space_project(&root);
    let dela = root.join("dela");
    let atlas = root.join("atlas");
    let state = project_state(&root).await;
    let sink = HistorySink::default();

    create_page(
        page_request(&dela, "Ideas/X.md", Some(&root)),
        &state,
        Some(&sink),
    )
    .await
    .unwrap();

    let history = sink.take();
    let conversion = history
        .iter()
        .find(|entry| entry.op.starts_with("ConvertToFolder") && entry.relocates)
        .unwrap_or_else(|| panic!("no conversion in {history:?}"));
    assert_eq!(conversion.space, dela);
    assert!(conversion.relocates);
    let creation = history
        .iter()
        .find(|entry| entry.op.starts_with("Create") && entry.creates)
        .unwrap_or_else(|| panic!("no creation in {history:?}"));
    assert_eq!(creation.space, dela);
    assert!(creation.creates && !creation.content);
    for path in [
        dela.join("Ideas/X/Child.md"),
        dela.join(".svode/order.json"),
    ] {
        assert!(creation.paths.contains(&path), "{history:?}");
    }
    assert!(
        history.iter().any(|entry| entry.space == atlas
            && entry.paths.contains(&atlas.join("Cross.md"))
            && !entry.relocates
            && !entry.creates),
        "{history:?}"
    );
    assert!(
        history
            .iter()
            .all(|entry| entry.space == dela || entry.space == atlas),
        "{history:?}"
    );
}

#[tokio::test]
async fn a_create_in_a_directory_registers_only_its_creation() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    two_space_project(&root);
    let dela = root.join("dela");
    let state = project_state(&root).await;
    let sink = HistorySink::default();

    let outcome = create_page(
        page_request(&dela, "Ideas", Some(&root)),
        &state,
        Some(&sink),
    )
    .await
    .unwrap();

    assert_eq!(outcome.page.path, "Ideas/Child.md");
    let history = sink.take();
    assert_eq!(history.len(), 1, "{history:?}");
    assert!(history[0].op.starts_with("Create") && history[0].creates);
    assert_eq!(history[0].space, dela);
    assert!(history[0].paths.contains(&dela.join("Ideas/Child.md")));
    assert!(history[0].paths.contains(&dela.join(".svode/order.json")));
}

#[tokio::test]
async fn a_leaf_parent_is_converted_in_the_same_action_and_a_failure_restores_it() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    scaffold_space(&root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    let original = "---\ntitle: Parent\n---\nParent body";
    fs::write(root.join("Parent.md"), original).unwrap();
    let state = IndexRuntimeState::default();

    let outcome = create_page(page_request(&root, "Parent.md", None), &state, None)
        .await
        .unwrap();
    assert_eq!(outcome.page.path, "Parent/Child.md");
    assert!(!root.join("Parent.md").exists());
    assert_eq!(
        fs::read_to_string(root.join("Parent/README.md")).unwrap(),
        original
    );
}

#[tokio::test]
async fn an_unrestorable_leaf_fails_the_create_with_only_its_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    scaffold_space(&root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    let leaf = root.join("Parent.md");
    fs::write(&leaf, "---\ntitle: Parent\n---\nParent body").unwrap();
    let state = IndexRuntimeState::default();
    let occupied = leaf.clone();
    crate::page::write::inject_effect("body", Box::new(move || fs::create_dir(&occupied).unwrap()));
    crate::page::create::inject_failure(Some("body"));
    // An icon makes the initial metadata write reach its checkpoint.
    let mut request = page_request(&root, "Parent.md", None);
    request.icon = Some(Some("wallet".into()));
    let result = create_page(request, &state, None).await;
    crate::page::create::inject_failure(None);

    match result.err() {
        Some(PageError::Recovery { cause, paths }) => {
            assert!(cause.contains("injected body failure"), "{cause}");
            assert_eq!(paths, vec![leaf.display().to_string()]);
        }
        other => panic!("expected recovery, got {other:?}"),
    }
    assert!(!root.join("Parent").exists());
}

#[tokio::test]
async fn page_create_alone_refuses_a_leaf_parent_without_a_write() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    scaffold_space(&root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join("Parent.md"), "---\ntitle: Parent\n---\n").unwrap();
    let before = sources(&root);

    let result = crate::page::create::create(
        page_request(&root, "Parent.md", None),
        &IndexRuntimeState::default(),
        update_state(),
        None::<&SystemGitDateExecutor>,
        |paths| async move { Ok::<_, PageError>(paths) },
    )
    .await;

    assert!(result.is_err());
    assert_eq!(sources(&root), before);
}

#[tokio::test]
async fn template_create_reverts_an_installed_tree_when_a_nested_relation_is_malformed() {
    use crate::page::templates::TemplateSelection;

    let tmp = TempDir::new().unwrap();
    let space = tmp.path().canonicalize().unwrap();
    scaffold_space(&space, "Project");
    assert!(
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&space)
            .status()
            .unwrap()
            .success()
    );
    write_tree(
        &space,
        &[
            (
                "tasks/schema.yaml",
                "nested_items: true\ncolumns:\n  - { name: Key, type: unique_id, next: 5 }\n  - { name: Link, type: relation, relation: tasks, limit: one }\nviews: []\n",
            ),
            (
                "tasks/.templates/folder/README.md",
                "---\ntitle: Folder\n---\nTemplate head\n",
            ),
            (
                "tasks/.templates/folder/child/README.md",
                "---\ntitle: Child\nLink: 42\n---\n",
            ),
            (".svode/order.json", r#"{"tasks":[]}"#),
        ],
    );
    let expected = sources(&space);
    let state = IndexRuntimeState::default();
    let mut requested = page_request(&space, "tasks", None);
    requested.publish_projection = false;
    let failed = super::create_page_with_template(
        requested,
        TemplateSelection::Specific("folder".into()),
        runtime(&state, None),
        |paths| {
            assert!(paths.contains(&space.join("tasks/Child/child/README.md")));
            assert!(paths.contains(&space.join("tasks/schema.yaml")));
            assert!(paths.contains(&space.join(".svode/order.json")));
            async move { Ok::<_, PageError>(paths) }
        },
    )
    .await;
    assert!(failed.is_err());
    assert_eq!(sources(&space), expected);

    write_tree(
        &space,
        &[(
            "tasks/.templates/folder/child/README.md",
            "---\ntitle: Child\n---\n",
        )],
    );
    let mut requested = page_request(&space, "tasks", None);
    requested.publish_projection = false;
    let recovered = super::create_page_with_template(
        requested,
        TemplateSelection::Specific("folder".into()),
        runtime(&state, None),
        |paths| async move { Ok::<_, PageError>(paths) },
    )
    .await
    .unwrap();
    assert_eq!(recovered.page.meta.extra["Key"].as_u64(), Some(5));
    assert_eq!(order(&space)["tasks"], serde_json::json!(["Child"]));
}
