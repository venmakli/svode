//! An open project follows `spaces` in its root config on disk (Stage 11 05
//! «Открытый Desktop следует `spaces` на диске», «Коммиты создания» n. 2 and
//! 6, invariant 7): what a change by another process opens, closes and
//! announces, that a change applies once, and the creation commit of a
//! picked-up Space.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use svode_core::git::autocommit::AutocommitService;
use svode_core::git::policy::{GitUserPolicy, write_user_policy};
use svode_core::git::state::GitRuntime;
use svode_core::git::versions::MessageLanguage;
use svode_core::git::versions::auto::{AutoVersions, Closing, close};
use svode_core::project::scaffold::{self, Storage};
use svode_core::project::space::{SpaceCreate, create};
use svode_core::storage::config::SpaceGitType;

use super::*;
use crate::git::auto_versions::tests::QuietHost;
use crate::index::update::test_update_state;

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// A project repository with a committed scaffold, no hooks of the machine
/// and the given device flags, open in a window runtime.
struct Project {
    _temp: tempfile::TempDir,
    root: PathBuf,
    runtime: Arc<GitRuntime>,
    host: Arc<QuietHost>,
    index: IndexState,
    routines: RoutineStoreState,
    project_runtime: ProjectRuntimeState,
}

/// The window effects a reconciliation asked for, recorded instead of done.
#[derive(Default)]
struct Recorded {
    repaired: Mutex<Vec<PathBuf>>,
    rebuilt: Mutex<Vec<IndexKey>>,
    unready: Mutex<Vec<IndexKey>>,
    events: Mutex<Vec<(String, serde_json::Value)>>,
    commits: Mutex<Vec<PathBuf>>,
}

impl SpacesEffects for Recorded {
    async fn repair_scope(&self, _project: &Path, dir: &Path) {
        self.repaired.lock().unwrap().push(dir.to_path_buf());
    }

    fn rebuild(&self, key: IndexKey) {
        self.rebuilt.lock().unwrap().push(key);
    }

    async fn space_unready(&self, key: IndexKey) {
        self.unready.lock().unwrap().push(key);
    }

    fn emit(&self, event: &'static str, payload: serde_json::Value) {
        self.events
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }

    fn commit_creations(&self, project: &Path) {
        self.commits.lock().unwrap().push(project.to_path_buf());
    }
}

impl Recorded {
    fn rebuilt(&self) -> Vec<IndexKey> {
        self.rebuilt.lock().unwrap().clone()
    }

    /// `(event, spaceId)` of each window event, sorted.
    fn events(&self) -> Vec<(String, String)> {
        let mut events = self
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|(event, payload)| {
                (
                    event.clone(),
                    payload["spaceId"].as_str().unwrap().to_string(),
                )
            })
            .collect::<Vec<_>>();
        events.sort();
        events
    }

    fn commit_requests(&self) -> usize {
        self.commits.lock().unwrap().len()
    }
}

impl Project {
    async fn new(policy: GitUserPolicy) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project").canonicalize_or_create();
        let hooks = temp.path().join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.test"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(
            &root,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        scaffold::scaffold(&root, "Root", "", "", Storage::Own).unwrap();
        std::fs::write(root.join("note.md"), "# Note\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "Base"]);
        write_user_policy(&root, &policy).unwrap();
        Self {
            _temp: temp,
            root,
            runtime: Arc::new(GitRuntime::new()),
            host: Arc::new(QuietHost),
            index: IndexState::new(),
            routines: RoutineStoreState::new(),
            project_runtime: ProjectRuntimeState::new(),
        }
    }

    async fn open(&self) {
        self.index.open_project(&self.root).await.unwrap();
        self.routines
            .reconcile_project(&self.index, &self.root)
            .await
            .unwrap();
    }

