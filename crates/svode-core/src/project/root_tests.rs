//! Creation and opening of a Project (Stage 11 05 «Операции», «Git-эффекты
//! по типу» (проект), «Ошибки и stable codes», invariants 1–4 and 8): a new
//! folder, an existing folder, an existing repository, no Git, refusals
//! without side effects, rollback, and the registration in the list of the
//! device.

use std::path::{Path, PathBuf};

use super::ProjectError;
use super::registry::{self, LastView};
use super::root::{
    ProjectCreate, ProjectCreated, ProjectRepository, Registration, create, open_folder,
};
use super::scaffold::{self, README_FILE, Storage};
use super::space::CreationCommit;
use super::test_host::{Host, cli};
use crate::git::state::GitRuntime;
use crate::page::frontmatter;
use crate::space_config::{self, Unreadable};

fn git(repo: &Path, args: &[&str]) -> std::process::Output {
    std::process::Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .output()
        .expect("git")
}

fn stdout(output: std::process::Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn request(path: &Path, name: Option<&str>) -> ProjectCreate {
    ProjectCreate {
        path: path.to_path_buf(),
        name: name.map(str::to_string),
        icon: None,
        description: Some("About".to_string()),
    }
}

/// A temporary home with a device list directory.
struct Fixture {
    temp: tempfile::TempDir,
    runtime: GitRuntime,
    host: Host,
}

impl Fixture {
    fn new() -> Self {
        Self {
            temp: tempfile::tempdir().unwrap(),
            runtime: GitRuntime::with_cli(cli()),
            host: Host::default(),
        }
    }

    fn without_git() -> Self {
        Self {
            runtime: GitRuntime::without_cli(),
            ..Self::new()
        }
    }

    fn device(&self) -> PathBuf {
        self.temp.path().join("device")
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.temp.path().join(relative)
    }

    async fn create(
        &self,
        path: &Path,
        name: Option<&str>,
    ) -> Result<ProjectCreated, ProjectError> {
        let device = self.device();
        create(
            &self.runtime,
            &self.host,
            Some(&device),
            request(path, name),
        )
        .await
    }

    fn listed(&self) -> Vec<String> {
        registry::read(&self.device())
            .unwrap()
            .spaces
            .into_iter()
            .map(|entry| entry.path)
            .collect()
    }
}

fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files.push((path.clone(), Vec::new()));
                stack.push(path);
            } else {
                files.push((path.clone(), std::fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

fn assert_project_scaffold(path: &Path, name: &str) {
    let config = space_config::read(path).unwrap();
    assert_eq!(config.name, name);
    assert_eq!(config.description, "About");
    assert_eq!(config.icon, scaffold::DEFAULT_ICON);
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.join(".svode/config.json")).unwrap()).unwrap();
    assert_eq!(raw["assets"]["strategy"], "local");
    assert_eq!(
        raw["assets"]["binaryRouting"]["lfsThresholdBytes"],
        10_000_000
    );
    assert_eq!(
        raw["assets"]["binaryRouting"]["lfsExtensions"],
        serde_json::json!([])
    );
    assert!(path.join(".svode/local.json").is_file());
    let (meta, _) =
        frontmatter::parse(&std::fs::read_to_string(path.join(README_FILE)).unwrap()).unwrap();
    assert_eq!(meta.title, name);
}

fn registered_id(created: &ProjectCreated) -> &str {
    match &created.registration {
        Registration::Registered { id } => id,
        other => panic!("not registered: {other:?}"),
    }
}

fn commit_count(repo: &Path) -> usize {
    let out = git(repo, &["rev-list", "--all", "--count"]);
    if !out.status.success() {
        return 0;
    }
    stdout(out).parse().unwrap()
}

#[tokio::test]
async fn a_new_folder_gets_the_scaffold_a_repository_and_a_registration_without_a_commit() {
    let fixture = Fixture::new();
    let path = fixture.path("work/acme");

    let created = fixture.create(&path, Some("Acme")).await.unwrap();

    assert_project_scaffold(&path, "Acme");
    let ProjectRepository::Repository(repository) = &created.repository else {
        panic!("no repository: {:?}", created.repository);
    };
    assert!(repository.created);
    assert_eq!(repository.path, ".");
    assert!(!repository.upstream);
    assert_eq!(repository.commit, CreationCommit::Manual);
    let branch = stdout(git(&path, &["symbolic-ref", "--short", "HEAD"]));
    assert_eq!(repository.initial_branch.as_deref(), Some(branch.as_str()));
    assert_eq!(
        stdout(git(&path, &["rev-parse", "--show-object-format"])),
        "sha1"
    );
    assert_eq!(commit_count(&path), 0);
    assert!(path.join(".gitignore").is_file());
    let mut changed = created.changed_paths.clone();
    changed.sort();
    let mut expected = vec![
        path.join(".svode/config.json"),
        path.join(".svode/local.json"),
        path.join(README_FILE),
        path.join(".gitignore"),
    ];
    expected.sort();
    assert_eq!(changed, expected);
    assert!(!created.storage.inherited);
    assert!(created.storage.assets.is_some());
    assert_eq!(created.name, "Acme");
    let id = registered_id(&created);
    let entry = registry::find(&fixture.device(), id).unwrap().unwrap();
    assert_eq!(Path::new(&entry.path), path);
    // The policy of the new Project is the default, manual one.
    assert!(!crate::git::policy::effective_user_policy(&path).auto_commit_structural);
}

#[tokio::test]
async fn an_existing_folder_keeps_its_files_and_takes_the_folder_name() {
    let fixture = Fixture::new();
    let path = fixture.path("notes");
    std::fs::create_dir_all(path.join("docs")).unwrap();
    std::fs::write(path.join("docs/plan.md"), "plan").unwrap();
    std::fs::write(path.join(README_FILE), "my home").unwrap();
    std::fs::write(path.join(".gitignore"), "target/\n").unwrap();

    let created = fixture.create(&path, Some("  ")).await.unwrap();

    assert_eq!(created.name, "notes");
    assert_eq!(space_config::read(&path).unwrap().name, "notes");
    assert_eq!(
        std::fs::read_to_string(path.join(README_FILE)).unwrap(),
        "my home"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("docs/plan.md")).unwrap(),
        "plan"
    );
    assert!(
        std::fs::read_to_string(path.join(".gitignore"))
            .unwrap()
            .starts_with("target/\n")
    );
    assert!(!created.changed_paths.contains(&path.join(README_FILE)));
    assert!(matches!(
        created.repository,
        ProjectRepository::Repository(ref repository) if repository.created
    ));
    assert_eq!(commit_count(&path), 0);
    assert_eq!(fixture.listed().len(), 1);
}

