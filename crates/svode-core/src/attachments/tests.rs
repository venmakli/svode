use std::fs;
use std::path::Path;

use crate::git::cli::GitCli;
use crate::git::state::GitRepositoryState;
use crate::index::state::IndexRuntimeState;
use crate::page::test_support::update_state;
use crate::storage::policy::ManagedBinaryRoute;

use super::{
    ImportRuntime, MutationOrigin, execute_managed_import, inspect_import_source,
    plan_managed_import,
};

fn write_space_config(path: &Path, assets: Option<&str>) {
    fs::create_dir_all(path.join(".svode")).expect("svode dir");
    let assets = assets
        .map(|assets| format!(",\n  \"assets\": {assets}"))
        .unwrap_or_default();
    fs::write(
        path.join(".svode").join("config.json"),
        format!("{{\n  \"name\": \"Project\",\n  \"description\": \"\",\n  \"icon\": \"folder\"{assets}\n}}"),
    )
    .expect("config");
}

fn runtime<'a>(
    index: &'a IndexRuntimeState,
    repository: &'a GitRepositoryState,
) -> ImportRuntime<'a> {
    ImportRuntime {
        index,
        updates: update_state(),
        repository,
        cli: None,
        commits: None,
        lfs: None,
    }
}

#[test]
fn source_validation_rejects_symlinks_and_directories() {
    let temp = tempfile::tempdir().unwrap();
    assert!(inspect_import_source(temp.path().to_string_lossy().as_ref()).is_err());

    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();
    let info = inspect_import_source(source.to_string_lossy().as_ref()).unwrap();
    assert_eq!(info.size_bytes, 5);
    assert_eq!(info.mime, "image/png");

    #[cfg(unix)]
    {
        let link = temp.path().join("photo-link.png");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(inspect_import_source(link.to_string_lossy().as_ref()).is_err());
    }
}

#[tokio::test]
async fn leaf_plan_names_the_canonical_handoff_and_structural_paths() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(&project, None);
    fs::write(project.join("note.md"), "---\ntitle: Note\n---\n").unwrap();
    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();

    let index = IndexRuntimeState::default();
    let plan = plan_managed_import(&index, &project, None, "note.md", &source, None)
        .await
        .unwrap();

    let project_path = fs::canonicalize(&project).unwrap();
    assert_eq!(plan.canonical_content_path, "note/README.md");
    assert!(
        plan.affected_paths()
            .contains(&project_path.join("note.md"))
    );
    assert!(
        plan.affected_paths()
            .contains(&project_path.join("note/README.md"))
    );
    assert!(
        plan.affected_paths()
            .contains(&project_path.join(".svode/order.json"))
    );
}

#[tokio::test]
async fn managed_import_publishes_the_attachment_without_a_desktop_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(&project, Some(r#"{ "strategy": "in-git" }"#));
    fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();

    let index = IndexRuntimeState::default();
    let repository = GitRepositoryState::new();
    let cli = GitCli::detect().ok();
    let mut import = runtime(&index, &repository);
    import.cli = cli.as_ref();
    let plan = plan_managed_import(&index, &project, None, "README.md", &source, None)
        .await
        .unwrap();
    let result = execute_managed_import(import, MutationOrigin::Mcp, plan)
        .await
        .unwrap();

    assert_eq!(result.content_path, "README.md");
    assert_eq!(result.attachment_path, "photo.png");
    assert_eq!(result.markdown_url, "photo.png");
    assert_eq!(result.cover_path, "photo.png");
    assert!(project.join("photo.png").is_file());
    assert_eq!(result.delivery.owner_paths, vec![".".to_string()]);
    assert!(!result.delivery.converted_page);
    assert!(
        !fs::read_dir(&project)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".svode-import-"))
    );
}

#[tokio::test]
async fn managed_import_plan_uses_threshold_and_protects_svg_from_lfs() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(
        &project,
        Some(
            r#"{ "strategy": "lfs-remote", "binaryRouting": { "version": 1, "lfsExtensions": ["psd"], "lfsThresholdBytes": 4 } }"#,
        ),
    );
    fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
    let archive = temp.path().join("archive.pdf");
    fs::write(&archive, b"large").unwrap();
    let svg = temp.path().join("diagram.svg");
    fs::write(&svg, b"<svg/>").unwrap();

    let index = IndexRuntimeState::default();
    let threshold = plan_managed_import(&index, &project, None, "README.md", &archive, None)
        .await
        .unwrap();
    let protected = plan_managed_import(&index, &project, None, "README.md", &svg, None)
        .await
        .unwrap();

    assert_eq!(threshold.binary_route, ManagedBinaryRoute::LfsThreshold);
    assert_eq!(protected.binary_route, ManagedBinaryRoute::DirectGit);
}

