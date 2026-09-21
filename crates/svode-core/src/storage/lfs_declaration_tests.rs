use std::path::Path;
use std::process::{Command, Output};

use super::config::AssetsStrategy;
use super::lfs_declaration::{
    LFS_DECLARATION_URL, LfsDeclarationState, LfsDeclarationWrite, apply_lfs_declaration,
    declared_lfs_url, lfs_declaration_state, rewrite_lfs_declaration,
};
use crate::git::cli::GitCli;

const DECLARATION: &str = "[lfs]\n\turl = https://lfs-s3.svode.invalid/\n";
const USER_CONFIG: &str = "# team settings\n[lfs]\n\tfetchexclude = archive/**\n; keep\n[lfs \"https://example.test/\"]\n\taccess = basic\n";

#[test]
fn declaration_is_appended_once_and_removed_to_the_exact_original() {
    let (written, outcome) = rewrite_lfs_declaration("", true);
    assert_eq!(outcome, LfsDeclarationWrite::Written);
    assert_eq!(written, DECLARATION);
    assert_eq!(
        declared_lfs_url(&written).as_deref(),
        Some(LFS_DECLARATION_URL)
    );
    assert_eq!(
        rewrite_lfs_declaration(&written, true),
        (written.clone(), LfsDeclarationWrite::Unchanged)
    );
    assert_eq!(
        rewrite_lfs_declaration(&written, false),
        (String::new(), LfsDeclarationWrite::Removed)
    );

    let (declared, outcome) = rewrite_lfs_declaration(USER_CONFIG, true);
    assert_eq!(outcome, LfsDeclarationWrite::Written);
    assert!(declared.starts_with(USER_CONFIG));
    assert_eq!(
        rewrite_lfs_declaration(&declared, false),
        (USER_CONFIG.to_string(), LfsDeclarationWrite::Removed)
    );
}

#[test]
fn user_lfs_url_is_foreign_and_never_rewritten() {
    for foreign in [
        "[lfs]\n\turl = https://lfs.example.test/repo\n",
        "[LFS]\n  URL=\"https://lfs.example.test/\" # team\n",
        // Git reads the last value: a later user value overrides ours.
        "[lfs]\n\turl = https://lfs-s3.svode.invalid/\n[lfs]\n\turl = https://other.test/\n",
    ] {
        assert_eq!(
            rewrite_lfs_declaration(foreign, true),
            (foreign.to_string(), LfsDeclarationWrite::Foreign)
        );
    }
    let foreign = "[lfs]\n\turl = https://lfs.example.test/repo\n";
    assert_eq!(
        rewrite_lfs_declaration(foreign, false),
        (foreign.to_string(), LfsDeclarationWrite::Unchanged)
    );
}

#[test]
fn quoted_and_commented_declaration_is_recognized_and_removal_keeps_user_keys() {
    let contents =
        "[lfs]\n\tfetchexclude = archive/**\n\turl = \"https://lfs-s3.svode.invalid/\" ; svode\n";
    assert_eq!(
        declared_lfs_url(contents).as_deref(),
        Some(LFS_DECLARATION_URL)
    );
    assert_eq!(
        rewrite_lfs_declaration(contents, true).1,
        LfsDeclarationWrite::Unchanged
    );
    assert_eq!(
        rewrite_lfs_declaration(contents, false),
        (
            "[lfs]\n\tfetchexclude = archive/**\n".to_string(),
            LfsDeclarationWrite::Removed
        )
    );
    // A subsection key is a different setting, not `lfs.url`.
    assert_eq!(
        declared_lfs_url("[lfs \"https://x.test/\"]\n\turl = https://lfs-s3.svode.invalid/\n"),
        None
    );
}