#[tokio::test]
async fn an_existing_repository_is_prepared_without_git_init_or_commit() {
    let fixture = Fixture::new();
    let path = fixture.path("code");
    std::fs::create_dir(&path).unwrap();
    stdout(git(&path, &["init", "-q", "-b", "trunk"]));
    std::fs::write(path.join("main.rs"), "fn main() {}").unwrap();
    stdout(git(&path, &["add", "-A"]));
    stdout(git(&path, &["commit", "-qm", "Code"]));
    let head = stdout(git(&path, &["rev-parse", "HEAD"]));

    let created = fixture.create(&path, Some("Code")).await.unwrap();

    assert_project_scaffold(&path, "Code");
    assert_eq!(
        created.repository,
        ProjectRepository::Repository(super::space::RepositoryOutcome {
            path: ".".to_string(),
            created: false,
            initial_branch: None,
            upstream: false,
            commit: CreationCommit::Manual,
        })
    );
    assert_eq!(stdout(git(&path, &["rev-parse", "HEAD"])), head);
    assert_eq!(commit_count(&path), 1);
    assert_eq!(
        stdout(git(&path, &["symbolic-ref", "--short", "HEAD"])),
        "trunk"
    );
    // Local repair keeps the device-local files out of Git.
    let status = stdout(git(&path, &["status", "--porcelain", "-uall"]));
    assert!(!status.contains("local.json"), "{status}");
    assert!(status.contains(".svode/config.json"), "{status}");
    // The preparation wrote `.gitignore`, so the answer names it.
    assert!(path.join(".gitignore").is_file());
    let mut changed = created.changed_paths.clone();
    changed.sort();
    let mut expected = vec![
        path.join(".svode/config.json"),
        path.join(".svode/local.json"),
        path.join(README_FILE),
        path.join(".gitignore"),
    ];
    expected.sort();
    assert_eq!(changed, expected);
}