#[tokio::test]
async fn lfs_required_import_fails_without_readiness_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(
        &project,
        Some(
            r#"{ "strategy": "lfs-remote", "binaryRouting": { "version": 1, "lfsExtensions": ["png"] } }"#,
        ),
    );
    fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();

    let index = IndexRuntimeState::default();
    let repository = GitRepositoryState::new();
    let plan = plan_managed_import(&index, &project, None, "README.md", &source, None)
        .await
        .unwrap();
    assert_eq!(plan.binary_route, ManagedBinaryRoute::LfsExtension);

    let error = execute_managed_import(runtime(&index, &repository), MutationOrigin::Mcp, plan)
        .await
        .expect_err("an LFS route without readiness evidence must fail closed");

    assert!(error.to_string().contains("Git LFS route is not ready"));
    assert!(!project.join("photo.png").exists());
}

#[tokio::test]
async fn managed_import_plan_rejects_unknown_binary_routing_version() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(
        &project,
        Some(
            r#"{ "strategy": "lfs-remote", "binaryRouting": { "version": 2, "lfsExtensions": ["png"] } }"#,
        ),
    );
    fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();

    let index = IndexRuntimeState::default();
    let error = plan_managed_import(&index, &project, None, "README.md", &source, None)
        .await
        .expect_err("unknown routing must fail closed");

    assert!(error.to_string().contains("version 2 is not supported"));
}

#[tokio::test]
async fn managed_import_plan_rejects_unknown_storage_strategy_before_writing() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(&project, Some(r#"{ "strategy": "lfs-future" }"#));
    fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();

    let index = IndexRuntimeState::default();
    let error = plan_managed_import(&index, &project, None, "README.md", &source, None)
        .await
        .expect_err("unknown strategy must fail closed");

    assert!(
        error
            .to_string()
            .contains("`lfs-future` was set by a newer Svode version"),
        "{error}"
    );
    assert!(!project.join("photo.png").exists());
    assert!(!project.join(".gitattributes").exists());
    assert!(!project.join(".gitignore").exists());
}

#[tokio::test]
async fn unsupported_attachment_format_is_rejected_before_staging() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_space_config(&project, None);
    fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
    let source = temp.path().join("notes.bin");
    fs::write(&source, b"binary").unwrap();

    let index = IndexRuntimeState::default();
    let error = plan_managed_import(&index, &project, None, "README.md", &source, None)
        .await
        .expect_err("unsupported formats must be rejected");

    assert!(
        error
            .to_string()
            .contains("unsupported attachment format: notes.bin")
    );
}

#[test]
fn staged_publish_is_complete_and_allocates_collision() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.png");
    let owner = temp.path().join("owner");
    fs::create_dir(&owner).unwrap();
    fs::write(&source, b"complete-image").unwrap();
    fs::write(owner.join("photo.png"), b"existing").unwrap();

    let staged = super::staged_copy(&source, temp.path()).unwrap();
    let (published, name) = super::publish_staged_copy(&staged, &owner, "photo.png").unwrap();

    assert_eq!(name, "photo-1.png");
    assert_eq!(fs::read(published).unwrap(), b"complete-image");
    assert!(!staged.exists());
}

#[test]
fn canonical_leaf_handoff_keeps_parent_and_readme_shape() {
    assert_eq!(
        super::nested_content_path("note.md").unwrap(),
        "note/README.md"
    );
    assert_eq!(
        super::nested_content_path("docs/note.md").unwrap(),
        "docs/note/README.md"
    );
}

#[test]
fn requested_name_is_reprojected_from_a_basename() {
    assert_eq!(
        super::normalize_requested_file_name("../../Quarterly Report.PDF").unwrap(),
        "Quarterly Report.PDF"
    );
    assert!(super::normalize_requested_file_name("..").is_err());
    assert!(super::normalize_requested_file_name("/").is_err());
}

/// Records how many structural history registrations reached it.
#[derive(Default)]
struct CountingSink(std::sync::Mutex<usize>);

impl crate::structure::StructuralCommitSink for CountingSink {
    fn schedule(
        &self,
        _: &Path,
        _: &Path,
        _: crate::git::pending::StructuralChange,
        _: Vec<std::path::PathBuf>,
    ) {
        *self.0.lock().unwrap() += 1;
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
        _: Vec<std::path::PathBuf>,
        _: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        *self.0.lock().unwrap() += 1;
        Box::pin(async {})
    }
}

