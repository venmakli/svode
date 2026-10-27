use super::{DEFAULT_MARKER_SIZE, has_marker_lines, parse_marker_size};

#[test]
fn attribute_values_other_than_a_positive_integer_give_the_default() {
    assert_eq!(parse_marker_size("10"), 10);
    assert_eq!(parse_marker_size("3"), 3);
    assert_eq!(parse_marker_size("+5"), 5);
    for value in [
        "unspecified",
        "set",
        "unset",
        "",
        "abc",
        "12x",
        "0",
        "-3",
        "99999999999",
    ] {
        assert_eq!(parse_marker_size(value), DEFAULT_MARKER_SIZE, "{value:?}");
    }
}

#[test]
fn marker_lines_are_runs_of_the_size_followed_by_a_label_or_the_line_end() {
    for ending in ["\n", "\r\n"] {
        for marker in [
            "<<<<<<< HEAD",
            "<<<<<<< ",
            "||||||| base",
            "|||||||",
            ">>>>>>> theirs",
        ] {
            let content = ["text", marker, "more", ""].join(ending);
            assert!(has_marker_lines(content.as_bytes(), 7), "{content:?}");
        }
        for line in [
            "=======",
            "<<<<<<<",
            ">>>>>>>",
            "<<<<<<<x",
            "<<<<<<<< HEAD",
            "<<<<<< HEAD",
            "||||||||",
            "|||||||x",
            "> quote",
            "x <<<<<<< HEAD",
            " <<<<<<< HEAD",
        ] {
            let content = ["text", line, "more", ""].join(ending);
            assert!(!has_marker_lines(content.as_bytes(), 7), "{content:?}");
        }
    }
    // Other sizes.
    assert!(has_marker_lines(b"<<<<<<<<<< HEAD\n", 10));
    assert!(!has_marker_lines(b"<<<<<<< HEAD\n", 10));
    assert!(has_marker_lines(b"a\n||| b\n", 3));
    assert!(!has_marker_lines(
        b"<<<<<<< HEAD\n||||||| b\n>>>>>>> c\n",
        3
    ));
    // The last line needs no ending; a `\r` without `\n` stays in the line.
    assert!(has_marker_lines(b"a\n>>>>>>> theirs", 7));
    assert!(has_marker_lines(b"a\r\n|||||||", 7));
    assert!(!has_marker_lines(b"a\r\n|||||||\r", 7));
}

#[cfg(unix)]
mod repository {
    use super::super::{DEFAULT_MARKER_SIZE, marker_size};
    use crate::git::cli::GitCli;
    use std::path::Path;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Git that never looks for a repository above `temp`.
    fn test_cli(temp: &Path) -> GitCli {
        let wrapper = temp.join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            &format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES='{}'\nexec git \"$@\"\n",
                temp.display()
            ),
        )
        .unwrap();
        GitCli::for_test(wrapper)
    }

    #[tokio::test]
    async fn marker_size_reads_the_attribute_of_the_path_in_its_repository() {
        let temp = tempfile::tempdir().unwrap();
        let cli = test_cli(temp.path());
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join("docs/nested")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(
            repo.join(".gitattributes"),
            "*.md conflict-marker-size=10\nsmall.md conflict-marker-size=3\nbad.md conflict-marker-size=12x\nzero.md conflict-marker-size=0\nset.md conflict-marker-size\n",
        )
        .unwrap();
        std::fs::write(repo.join("other.txt"), "").unwrap();

        for (path, size) in [
            ("docs/plan.md", 10),
            ("small.md", 3),
            ("bad.md", DEFAULT_MARKER_SIZE),
            ("zero.md", DEFAULT_MARKER_SIZE),
            ("set.md", DEFAULT_MARKER_SIZE),
            ("other.txt", DEFAULT_MARKER_SIZE),
            // The attribute applies to a path whether or not the file exists.
            ("docs/nested/new page.md", 10),
        ] {
            assert_eq!(
                marker_size(&cli, &repo.join(path)).await.unwrap(),
                size,
                "{path}"
            );
        }

        // A nested repository answers with its own attributes.
        let nested = repo.join("docs/nested");
        git(&nested, &["init", "-q", "-b", "main"]);
        assert_eq!(
            marker_size(&cli, &nested.join("page.md")).await.unwrap(),
            DEFAULT_MARKER_SIZE
        );
        std::fs::write(
            nested.join(".gitattributes"),
            "*.md conflict-marker-size=12\n",
        )
        .unwrap();
        assert_eq!(
            marker_size(&cli, &nested.join("page.md")).await.unwrap(),
            12
        );

        // A path outside any repository gets the default.
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            marker_size(&cli, &outside.join("page.md")).await.unwrap(),
            DEFAULT_MARKER_SIZE
        );
    }
}
