#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;

    use tempfile::TempDir;

    use crate::files::actor_observation::ActorObservation;
    use svode_core::actors::resolver::ActorCatalogState;
    use svode_core::git::actor_sources::ActorSources;
    use svode_core::git::cli::GitCli;

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .env("LC_ALL", "C")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(name: &str, email: &str) -> TempDir {
        let temp = tempfile::tempdir().expect("temp repository");
        git(temp.path(), &["init", "--quiet"]);
        git(temp.path(), &["config", "user.name", name]);
        git(temp.path(), &["config", "user.email", email]);
        temp
    }

    fn commit(path: &Path, file: &str, contents: &str, message: &str) {
        fs::write(path.join(file), contents).expect("write commit file");
        git(path, &["add", file]);
        git(path, &["commit", "--quiet", "-m", message]);
    }

    #[tokio::test]
    async fn overlapping_observations_recover_and_release_without_duplicate_generation() {
        use std::sync::mpsc;
        use std::time::Duration;
        let repo = init_repo("Root", "root@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        let inline = repo.path().join("inline");
        fs::create_dir(&inline).unwrap();
        let independent = init_repo("Other", "other@example.test");
        let cli = GitCli::detect().unwrap();
        let state = Arc::new(ActorCatalogState::new());
        let initial = state.snapshot(&cli, repo.path()).await.unwrap();
        let other = state.snapshot(&cli, independent.path()).await.unwrap();
        let (tx, rx) = mpsc::channel();
        let start = |path: PathBuf| {
            let state = state.clone();
            let tx = tx.clone();
            ActorObservation::start(cli.clone(), path, move |repository| {
                let _ = state.mark_repository_dirty(repository);
                let _ = tx.send(());
            })
            .unwrap()
        };
        let first = start(repo.path().to_path_buf());
        let second = start(inline.clone());
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        git(
            repo.path(),
            &["config", "user.email", "overlap@example.test"],
        );
        // Managed invalidation plus two observer echoes still produces one publication.
        state.mark_repository_dirty(repo.path()).unwrap();
        let managed = state.snapshot(&cli, repo.path()).await.unwrap();
        assert_eq!(managed.generation(), initial.generation() + 1);
        rx.recv_timeout(Duration::from_secs(8)).unwrap();
        while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
        assert!(Arc::ptr_eq(
            &managed,
            &state.snapshot(&cli, &inline).await.unwrap()
        ));
        assert!(Arc::ptr_eq(
            &other,
            &state.snapshot(&cli, independent.path()).await.unwrap()
        ));
        drop(first);
        drop(second);
        while rx.try_recv().is_ok() {}
        git(repo.path(), &["config", "user.email", "gap@example.test"]);
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
        let restored = start(repo.path().to_path_buf());
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            state.snapshot(&cli, &inline).await.unwrap().current_email(),
            Some("gap@example.test")
        );
        // Invalid gitfile/metadata resolution retains the cache and recovers under the same owner.
        let gitdir = repo.path().join(".git");
        let saved = repo.path().join("saved-git");
        fs::rename(&gitdir, &saved).unwrap();
        rx.recv_timeout(Duration::from_secs(8)).unwrap();
        assert!(state.snapshot(&cli, repo.path()).await.is_err());
        fs::rename(&saved, &gitdir).unwrap();
        git(
            repo.path(),
            &["config", "user.email", "recovered@example.test"],
        );
        rx.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(
            state
                .snapshot(&cli, repo.path())
                .await
                .unwrap()
                .current_email(),
            Some("recovered@example.test")
        );
        drop(restored);
    }

    #[tokio::test]
    async fn observed_submodule_sources_refresh_catalog_and_activity() {
        use std::sync::mpsc;
        use std::time::Duration;

        let parent = init_repo("Parent", "parent@example.test");
        commit(parent.path(), "root.txt", "root", "root");
        let remote = init_repo("Child", "child@example.test");
        commit(remote.path(), "child.txt", "child", "child");
        git(
            parent.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                remote.path().to_str().unwrap(),
                "child",
            ],
        );
        let child = fs::canonicalize(parent.path().join("child")).unwrap();
        git(&child, &["config", "user.name", "Child"]);
        git(&child, &["config", "user.email", "child@example.test"]);
        git(
            parent.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                remote.path().to_str().unwrap(),
                "sibling",
            ],
        );
        let sibling = parent.path().join("sibling");
        let cli = GitCli::detect().unwrap();
        let state = Arc::new(ActorCatalogState::new());
        let parent_snapshot = state.snapshot(&cli, parent.path()).await.unwrap();
        let initial = state.snapshot(&cli, &child).await.unwrap();
        let sibling_snapshot = state.snapshot(&cli, &sibling).await.unwrap();
        let sibling_sources = ActorSources::resolve(&cli, &sibling).await.unwrap();
        let (tx, rx) = mpsc::channel();
        let observed_state = state.clone();
        let observation = ActorObservation::start(cli.clone(), child.clone(), move |repository| {
            observed_state.mark_repository_dirty(repository).unwrap();
            tx.send(repository.to_path_buf()).unwrap();
        })
        .unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), child);
        let sources = ActorSources::resolve(&cli, &child).await.unwrap();
        let parent_sources = ActorSources::resolve(&cli, parent.path()).await.unwrap();
        let child_config = sources
            .watch_paths()
            .into_iter()
            .map(|(path, _)| path.join("config"))
            .find(|path| path.is_file() && sources.contains(path) && !parent_sources.contains(path))
            .unwrap();
        assert!(!parent_sources.contains(&child_config));
        assert!(!sibling_sources.contains(&child_config));

        // Every mutation must produce an actual OS observation before the cache is read.
        let wait = || {
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(8))
                    .expect("source event"),
                child
            );
            while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
        };
        git(&child, &["config", "user.email", "external@example.test"]);
        git(
            &child,
            &["commit", "--allow-empty", "-m", "attached external"],
        );
        wait();
        let attached = state.snapshot(&cli, &child).await.unwrap();
        assert_eq!(attached.current_email(), Some("external@example.test"));
        assert_eq!(attached.generation(), initial.generation() + 1);
        assert_eq!(
            state
                .activity(&cli, &child, "external@example.test", None, None, None)
                .await
                .unwrap()
                .commit_count,
            1
        );
        git(&child, &["checkout", "--detach", "--quiet"]);
        git(
            &child,
            &["commit", "--allow-empty", "-m", "detached external"],
        );
        wait();
        let detached = state.snapshot(&cli, &child).await.unwrap();
        assert!(detached.generation() > attached.generation());

        git(
            remote.path(),
            &["config", "user.email", "fetched@example.test"],
        );
        git(
            remote.path(),
            &["commit", "--allow-empty", "-m", "remote author"],
        );
        git(&child, &["fetch", "origin"]);
        wait();
        let fetched = state.snapshot(&cli, &child).await.unwrap();
        assert!(
            fetched
                .candidates()
                .iter()
                .any(|row| row.email == "fetched@example.test")
        );
        git(&child, &["pack-refs", "--all", "--prune"]);
        wait();
        let packed = state.snapshot(&cli, &child).await.unwrap();
        assert_eq!(packed.generation(), fetched.generation());
        let replacement = child_config.with_extension("replacement");
        fs::write(&replacement, fs::read(&child_config).unwrap()).unwrap();
        fs::rename(replacement, &child_config).unwrap();
        wait();
        assert_eq!(
            state.snapshot(&cli, &child).await.unwrap().generation(),
            packed.generation()
        );

        let head = cli
            .exec(&child, &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .stdout;
        let shallow = child_config.with_file_name("shallow");
        fs::write(&shallow, head).unwrap();
        wait();
        assert!(
            state
                .snapshot(&cli, &child)
                .await
                .unwrap()
                .catalog()
                .shallow
        );
        fs::remove_file(shallow).unwrap();
        wait();
        assert!(
            !state
                .snapshot(&cli, &child)
                .await
                .unwrap()
                .catalog()
                .shallow
        );
        assert!(Arc::ptr_eq(
            &parent_snapshot,
            &state.snapshot(&cli, parent.path()).await.unwrap()
        ));
        assert!(Arc::ptr_eq(
            &sibling_snapshot,
            &state.snapshot(&cli, &sibling).await.unwrap()
        ));
        drop(observation);
        git(&child, &["config", "user.email", "gap@example.test"]);
        assert_eq!(
            state.snapshot(&cli, &child).await.unwrap().current_email(),
            Some("gap@example.test")
        );
    }
}
