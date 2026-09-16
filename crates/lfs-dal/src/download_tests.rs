use super::*;

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

#[test]
fn real_git_layouts_preserve_metadata_and_keep_independent_handoffs() {
    let root = tempfile::tempdir().unwrap();
    let ordinary = root.path().join("обычный repo");
    std::fs::create_dir(&ordinary).unwrap();
    git(&ordinary, &["init"]);
    std::fs::write(ordinary.join("tracked"), b"original").unwrap();
    git(&ordinary, &["add", "tracked"]);
    git(&ordinary, &["commit", "-m", "fixture"]);
    let parent = root.path().join("parent");
    std::fs::create_dir(&parent).unwrap();
    git(&parent, &["init"]);
    git(
        &parent,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            ordinary.to_str().unwrap(),
            "пространство space",
        ],
    );
    let submodule = parent.join("пространство space");
    let linked = root.path().join("linked worktree");
    git(
        &ordinary,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    assert!(submodule.join(".git").is_file());
    assert!(linked.join(".git").is_file());
    for repo in [ordinary, submodule, linked] {
        let git_dir = PathBuf::from(git(&repo, &["rev-parse", "--absolute-git-dir"]));
        let head = std::fs::read(git_dir.join("HEAD")).unwrap();
        let index = std::fs::read(git_dir.join("index")).unwrap();
        let gitfile = std::fs::read(repo.join(".git")).ok();
        let paths = std::thread::scope(|scope| {
            (0..8)
                .map(|_| scope.spawn(|| stage(&repo, b"same OID bytes".as_slice()).unwrap()))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|task| task.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            paths.iter().collect::<std::collections::HashSet<_>>().len(),
            8
        );
        for path in &paths {
            assert!(Path::new(path).is_absolute());
            assert!(Path::new(path).starts_with(git_dir.join("lfs/tmp/lfs-dal")));
            assert_eq!(std::fs::read(path).unwrap(), b"same OID bytes");
        }
        assert_eq!(std::fs::read(git_dir.join("HEAD")).unwrap(), head);
        assert_eq!(std::fs::read(git_dir.join("index")).unwrap(), index);
        assert_eq!(std::fs::read(repo.join(".git")).ok(), gitfile);
        assert!(git(&repo, &["ls-files", "--others", "--exclude-standard"]).is_empty());
    }
}

#[test]
fn failed_resolution_creation_and_partial_copy_allow_retry() {
    let repo = tempfile::tempdir().unwrap();
    assert!(stage(repo.path(), b"blob".as_slice()).is_err());
    assert_eq!(std::fs::read_dir(repo.path()).unwrap().count(), 0);
    git(repo.path(), &["init"]);
    let directory = temporary_directory(repo.path()).unwrap();
    std::fs::create_dir_all(directory.parent().unwrap()).unwrap();
    std::fs::write(&directory, b"obstruction").unwrap();
    assert!(stage(repo.path(), b"blob".as_slice()).is_err());
    assert_eq!(std::fs::read(&directory).unwrap(), b"obstruction");
    std::fs::remove_file(&directory).unwrap();
    let handed_off = stage(repo.path(), b"keep me".as_slice()).unwrap();
    struct Partial(bool);
    impl Read for Partial {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("injected partial-copy failure"));
            }
            self.0 = true;
            buf[0] = b'x';
            Ok(1)
        }
    }
    assert!(stage(repo.path(), Partial(false)).is_err());
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    assert_eq!(std::fs::read(handed_off).unwrap(), b"keep me");
    let retried = stage(repo.path(), b"retry".as_slice()).unwrap();
    assert_eq!(std::fs::read(retried).unwrap(), b"retry");
}