    /// A Space created the way another process creates it: the core
    /// operation, which commits nothing.
    async fn create(&self, folder: &str, git_type: SpaceGitType) -> String {
        create(
            &self.runtime,
            self.host.as_ref(),
            SpaceCreate {
                project: self.root.clone(),
                name: format!("Space {folder}"),
                folder: folder.to_string(),
                git_type,
                icon: None,
                description: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    /// The pickup of the window runtime, as the watcher and a pull run it,
    /// with its window effects recorded; the pools it asked to rebuild
    /// rebuild here.
    async fn pick_up(&self) -> (SpacesChange, Recorded) {
        let effects = Recorded::default();
        let change = self
            .project_runtime
            .pick_up_spaces_with(&self.index, &self.routines, &self.root, &effects)
            .await
            .unwrap();
        self.rebuild(&effects).await;
        (change, effects)
    }

    /// The reconciliation a Space command of the window runs after its
    /// operation.
    async fn reconcile_own(&self) -> (SpacesChange, Recorded) {
        let effects = Recorded::default();
        let change = self
            .project_runtime
            .reconcile_spaces_with(&self.index, &self.routines, &self.root, &effects)
            .await
            .unwrap();
        self.rebuild(&effects).await;
        (change, effects)
    }

    async fn rebuild(&self, effects: &Recorded) {
        for key in effects.rebuilt() {
            test_update_state()
                .run_full_reindex(&self.index, &key)
                .await
                .unwrap();
        }
    }

    fn service(&self) -> AutocommitService {
        AutocommitService::new(self.runtime.clone(), self.host.clone())
    }

    fn key(&self, space_id: &str) -> IndexKey {
        IndexKey::Space {
            project: self.root.clone(),
            space_id: space_id.to_string(),
        }
    }

    fn root_key(&self) -> IndexKey {
        IndexKey::Root(self.root.clone())
    }

    async fn pages(&self, key: &IndexKey) -> Vec<String> {
        let pool = self.index.core.existing_pool(key).await.unwrap();
        sqlx::query_scalar("SELECT file_path FROM pages ORDER BY file_path")
            .fetch_all(&pool)
            .await
            .unwrap()
    }

    async fn routine_keys(&self) -> Vec<IndexKey> {
        let mut keys = self.routines.core().open_keys_for_project(&self.root).await;
        keys.sort_by_key(|key| format!("{key:?}"));
        keys
    }

    fn subjects(&self) -> Vec<String> {
        git(&self.root, &["log", "--format=%s"])
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn committed(&self, rev: &str) -> Vec<String> {
        let mut files = git(&self.root, &["show", "--name-only", "--format=", rev])
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    fn write_spaces(&self, spaces: serde_json::Value) {
        let path = self.root.join(".svode/config.json");
        let mut config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        config["spaces"] = spaces;
        std::fs::write(path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
    }

    fn space_refs(&self) -> serde_json::Value {
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(self.root.join(".svode/config.json")).unwrap(),
        )
        .unwrap();
        config["spaces"].clone()
    }
}

trait CanonicalOrCreate {
    fn canonicalize_or_create(self) -> PathBuf;
}

impl CanonicalOrCreate for PathBuf {
    fn canonicalize_or_create(self) -> PathBuf {
        std::fs::create_dir_all(&self).unwrap();
        self.canonicalize().unwrap()
    }
}

fn structural() -> GitUserPolicy {
    GitUserPolicy {
        auto_commit_structural: true,
        ..GitUserPolicy::default()
    }
}

#[tokio::test]
async fn spaces_another_process_adds_open_their_pools_and_leave_the_root_index() {
    let project = Project::new(GitUserPolicy::default()).await;
    project.open().await;

    // E7: the inline folder and its page reach the root index before its
    // `SpaceRef` is seen.
    let inline = project.create("ext-inline", SpaceGitType::Inline).await;
    std::fs::write(project.root.join("ext-inline/probe.md"), "# Probe\n").unwrap();
    test_update_state()
        .run_full_reindex(&project.index, &project.root_key())
        .await
        .unwrap();
    assert!(
        project
            .pages(&project.root_key())
            .await
            .contains(&"ext-inline/probe.md".to_string())
    );
    let independent = project.create("ext-indep", SpaceGitType::Independent).await;
    let submodule = project.create("ext-sub", SpaceGitType::Submodule).await;

    let (change, effects) = project.pick_up().await;
    let rebuild = effects.rebuilt();

    let mut added = change
        .added
        .iter()
        .map(|space| (space.id.clone(), space.folder.clone(), space.status))
        .collect::<Vec<_>>();
    added.sort_by(|a, b| a.0.cmp(&b.0));
    let mut expected = vec![
        (inline.clone(), "ext-inline".to_string(), SpaceStatus::Ready),
        (
            independent.clone(),
            "ext-indep".to_string(),
            SpaceStatus::Ready,
        ),
        (submodule.clone(), "ext-sub".to_string(), SpaceStatus::Ready),
    ];
    expected.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(added, expected);
    for id in [&inline, &independent, &submodule] {
        assert!(
            project
                .index
                .core
                .existing_pool(&project.key(id))
                .await
                .is_some()
        );
        assert!(rebuild.contains(&project.key(id)));
    }
    assert!(rebuild.contains(&project.root_key()));
    let routine_keys = project.routine_keys().await;
    for id in [&inline, &independent, &submodule] {
        assert!(routine_keys.contains(&project.key(id)), "{routine_keys:?}");
    }

    // Each ready Space gets its local Git policy.
    let mut repaired = effects.repaired.lock().unwrap().clone();
    repaired.sort();
    assert_eq!(
        repaired,
        ["ext-indep", "ext-inline", "ext-sub"].map(|folder| project.root.join(folder))
    );

    // The window hears of each Space and reads its lists again.
    let events = effects.events();
    let mut expected_events = [&inline, &independent, &submodule]
        .map(|id| ("space:added".to_string(), id.clone()))
        .to_vec();
    expected_events.sort();
    assert_eq!(events, expected_events);
    let payload = effects.events.lock().unwrap()[0].1.clone();
    assert_eq!(
        payload["projectPath"].as_str(),
        Some(project.root.to_str().unwrap())
    );

    // The inline pages belong to their Space only.
    let root_pages = project.pages(&project.root_key()).await;
    assert!(
        !root_pages.iter().any(|path| path.starts_with("ext-")),
        "{root_pages:?}"
    );
    assert!(root_pages.contains(&"note.md".to_string()));
    assert!(
        project
            .pages(&project.key(&inline))
            .await
            .contains(&"probe.md".to_string())
    );

    // The pickup asks for the creation commits of the added Spaces.
    assert_eq!(effects.commit_requests(), 1);

    // Observing the same `spaces` again changes nothing.
    let (again, effects) = project.pick_up().await;
    assert!(again.is_empty());
    assert!(effects.rebuilt().is_empty());
    assert!(effects.events().is_empty());
    assert_eq!(effects.commit_requests(), 0);
}

#[tokio::test]
async fn a_removed_space_ref_closes_its_pools_and_an_unreadable_config_keeps_them() {
    let project = Project::new(GitUserPolicy::default()).await;
    let kept = project.create("kept", SpaceGitType::Inline).await;
    let gone = project.create("gone", SpaceGitType::Inline).await;
    let lost = project.create("lost", SpaceGitType::Inline).await;
    std::fs::write(project.root.join("gone/page.md"), "# Page\n").unwrap();
    project.open().await;
    assert!(
        project
            .index
            .core
            .existing_pool(&project.key(&gone))
            .await
            .is_some()
    );

    let refs = project.space_refs();
    let remaining = refs
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["id"] != gone.as_str())
        .cloned()
        .collect::<Vec<_>>();
    project.write_spaces(serde_json::Value::Array(remaining));

    let (change, effects) = project.pick_up().await;
    let rebuild = effects.rebuilt();
    assert_eq!(change.removed, vec![gone.clone()]);
    assert!(change.added.is_empty() && change.changed.is_empty());
    assert_eq!(
        effects.events(),
        [("space:removed".to_string(), gone.clone())]
    );
    assert_eq!(effects.commit_requests(), 0);
    assert!(
        project
            .index
            .core
            .existing_pool(&project.key(&gone))
            .await
            .is_none()
    );
    assert!(!project.routine_keys().await.contains(&project.key(&gone)));
    // The folder is content of the root again.
    assert!(rebuild.contains(&project.root_key()));
    assert!(
        project
            .pages(&project.root_key())
            .await
            .contains(&"gone/page.md".to_string())
    );

    // A Space whose folder disappeared stops being served until it returns.
    std::fs::remove_dir_all(project.root.join("lost")).unwrap();
    let (change, effects) = project.pick_up().await;
    assert_eq!(change.changed.len(), 1);
    assert_eq!(change.changed[0].new, SpaceStatus::Broken);
    assert_eq!(
        effects.events(),
        [("space:status_changed".to_string(), lost.clone())]
    );
    assert_eq!(*effects.unready.lock().unwrap(), [project.key(&lost)]);
    assert!(
        project
            .index
            .core
            .existing_pool(&project.key(&lost))
            .await
            .is_none()
    );
    assert!(!project.routine_keys().await.contains(&project.key(&lost)));

    // A config in the middle of a merge closes nothing.
    std::fs::write(
        project.root.join(".svode/config.json"),
        "<<<<<<< ours\n{\"name\":\"Root\"}\n=======\n",
    )
    .unwrap();
    let effects = Recorded::default();
    assert!(
        project
            .project_runtime
            .pick_up_spaces_with(&project.index, &project.routines, &project.root, &effects)
            .await
            .is_err()
    );
    assert!(effects.events().is_empty() && effects.rebuilt().is_empty());
    assert!(
        project
            .index
            .core
            .existing_pool(&project.key(&kept))
            .await
            .is_some()
    );
    assert!(project.routine_keys().await.contains(&project.key(&kept)));
}

#[tokio::test]
async fn the_windows_own_creation_applies_once_and_commits_once() {
    let project = Project::new(structural()).await;
    project.open().await;

    // The command: the operation, its reconciliation and its commit.
    let id = project.create("clients", SpaceGitType::Inline).await;
    let (change, effects) = project.reconcile_own().await;
    assert_eq!(change.added.len(), 1);
    assert!(effects.rebuilt().contains(&project.key(&id)));
    assert_eq!(effects.events(), [("space:added".to_string(), id.clone())]);
    // The command makes its commit itself, not as a pickup.
    assert_eq!(effects.commit_requests(), 0);
    assert_eq!(
        project
            .service()
            .commit_space_creations(&project.root)
            .await
            .unwrap(),
        1
    );

    // The watcher observes the same config: no rebuild, no event, no
    // pickup commit, and a commit attempt finds nothing to commit.
    let (again, effects) = project.pick_up().await;
    assert!(again.is_empty());
    assert!(effects.rebuilt().is_empty());
    assert!(effects.events().is_empty());
    assert_eq!(effects.commit_requests(), 0);
    assert_eq!(
        project
            .service()
            .commit_space_creations(&project.root)
            .await
            .unwrap(),
        0
    );
    assert_eq!(project.subjects(), ["Add inline space clients", "Base"]);
}

#[tokio::test]
async fn a_picked_up_inline_space_gets_one_creation_commit_by_the_structural_flag() {
    for (policy, commits) in [(structural(), 1), (GitUserPolicy::default(), 0)] {
        let project = Project::new(policy).await;
        project.open().await;
        // Unrelated staged and unstaged changes of the root stay out.
        std::fs::write(project.root.join("staged.md"), "# Staged\n").unwrap();
        git(&project.root, &["add", "staged.md"]);
        std::fs::write(project.root.join("note.md"), "# Changed\n").unwrap();

        project.create("ext", SpaceGitType::Inline).await;
        let (change, effects) = project.pick_up().await;
        assert_eq!(change.added.len(), 1);
        // The pickup asks for the creation commit; the window runs it.
        assert_eq!(*effects.commits.lock().unwrap(), [project.root.clone()]);
        let service = project.service();
        assert_eq!(
            service.commit_space_creations(&project.root).await.unwrap(),
            commits
        );

        // A second pickup of the same Space commits nothing more.
        let (again, effects) = project.pick_up().await;
        assert!(again.added.is_empty());
        assert_eq!(effects.commit_requests(), 0);
        assert_eq!(
            service.commit_space_creations(&project.root).await.unwrap(),
            0
        );

        if commits == 0 {
            assert_eq!(project.subjects(), ["Base"]);
            continue;
        }
        assert_eq!(project.subjects(), ["Add inline space ext", "Base"]);
        assert_eq!(
            project.committed("HEAD"),
            [
                ".gitignore",
                ".svode/config.json",
                "ext/.svode/config.json",
                "ext/README.md",
            ]
        );
        let staged = git(&project.root, &["diff", "--cached", "--name-only"]);
        assert_eq!(staged.trim(), "staged.md");
    }
}

#[tokio::test]
async fn a_space_created_while_the_project_was_closed_commits_at_opening_before_its_pages() {
    let project = Project::new(GitUserPolicy {
        auto_commit_content: true,
        ..structural()
    })
    .await;
    project.create("ext", SpaceGitType::Inline).await;
    std::fs::write(project.root.join("ext/page.md"), "# Page\n").unwrap();

    // Opening: the runtime serves the Space at once, and the creation
    // commit runs for it.
    project.open().await;
    assert!(
        project
            .index
            .spaces_change(&project.root)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        project
            .service()
            .commit_space_creations(&project.root)
            .await
            .unwrap(),
        1
    );

    // The page becomes a version after its Space is registered.
    let result = close(
        &project.runtime,
        project.host.as_ref(),
        &project.root,
        &Closing::all(Duration::from_secs(60)),
        MessageLanguage::En,
    )
    .await
    .unwrap();
    assert!(
        matches!(result, AutoVersions::Done { commits: 1, .. }),
        "{result:?}"
    );
    let subjects = project.subjects();
    assert_eq!(subjects[1..], ["Add inline space ext", "Base"]);
    assert!(
        project
            .committed("HEAD")
            .contains(&"ext/page.md".to_string())
    );
    assert!(
        !project
            .committed("HEAD~1")
            .contains(&"ext/page.md".to_string())
    );
}