/// In-git Project whose leaf item `Area/Tasks/Item.md` is the relation target
/// of `Decisions/Decision.md` and the link target of `Link.md`.
fn leaf_import_project(project: &Path) {
    crate::page::test_support::scaffold_space(project, "Project");
    write_space_config(project, Some(r#"{ "strategy": "in-git" }"#));
    for (path, contents) in [
        (
            "Area/Tasks/schema.yaml",
            "nested_items: true\ncolumns: []\n",
        ),
        ("Area/Tasks/README.md", "---\ntitle: Tasks\n---\n"),
        (
            "Area/Tasks/Item.md",
            "---\ntitle: Item\n---\nSee [Decision](../../Decisions/Decision.md).\n",
        ),
        (
            "Decisions/schema.yaml",
            "columns:\n  - name: Task\n    type: relation\n    relation: Area/Tasks\n",
        ),
        ("Decisions/README.md", "---\ntitle: Decisions\n---\n"),
        (
            "Decisions/Decision.md",
            "---\ntitle: Decision\nTask: [Item.md]\n---\n",
        ),
        ("Link.md", "See [Item](Area/Tasks/Item.md).\n"),
        (
            ".svode/order.json",
            r#"{".":["Area","Decisions","Link.md"],"Area/Tasks":["Item.md"]}"#,
        ),
    ] {
        let path = project.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
}

/// Files and directories of the tree with their bytes, without the
/// device-local state the index repair and the name lock write.
fn project_sources(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            if path.is_dir() {
                files.push((rel, Vec::new()));
                dirs.push(path);
            } else if !rel.strip_prefix(".svode/").is_some_and(|name| {
                name == "local.json"
                    || name == "write.lock"
                    || name.starts_with("variables.")
                    || name.contains(".db")
            }) {
                files.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

#[tokio::test]
async fn a_failed_step_of_an_import_into_a_leaf_restores_the_sources_and_the_projection() {
    let cli = GitCli::detect().ok();
    // (injected stage, Git available): without Git the route itself fails.
    for (stage, git) in [
        (Some("import_convert"), true),
        (Some("import_publish"), true),
        (None, false),
        (Some("import_route"), true),
    ] {
        let label = format!("{stage:?}, git {git}");
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        leaf_import_project(&project);
        let project = fs::canonicalize(&project).unwrap();
        let source = temp.path().join("photo.png");
        fs::write(&source, b"image").unwrap();
        let index = IndexRuntimeState::default();
        index
            .backlinks_for_space_dir(&project)
            .await
            .build(&project)
            .unwrap();
        let repository = GitRepositoryState::new();
        let sink = CountingSink::default();
        let import = ImportRuntime {
            cli: if git { cli.as_ref() } else { None },
            commits: Some(&sink),
            ..runtime(&index, &repository)
        };
        let plan = plan_managed_import(&index, &project, None, "Area/Tasks/Item.md", &source, None)
            .await
            .unwrap();
        assert!(plan.requires_conversion, "{label}");
        let before = project_sources(&project);

        crate::page::write::inject_failure(stage, None);
        let error = execute_managed_import(import, MutationOrigin::Desktop, plan)
            .await
            .expect_err(&label);
        crate::page::write::inject_failure(None, None);

        if let Some(stage) = stage {
            assert!(
                error
                    .to_string()
                    .contains(&format!("injected {stage} failure")),
                "{label}: {error}"
            );
        } else {
            assert!(
                !matches!(error, crate::page::PageError::Recovery { .. }),
                "{label}: {error}"
            );
        }
        assert_eq!(project_sources(&project), before, "{label}");
        assert_eq!(*sink.0.lock().unwrap(), 0, "{label}");
        let backlinks = index.backlinks_for_space_dir(&project).await;
        assert!(
            backlinks
                .get_backlinks("Area/Tasks/Item.md")
                .iter()
                .any(|link| link.source_path == "Link.md"),
            "{label}"
        );
        assert!(
            backlinks
                .get_backlinks("Area/Tasks/Item/README.md")
                .is_empty(),
            "{label}"
        );
        let pool = index
            .get_or_create(&crate::index::IndexKey::Root(project.clone()))
            .await
            .unwrap();
        let indexed =
            sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(
            indexed.contains(&"Area/Tasks/Item.md".to_string()),
            "{label}: {indexed:?}"
        );
        assert!(
            !indexed
                .iter()
                .any(|path| path.starts_with("Area/Tasks/Item/")),
            "{label}: {indexed:?}"
        );
    }
}

#[tokio::test]
async fn an_import_into_a_leaf_registers_its_history_once_it_succeeds() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    leaf_import_project(&project);
    let source = temp.path().join("photo.png");
    fs::write(&source, b"image").unwrap();
    let index = IndexRuntimeState::default();
    let repository = GitRepositoryState::new();
    let cli = GitCli::detect().ok();
    let sink = CountingSink::default();
    let import = ImportRuntime {
        cli: cli.as_ref(),
        commits: Some(&sink),
        ..runtime(&index, &repository)
    };
    let plan = plan_managed_import(&index, &project, None, "Area/Tasks/Item.md", &source, None)
        .await
        .unwrap();

    let result = execute_managed_import(import, MutationOrigin::Desktop, plan)
        .await
        .unwrap();

    assert_eq!(result.content_path, "Area/Tasks/Item/README.md");
    assert!(project.join("Area/Tasks/Item/photo.png").is_file());
    assert!(!project.join("Area/Tasks/Item.md").exists());
    assert!(*sink.0.lock().unwrap() > 0);
}