#[tokio::test]
async fn an_already_prepared_repository_leaves_gitignore_out_of_the_answer() {
    let fixture = Fixture::new();
    let path = fixture.path("code");
    std::fs::create_dir(&path).unwrap();
    stdout(git(&path, &["init", "-q", "-b", "trunk"]));
    crate::git::ops::ensure_svode_gitignore(&path).unwrap();
    std::fs::write(path.join("main.rs"), "fn main() {}").unwrap();
    stdout(git(&path, &["add", "-A"]));
    stdout(git(&path, &["commit", "-qm", "Code"]));
    let gitignore = std::fs::read(path.join(".gitignore")).unwrap();

    let created = fixture.create(&path, Some("Code")).await.unwrap();

    assert_eq!(std::fs::read(path.join(".gitignore")).unwrap(), gitignore);
    assert!(!created.changed_paths.contains(&path.join(".gitignore")));
}

#[tokio::test]
async fn a_denied_repository_is_refused_without_side_effects() {
    let mut fixture = Fixture::new();
    let path = fixture.path("shared");
    std::fs::create_dir(&path).unwrap();
    stdout(git(&path, &["init", "-q"]));
    std::fs::write(path.join("a.md"), "a").unwrap();
    fixture.host.denied = vec![path.clone()];
    let before = snapshot(&path);

    let refused = fixture.create(&path, None).await;

    assert!(matches!(
        refused,
        Err(ProjectError::Git(
            crate::git::GitError::RepositoryAccessDenied { .. }
        ))
    ));
    assert_eq!(snapshot(&path), before);
    assert!(!registry::file(&fixture.device()).exists());
}

#[tokio::test]
async fn without_git_the_project_has_no_repository() {
    let fixture = Fixture::without_git();
    let path = fixture.path("plain");

    let created = fixture.create(&path, None).await.unwrap();

    assert_eq!(created.repository, ProjectRepository::GitNotFound);
    assert!(!path.join(".git").exists());
    assert!(!path.join(".gitignore").exists());
    assert_project_scaffold(&path, "plain");
    registered_id(&created);
}

#[tokio::test]
async fn an_existing_project_is_refused_without_side_effects() {
    let fixture = Fixture::new();
    let path = fixture.path("existing");
    scaffold::scaffold(&path, "Existing", "", "", Storage::Own).unwrap();
    let unreadable = fixture.path("conflicted");
    std::fs::create_dir_all(unreadable.join(".svode")).unwrap();
    std::fs::write(unreadable.join(".svode/config.json"), "{\n<<<<<<< HEAD\n").unwrap();

    for path in [path, unreadable] {
        let before = snapshot(&path);
        let refused = fixture.create(&path, Some("Again")).await;
        assert!(
            matches!(refused, Err(ProjectError::ProjectAlreadyExists(ref shown)) if Path::new(shown) == path),
            "{refused:?}"
        );
        assert_eq!(snapshot(&path), before);
    }
    assert!(!registry::file(&fixture.device()).exists());
}

