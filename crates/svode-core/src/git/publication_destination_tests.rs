//! A remote whose push URL names a user publishes like one without it
//! (DF-379): every connection of the publication snapshot, its revalidation,
//! the push and the proof copy goes to `user@host` through a fake `ssh` that
//! logs the address and runs the remote command locally.

use super::*;
use crate::git::publication::{blocked_spaces, push};
use crate::git::sync::{SyncResult, sync};
use std::path::PathBuf;
use std::process::Command;

const USER_HOST: &str = "user@fixture.invalid";

struct Fixture {
    temp: tempfile::TempDir,
    global: PathBuf,
    log: PathBuf,
}

impl Fixture {
    /// `dry_run_sed` is a `sed` command for the `To` line of the dry run.
    fn new(dry_run_sed: Option<&str>) -> (Self, GitCli) {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("ssh.log");
        let ssh = temp.path().join("fake-ssh");
        // The last two arguments are the address and the remote command.
        svode_testkit::write_executable(
            &ssh,
            format!(
                "#!/bin/sh\nport=-\nwhile [ $# -gt 2 ]; do\n\
                 case \"$1\" in -p) port=$2; shift 2;; *) shift;; esac\ndone\n\
                 printf '%s %s %s %s\\n' \"$1\" \"$port\" \"${{2%% *}}\" \"$PWD\" >> '{}'\n\
                 exec sh -c \"$2\"\n",
                log.display()
            ),
        )
        .unwrap();
        let global = temp.path().join("gitconfig");
        std::fs::write(
            &global,
            format!(
                "[user]\n\tname = Fixture\n\temail = fixture@example.test\n\
                 [protocol \"file\"]\n\tallow = always\n\
                 [core]\n\tsshCommand = {}\n[ssh]\n\tvariant = ssh\n",
                ssh.display()
            ),
        )
        .unwrap();
        let replace = dry_run_sed.map_or_else(String::new, |to| {
            format!(
                "case \"$*\" in *'push --dry-run'*)\n\
                 out=$(git \"$@\"); code=$?\n\
                 printf '%s\\n' \"$out\" | sed '/^To /{to}'; exit $code;;\nesac\n"
            )
        });
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1\n{replace}exec git \"$@\"\n",
                global.display()
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(wrapper);
        (Self { temp, global, log }, cli)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", &self.global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim_end().into()
    }

    fn commit(&self, repo: &Path, value: &str) {
        std::fs::write(repo.join("note"), value).unwrap();
        self.git(repo, &["add", "note"]);
        self.git(repo, &["commit", "-qm", value]);
    }