#[test]
fn apply_writes_only_on_change_and_removes_an_emptied_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join(".lfsconfig");

    assert_eq!(
        apply_lfs_declaration(temp.path(), AssetsStrategy::InGit).unwrap(),
        LfsDeclarationWrite::Unchanged
    );
    assert!(!path.exists());
    assert_eq!(
        apply_lfs_declaration(temp.path(), AssetsStrategy::LfsS3).unwrap(),
        LfsDeclarationWrite::Written
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), DECLARATION);
    assert_eq!(
        apply_lfs_declaration(temp.path(), AssetsStrategy::LfsS3).unwrap(),
        LfsDeclarationWrite::Unchanged
    );
    for strategy in [AssetsStrategy::LfsRemote, AssetsStrategy::Local] {
        std::fs::write(&path, DECLARATION).unwrap();
        assert_eq!(
            apply_lfs_declaration(temp.path(), strategy).unwrap(),
            LfsDeclarationWrite::Removed
        );
        assert!(!path.exists());
    }

    std::fs::write(&path, USER_CONFIG).unwrap();
    apply_lfs_declaration(temp.path(), AssetsStrategy::LfsS3).unwrap();
    apply_lfs_declaration(temp.path(), AssetsStrategy::InGit).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), USER_CONFIG);
}

#[tokio::test]
async fn state_distinguishes_missing_pending_published_and_foreign() {
    let Some(git) = TestGit::detect() else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    git.init(repo);
    let cli = git.cli();

    assert_eq!(
        lfs_declaration_state(&cli, repo).await.unwrap(),
        LfsDeclarationState::Missing
    );
    apply_lfs_declaration(repo, AssetsStrategy::LfsS3).unwrap();
    assert_eq!(
        lfs_declaration_state(&cli, repo).await.unwrap(),
        LfsDeclarationState::Pending
    );
    git.ok(repo, &["add", ".lfsconfig"]);
    git.ok(repo, &["commit", "-m", "Declare"]);
    assert_eq!(
        lfs_declaration_state(&cli, repo).await.unwrap(),
        LfsDeclarationState::Published
    );
    std::fs::write(
        repo.join(".lfsconfig"),
        "[lfs]\n\turl = https://lfs.example.test/\n",
    )
    .unwrap();
    assert_eq!(
        lfs_declaration_state(&cli, repo).await.unwrap(),
        LfsDeclarationState::Foreign
    );
}