#[tokio::test]
async fn a_folder_inside_a_project_is_refused_with_the_project_path() {
    let fixture = Fixture::new();
    let project = fixture.path("outer");
    scaffold::scaffold(&project, "Outer", "", "", Storage::Own).unwrap();
    scaffold::scaffold(&project.join("space"), "Space", "", "", Storage::Inherited).unwrap();
    let canonical = project.canonicalize().unwrap();
    let existing = project.join("space/sub");
    std::fs::create_dir_all(&existing).unwrap();

    for path in [existing.clone(), project.join("missing/deeper")] {
        let refused = fixture.create(&path, None).await;
        match refused {
            Err(ProjectError::ProjectNested {
                path: shown,
                project,
            }) => {
                assert_eq!(Path::new(&shown), path);
                assert_eq!(Path::new(&project), canonical);
            }
            other => panic!("not refused as nested: {other:?}"),
        }
    }
    assert!(!project.join("missing").exists());
    assert_eq!(std::fs::read_dir(&existing).unwrap().count(), 0);
    assert!(!registry::file(&fixture.device()).exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_into_a_project_is_refused_as_nested() {
    let fixture = Fixture::new();
    let project = fixture.path("outer");
    scaffold::scaffold(&project, "Outer", "", "", Storage::Own).unwrap();
    std::fs::create_dir(project.join("inner")).unwrap();
    let link = fixture.path("link");
    std::os::unix::fs::symlink(project.join("inner"), &link).unwrap();

    assert!(matches!(
        fixture.create(&link, None).await,
        Err(ProjectError::ProjectNested { .. })
    ));
}

#[tokio::test]
async fn a_file_or_an_inaccessible_folder_is_refused() {
    let fixture = Fixture::new();
    let file = fixture.path("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert!(matches!(
        fixture.create(&file, None).await,
        Err(ProjectError::PathNotAccessible(_))
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let locked = fixture.path("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        // A superuser writes anyway; the refusal is meaningful only for others.
        if tempfile::tempfile_in(&locked).is_err() {
            assert!(matches!(
                fixture.create(&locked, None).await,
                Err(ProjectError::PathNotAccessible(_))
            ));
            assert!(!locked.join(".svode").exists());
            assert!(!fixture.create(&locked.join("child"), None).await.is_ok());
            assert!(!locked.join("child").exists());
        }
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(!registry::file(&fixture.device()).exists());
}

#[tokio::test]
async fn a_failed_registration_removes_what_the_creation_wrote() {
    let fixture = Fixture::new();
    // The list directory cannot be created: a file stands in its place.
    std::fs::write(fixture.device(), "not a directory").unwrap();

    let fresh = fixture.path("parent/fresh");
    let refused = fixture.create(&fresh, Some("Fresh")).await;
    assert!(
        matches!(refused, Err(ProjectError::Registry(_))),
        "{refused:?}"
    );
    assert!(!fixture.path("parent").exists());

    let existing = fixture.path("existing");
    std::fs::create_dir(&existing).unwrap();
    std::fs::write(existing.join("keep.md"), "keep").unwrap();
    std::fs::write(existing.join(".gitignore"), "build/\n").unwrap();
    let before = snapshot(&existing);
    let refused = fixture.create(&existing, None).await;
    assert!(
        matches!(refused, Err(ProjectError::Registry(_))),
        "{refused:?}"
    );
    assert_eq!(snapshot(&existing), before);

    let repository = fixture.path("repository");
    std::fs::create_dir(&repository).unwrap();
    stdout(git(&repository, &["init", "-q"]));
    std::fs::create_dir(repository.join(".svode")).unwrap();
    std::fs::write(repository.join(".svode/local.json"), "{}").unwrap();
    let refused = fixture.create(&repository, None).await;
    assert!(
        matches!(refused, Err(ProjectError::Registry(_))),
        "{refused:?}"
    );
    assert!(!repository.join(".svode/config.json").exists());
    assert_eq!(
        std::fs::read_to_string(repository.join(".svode/local.json")).unwrap(),
        "{}"
    );
    assert!(!repository.join(README_FILE).exists());
    assert!(repository.join(".git").is_dir());
}

#[tokio::test]
async fn without_a_device_directory_the_project_is_created_unregistered() {
    let fixture = Fixture::new();
    let path = fixture.path("loose");

    let created = create(&fixture.runtime, &fixture.host, None, request(&path, None))
        .await
        .unwrap();

    assert_eq!(created.registration, Registration::NoDeviceDirectory);
    assert_project_scaffold(&path, "loose");
}

#[tokio::test]
async fn creating_keeps_the_list_entries_its_last_view_and_unknown_keys() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.device()).unwrap();
    let later_view = serde_json::json!({ "kind": "board", "boardId": "b" });
    std::fs::write(
        registry::file(&fixture.device()),
        serde_json::json!({
            "spaces": [{ "id": "old", "lastOpened": "2026-01-01T00:00:00Z", "path": "/old", "color": "red" }],
            "lastActive": "old",
            "lastView": later_view,
            "future": [1, 2]
        })
        .to_string(),
    )
    .unwrap();

    fixture.create(&fixture.path("new"), None).await.unwrap();

    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(registry::file(&fixture.device())).unwrap()).unwrap();
    assert_eq!(stored["lastView"], later_view);
    assert_eq!(stored["future"], serde_json::json!([1, 2]));
    assert_eq!(stored["lastActive"], "old");
    assert_eq!(stored["spaces"][0]["color"], "red");
    assert_eq!(stored["spaces"][0]["lastOpened"], "2026-01-01T00:00:00Z");
    assert_eq!(stored["spaces"].as_array().unwrap().len(), 2);
    assert_eq!(
        registry::read(&fixture.device()).unwrap().last_view,
        Some(LastView::Unknown(later_view))
    );
}

#[tokio::test]
async fn a_listed_folder_without_config_keeps_its_id() {
    let fixture = Fixture::without_git();
    let path = fixture.path("gone");
    std::fs::create_dir(&path).unwrap();
    registry::add(&fixture.device(), "listed-id", &path.to_string_lossy()).unwrap();

    let created = fixture.create(&path, None).await.unwrap();

    assert_eq!(registered_id(&created), "listed-id");
    assert_eq!(fixture.listed().len(), 1);
}

#[test]
fn opening_a_registered_folder_without_svode_recreates_the_scaffold() {
    let device = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let project = project_dir.path();
    registry::add(device.path(), "registered-id", &project.to_string_lossy()).unwrap();

    let opened = open_folder(device.path(), project).unwrap();

    assert_eq!(opened.id, "registered-id");
    assert_eq!(opened.config.name, scaffold::folder_name(project));
    assert!(opened.config_unreadable.is_none());
    assert!(project.join(".svode/config.json").is_file());
    assert!(project.join(".svode/local.json").is_file());
    assert!(project.join(README_FILE).is_file());
    assert_eq!(registry::read(device.path()).unwrap().spaces.len(), 1);
}

#[test]
fn opening_an_existing_folder_keeps_its_readme_and_registers_it_once() {
    let device = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let project = project_dir.path();
    scaffold::scaffold(project, "Root", "", "", Storage::Inherited).unwrap();
    std::fs::write(project.join(README_FILE), "custom home").unwrap();

    let first = open_folder(device.path(), project).unwrap();
    let again = open_folder(device.path(), project).unwrap();

    assert_eq!(first.id, again.id);
    assert_eq!(first.config.name, "Root");
    assert_eq!(
        std::fs::read_to_string(project.join(README_FILE)).unwrap(),
        "custom home"
    );
    let found = registry::find(device.path(), &first.id).unwrap().unwrap();
    assert_eq!(Path::new(&found.path), project);
}

#[test]
fn opening_a_missing_folder_or_a_file_is_refused() {
    let device = tempfile::tempdir().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("file");
    std::fs::write(&file, "x").unwrap();
    for path in [temp.path().join("absent"), file] {
        assert!(matches!(
            open_folder(device.path(), &path),
            Err(ProjectError::PathNotAccessible(_))
        ));
    }
    assert!(!registry::file(device.path()).exists());
}

/// Configs that exist but cannot be read, with the reason each one gives.
fn unreadable_configs() -> Vec<(&'static str, &'static str, Unreadable)> {
    let field = |field: &str| Unreadable::Field {
        field: field.to_string(),
    };
    vec![
        (
            "conflict markers",
            "{\n<<<<<<< HEAD\n  \"name\": \"Ours\"\n=======\n  \"name\": \"Theirs\"\n>>>>>>> origin/main\n}\n",
            Unreadable::Conflict,
        ),
        ("broken JSON", "{\"name\": \"Docs\",", Unreadable::NotJson),
        (
            "no name",
            "{\"icon\": \"x\", \"spaces\": []}",
            field("name"),
        ),
        (
            "field of another type",
            "{\"name\": \"Docs\", \"icon\": 7}",
            field("icon"),
        ),
        (
            "repeated key",
            "{\"name\": \"Ours\", \"name\": \"Theirs\"}",
            field("name"),
        ),
    ]
}

fn write_config(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.join(".svode")).unwrap();
    std::fs::write(path.join(".svode/config.json"), contents).unwrap();
}

