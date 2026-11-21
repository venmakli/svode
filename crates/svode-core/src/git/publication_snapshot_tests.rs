//! The URL Git prints in the `To` line of a push report (DF-379 R1), from
//! Git's `transport_anonymize_url` and `url_is_local_not_ssh`.

use super::{anonymized_url, drive_path};

#[test]
fn the_user_part_leaves_url_and_scp_forms_of_every_scheme() {
    for (url, reported) in [
        ("ssh://user@host:2222/p", "ssh://host:2222/p"),
        ("ssh://user@host/p", "ssh://host/p"),
        ("git@host:org/r.git", "host:org/r.git"),
        ("user@host:/srv/r.git", "host:/srv/r.git"),
        ("https://user:token@host/r.git", "https://host/r.git"),
        ("https://user@host/r.git", "https://host/r.git"),
        ("git+ssh://user@host/p", "git+ssh://host/p"),
        // Git cuts at the first `@`.
        ("https://user:p@ss@host/r.git", "https://ss@host/r.git"),
    ] {
        assert_eq!(anonymized_url(url), reported, "{url}");
    }
}

#[test]
fn urls_without_a_user_part_stay_as_configured() {
    for url in [
        "ssh://host:2222/p",
        "host:org/r.git",
        "https://host/r.git",
        // An `@` past the first slash after the scheme is part of the path.
        "ssh://host/a@b",
        // In the scp form a user part needs a colon after the `@`.
        "host:a@b",
        "user@host",
        // A scheme with a character outside letters, digits and `+.-`.
        "s_sh://user@host/p",
        // Local paths, including a relative one and a slash before the colon.
        "/home/a@b/repo",
        "../a@b/repo.git",
        "./a@b:c/repo",
        "file:///home/a@b/repo",
        "C:/a@b/repo",
        "C:\\a@b\\repo",
    ] {
        assert_eq!(anonymized_url(url), url, "{url}");
    }
}

#[test]
fn a_windows_drive_path_is_local_only_on_windows() {
    // Git for Windows reads a drive prefix as a local path; Git elsewhere
    // reads the same text as a URL with the scheme `C`.
    let expected = if cfg!(windows) {
        "C://a@b/repo"
    } else {
        "C://b/repo"
    };
    assert_eq!(anonymized_url("C://a@b/repo"), expected);
    assert!(drive_path("C:/a@b/repo"));
    assert!(drive_path("ä:/repo"));
    assert!(!drive_path("C:/a:b/repo"));
    assert!(!drive_path("C:/a?b/repo"));
    assert!(!drive_path("host:repo") && !drive_path("C"));
}