    fn bare(&self, from: &Path, name: &str) -> PathBuf {
        let bare = self.path(name);
        self.git(
            self.temp.path(),
            &[
                "clone",
                "-q",
                "--bare",
                from.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        bare
    }

    fn repo(&self, name: &str) -> PathBuf {
        let repo = self.path(name);
        std::fs::create_dir(&repo).unwrap();
        self.git(&repo, &["init", "-q", "-b", "main"]);
        self.commit(&repo, "initial");
        repo
    }

    /// A published root with the Space `Space`, an unpublished Space
    /// revision its source has and a root commit that points to it. The
    /// root remote also has a branch the root lacks, so the proof copy
    /// fetches it. From here on the root reaches its remote at `url(path)`.
    fn root(&self, url: impl Fn(&Path) -> String) -> (PathBuf, PathBuf) {
        let seed = self.repo("seed");
        let source = self.bare(&seed, "space.git");
        let root = self.repo("project");
        self.git(
            &root,
            &["submodule", "add", "-q", source.to_str().unwrap(), "Space"],
        );
        self.git(&root, &["commit", "-qm", "Space"]);
        let remote = self.bare(&root, "project.git");
        self.git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        self.git(&root, &["fetch", "-q", "origin"]);
        self.git(&root, &["branch", "-q", "-u", "origin/main"]);
        let other = self.path("other");
        self.git(
            self.temp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        self.commit(&other, "other branch");
        self.git(&other, &["push", "-q", "origin", "HEAD:refs/heads/other"]);
        let child = root.join("Space");
        self.commit(&child, "published Space revision");
        self.git(&child, &["push", "-q", "origin", "HEAD:main"]);
        self.git(&root, &["add", "Space"]);
        self.git(&root, &["commit", "-qm", "pointer"]);
        self.git(&root, &["remote", "set-url", "origin", &url(&remote)]);
        (root, remote)
    }

    /// Every logged connection: address, port, service and directory.
    fn connections(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| line.splitn(4, ' ').map(str::to_owned).collect())
            .collect()
    }
}

fn forms() -> [(&'static str, Box<dyn Fn(&Path) -> String>); 3] {
    [
        (
            "2222",
            Box::new(|path| format!("ssh://{USER_HOST}:2222{}", path.display())),
        ),
        (
            "-",
            Box::new(|path| format!("ssh://{USER_HOST}{}", path.display())),
        ),
        (
            "-",
            Box::new(|path| format!("{USER_HOST}:{}", path.display())),
        ),
    ]
}

fn configuration(error: GitError) {
    assert!(
        matches!(
            error,
            GitError::PublicationBlocked {
                reason: PublicationBlockReason::Configuration,
                ..
            }
        ),
        "{error:?}"
    );
}

#[tokio::test]
async fn root_with_a_user_in_its_push_url_proves_and_syncs_as_that_user() {
    for (port, url) in forms() {
        let (f, cli) = Fixture::new(None);
        let (root, remote) = f.root(url);
        let form = f.git(&root, &["remote", "get-url", "--push", "origin"]);

        assert_eq!(
            blocked_spaces(&cli, &root).await.unwrap(),
            Vec::new(),
            "{form}"
        );
        let proof = f.connections();
        assert!(
            proof.iter().any(|connection| {
                connection[2] == "git-upload-pack" && connection[3].contains("svode-publication-")
            }),
            "{form}: the proof copy fetched over the remote: {proof:?}"
        );
        assert!(
            matches!(sync(&cli, &root).await.unwrap(), SyncResult::Success { .. }),
            "{form}"
        );
        assert_eq!(
            f.git(&remote, &["rev-parse", "main"]),
            f.git(&root, &["rev-parse", "HEAD"]),
            "{form}"
        );

        let connections = f.connections();
        let pushes = connections
            .iter()
            .filter(|connection| connection[2] == "git-receive-pack")
            .count();
        // The dry run of the blocked_spaces snapshot, of the sync snapshot and the push.
        assert!(pushes >= 3, "{form}: {connections:?}");
        for connection in &connections {
            assert_eq!(
                (connection[0].as_str(), connection[1].as_str()),
                (USER_HOST, port),
                "{form}: {connections:?}"
            );
        }
    }
}

#[tokio::test]
async fn first_publication_of_a_space_with_a_user_in_its_push_url_publishes() {
    for (port, url) in forms() {
        let (f, cli) = Fixture::new(None);
        let space = f.repo("space");
        let remote = f.path("space.git");
        f.git(
            f.temp.path(),
            &["init", "-q", "--bare", remote.to_str().unwrap()],
        );
        f.git(&space, &["remote", "add", "origin", &url(&remote)]);

        assert!(
            matches!(
                sync(&cli, &space).await.unwrap(),
                SyncResult::Success { .. }
            ),
            "{}",
            url(&remote)
        );
        assert_eq!(
            f.git(&remote, &["rev-parse", "main"]),
            f.git(&space, &["rev-parse", "HEAD"])
        );
        let connections = f.connections();
        assert!(
            connections
                .iter()
                .any(|connection| connection[2] == "git-receive-pack"),
            "{connections:?}"
        );
        for connection in &connections {
            assert_eq!(
                (connection[0].as_str(), connection[1].as_str()),
                (USER_HOST, port),
                "{connections:?}"
            );
        }
    }
}

#[tokio::test]
async fn several_push_urls_or_an_unconfirmed_to_line_stay_a_configuration_refusal() {
    let (f, cli) = Fixture::new(None);
    let (root, remote) = f.root(|path| format!("ssh://{USER_HOST}{}", path.display()));
    let before = f.git(&remote, &["rev-parse", "main"]);
    for push_url in [
        format!("ssh://{USER_HOST}{}", remote.display()),
        format!("{USER_HOST}:{}", remote.display()),
    ] {
        f.git(
            &root,
            &["remote", "set-url", "--add", "--push", "origin", &push_url],
        );
    }
    configuration(push(&cli, &root, false).await.unwrap_err());
    assert_eq!(f.git(&remote, &["rev-parse", "main"]), before);

    for to in [
        "s#fixture.invalid#other.invalid#",
        // The configured URL itself, which Git never prints with its user.
        "s#ssh://#ssh://user@#",
    ] {
        let (f, cli) = Fixture::new(Some(to));
        let (root, remote) = f.root(|path| format!("ssh://{USER_HOST}{}", path.display()));
        let before = f.git(&remote, &["rev-parse", "main"]);
        configuration(push(&cli, &root, false).await.unwrap_err());
        assert_eq!(f.git(&remote, &["rev-parse", "main"]), before, "{to}");
    }
}