fn read_config(path: &Path) -> String {
    std::fs::read_to_string(path.join(".svode/config.json")).unwrap()
}

#[test]
fn opening_a_project_with_an_unreadable_config_keeps_the_file() {
    for registered in [true, false] {
        for (case, contents, reason) in unreadable_configs() {
            let device = tempfile::tempdir().unwrap();
            let parent = tempfile::tempdir().unwrap();
            let project = parent.path().join("my-project");
            write_config(&project, contents);
            if registered {
                registry::add(device.path(), "registered-id", &project.to_string_lossy()).unwrap();
            }

            let opened = open_folder(device.path(), &project).expect(case);

            assert_eq!(opened.config_unreadable, Some(reason), "{case}");
            assert_eq!(opened.config.name, "my-project", "{case}");
            assert!(opened.config.spaces.is_none(), "{case}");
            assert_eq!(read_config(&project), contents, "{case}");
            assert!(!project.join(README_FILE).exists(), "{case}");
            if registered {
                assert_eq!(opened.id, "registered-id", "{case}");
            } else {
                let found = registry::find(device.path(), &opened.id).unwrap().unwrap();
                assert_eq!(Path::new(&found.path), project, "{case}");
            }
        }
    }
}

fn commit_config(repo: &Path, name: &str) {
    write_config(
        repo,
        &format!("{{\n  \"name\": \"{name}\",\n  \"spaces\": []\n}}\n"),
    );
    stdout(git(repo, &["add", "-A"]));
    stdout(git(repo, &["commit", "-qm", name]));
}