/// Process regression with real git-lfs and a local stand-in for the S3 agent:
/// the declaration does not disturb the agent, and a client without the agent
/// fails before the remote ref moves instead of uploading to the provider.
#[test]
fn real_git_lfs_uses_agent_with_declaration_and_rejects_client_without_agent() {
    let Some(git) = TestGit::detect() else {
        return;
    };
    if !git.cli().lfs_available() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let remote = root.join("remote.git");
    let store = root.join("store");
    let agent = root.join("agent.sh");
    std::fs::create_dir(&store).unwrap();
    write_test_agent(&agent);
    git.ok(
        root,
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );

    let author = root.join("author");
    std::fs::create_dir(&author).unwrap();
    git.init(&author);
    git.ok(&author, &["lfs", "install", "--local"]);
    git.wire_agent(&author, &agent, &store);
    std::fs::write(
        author.join(".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    apply_lfs_declaration(&author, AssetsStrategy::LfsS3).unwrap();
    std::fs::write(author.join("blob.bin"), b"agent-owned bytes\n").unwrap();
    git.ok(&author, &["add", "."]);
    git.ok(&author, &["commit", "-m", "Declared LFS"]);
    git.ok(
        &author,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git.ok(&author, &["push", "origin", "HEAD:main"]);
    assert_eq!(std::fs::read_dir(&store).unwrap().count(), 1);

    let reader = root.join("reader");
    git.ok_env(
        root,
        &["clone", remote.to_str().unwrap(), reader.to_str().unwrap()],
        &[("GIT_LFS_SKIP_SMUDGE", "1")],
    );
    git.ok(&reader, &["lfs", "install", "--local"]);
    git.wire_agent(&reader, &agent, &store);
    git.ok(&reader, &["lfs", "pull"]);
    assert_eq!(
        std::fs::read(reader.join("blob.bin")).unwrap(),
        b"agent-owned bytes\n"
    );

    let outsider = root.join("outsider");
    git.ok_env(
        root,
        &[
            "clone",
            remote.to_str().unwrap(),
            outsider.to_str().unwrap(),
        ],
        &[("GIT_LFS_SKIP_SMUDGE", "1")],
    );
    git.ok(&outsider, &["lfs", "install", "--local"]);
    git.identity(&outsider);
    std::fs::write(outsider.join("other.bin"), b"outsider bytes\n").unwrap();
    git.ok(&outsider, &["add", "other.bin"]);
    git.ok(&outsider, &["commit", "-m", "Outsider"]);
    let before = git.stdout(&remote, &["rev-parse", "main"]);
    let push = git.run(&outsider, &["push", "origin", "HEAD:main"], &[]);
    assert!(!push.status.success());
    assert!(String::from_utf8_lossy(&push.stderr).contains("lfs-s3.svode.invalid"));
    assert_eq!(git.stdout(&remote, &["rev-parse", "main"]), before);
    assert_eq!(std::fs::read_dir(&store).unwrap().count(), 1);
}

fn write_test_agent(path: &Path) {
    std::fs::write(
        path,
        r#"#!/bin/sh
store="$1"
while IFS= read -r line; do
  oid=$(printf '%s' "$line" | sed -n 's/.*"oid":"\([0-9a-f]*\)".*/\1/p')
  case "$line" in
    *'"event":"init"'*) printf '{}\n' ;;
    *'"event":"upload"'*)
      src=$(printf '%s' "$line" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')
      cp "$src" "$store/$oid"
      printf '{"event":"complete","oid":"%s"}\n' "$oid" ;;
    *'"event":"download"'*)
      cp "$store/$oid" "$store/../download-$oid"
      printf '{"event":"complete","oid":"%s","path":"%s"}\n' "$oid" "$store/../download-$oid" ;;
    *'"event":"terminate"'*) exit 0 ;;
  esac
done
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Git runner isolated from the developer's global and system config.
struct TestGit {
    cli: GitCli,
}

impl TestGit {
    fn detect() -> Option<Self> {
        GitCli::detect().ok().map(|cli| Self { cli })
    }

    fn cli(&self) -> GitCli {
        self.cli.clone()
    }

    fn run(&self, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
        let mut command = Command::new(self.cli.git_path());
        command
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        for (key, value) in env {
            command.env(key, value);
        }
        command.output().unwrap()
    }

    fn ok_env(&self, dir: &Path, args: &[&str], env: &[(&str, &str)]) {
        let output = self.run(dir, args, env);
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn ok(&self, dir: &Path, args: &[&str]) {
        self.ok_env(dir, args, &[]);
    }

    fn stdout(&self, dir: &Path, args: &[&str]) -> String {
        let output = self.run(dir, args, &[]);
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn identity(&self, repo: &Path) {
        self.ok(repo, &["config", "user.name", "Test"]);
        self.ok(repo, &["config", "user.email", "test@example.test"]);
        self.ok(repo, &["config", "commit.gpgsign", "false"]);
    }

    fn init(&self, repo: &Path) {
        self.ok(repo, &["init", "-b", "main"]);
        self.identity(repo);
    }

    fn wire_agent(&self, repo: &Path, agent: &Path, store: &Path) {
        for (key, value) in [
            ("lfs.standalonetransferagent", "fixture"),
            ("lfs.customtransfer.fixture.path", agent.to_str().unwrap()),
            ("lfs.customtransfer.fixture.args", store.to_str().unwrap()),
            ("lfs.customtransfer.fixture.concurrent", "false"),
        ] {
            self.ok(repo, &["config", "--local", key, value]);
        }
    }
}