/// DF-235 during 1.19: a project whose `config.json` is in a merge
/// conflict opens, and opening it changes neither the file nor the merge,
/// so the conflict is still resolved by places in "Changes".
#[test]
fn opening_a_project_during_a_config_conflict_keeps_the_file_and_the_merge() {
    for registered in [true, false] {
        let device = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let project = parent.path().join("my-project");
        std::fs::create_dir_all(&project).unwrap();
        stdout(git(&project, &["init", "-q", "-b", "main"]));
        commit_config(&project, "Base");
        stdout(git(&project, &["checkout", "-qb", "incoming"]));
        commit_config(&project, "Theirs");
        stdout(git(&project, &["checkout", "-q", "main"]));
        commit_config(&project, "Ours");
        assert!(!git(&project, &["merge", "-q", "incoming"]).status.success());
        let contents = read_config(&project);
        assert!(contents.contains("<<<<<<<"), "{contents}");
        let status = git(&project, &["status", "--porcelain=v1", "-uall"]).stdout;
        if registered {
            registry::add(device.path(), "registered-id", &project.to_string_lossy()).unwrap();
        }

        let opened = open_folder(device.path(), &project).unwrap();

        assert_eq!(opened.config_unreadable, Some(Unreadable::Conflict));
        assert_eq!(opened.config.name, "my-project");
        assert_eq!(read_config(&project), contents);
        assert!(project.join(".git/MERGE_HEAD").exists());
        assert_eq!(
            git(&project, &["status", "--porcelain=v1", "-uall"]).stdout,
            status
        );
        let unmerged = git(&project, &["diff", "--name-only", "--diff-filter=U"]).stdout;
        assert_eq!(String::from_utf8_lossy(&unmerged), ".svode/config.json\n");
    }
}
