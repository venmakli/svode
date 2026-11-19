//! `svode secret` and the Secret part of `svode doctor` through real
//! processes in a temporary home. The system password store of the user is
//! never touched: every test that reads or writes values runs with the
//! secrets file active, and the refusal of an unavailable system store runs
//! only where it can be forced without one (Linux without a D-Bus session).

mod common;

#[cfg(windows)]
#[test]
fn the_secrets_file_cannot_be_turned_on_on_windows() {
    // The refusal comes before any write, so the real config directory of
    // the user stays untouched.
    let output = std::process::Command::new(common::process::BIN)
        .args(["secret", "store", "use", "file", "--json"])
        .env("SVODE_PRODUCT_IDENTIFIER", common::process::TEST_IDENTIFIER)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(common::process::code(&value), "SECRET_FILE_UNSUPPORTED");
    assert!(value["error"]["hint"].is_string(), "{value}");
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};

    use serde_json::{Value, json};

    use super::common::process::{BIN, ROUTINE_CALLER_TOKEN, TEST_IDENTIFIER, code};

    /// Values the tests set; none may appear in any output.
    const VALUES: [&str; 4] = [
        "synthetic-secret-alpha",
        "synthetic-secret-beta",
        "synthetic-secret-gamma",
        "synthetic-secret-env",
    ];

    struct Device {
        _dir: tempfile::TempDir,
        home: PathBuf,
    }

    impl Device {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path().canonicalize().unwrap().join("home");
            fs::create_dir_all(&home).unwrap();
            Self { _dir: dir, home }
        }

        fn config(&self) -> PathBuf {
            let base = if cfg!(target_os = "macos") {
                self.home.join("Library/Application Support")
            } else {
                self.home.join(".config")
            };
            base.join(TEST_IDENTIFIER)
        }

        fn file(&self) -> PathBuf {
            self.config().join("secrets.json")
        }

        fn command(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Command {
            let mut command = Command::new(BIN);
            command
                .args(args)
                .current_dir(cwd)
                .env("HOME", &self.home)
                .env_remove("XDG_CONFIG_HOME")
                .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("RUST_LOG", "trace")
                .env_remove(ROUTINE_CALLER_TOKEN);
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("SVODE_SECRET_") {
                    command.env_remove(key);
                }
            }
            command.envs(env.iter().copied());
            command
        }

        /// Runs `svode` with `stdin` (none means no input) and checks that
        /// no test value appears in its arguments, stdout or stderr, which
        /// carries the trace log too.
        fn run(
            &self,
            cwd: &Path,
            args: &[&str],
            stdin: Option<&[u8]>,
            env: &[(&str, &str)],
        ) -> Output {
            for arg in args {
                assert!(!VALUES.iter().any(|value| arg.contains(value)));
            }
            let mut child = self
                .command(cwd, args, env)
                .stdin(if stdin.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            if let Some(stdin) = stdin {
                child.stdin.take().unwrap().write_all(stdin).unwrap();
            }
            let output = child.wait_with_output().unwrap();
            for stream in [&output.stdout, &output.stderr] {
                let text = String::from_utf8_lossy(stream);
                for value in VALUES {
                    assert!(!text.contains(value), "{args:?} printed a value: {text}");
                }
            }
            output
        }

        fn json(&self, cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> (i32, Value) {
            self.json_with(cwd, args, stdin, &[])
        }

        fn json_with(
            &self,
            cwd: &Path,
            args: &[&str],
            stdin: Option<&[u8]>,
            env: &[(&str, &str)],
        ) -> (i32, Value) {
            let mut full = args.to_vec();
            full.push("--json");
            let output = self.run(cwd, &full, stdin, env);
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert_eq!(stdout.lines().count(), 1, "{args:?}: {stdout}");
            (
                output.status.code().unwrap(),
                serde_json::from_str(&stdout).unwrap(),
            )
        }

        fn ok(&self, cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Value {
            let (exit, value) = self.json(cwd, args, stdin);
            assert_eq!((exit, &value["ok"]), (0, &json!(true)), "{args:?}: {value}");
            value
        }

        /// Values of the secrets file by account.
        fn stored(&self) -> serde_json::Map<String, Value> {
            let file: Value = serde_json::from_slice(&fs::read(self.file()).unwrap()).unwrap();
            file["values"].as_object().unwrap().clone()
        }
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn has_git() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    fn secrets(list: &Value) -> Vec<(String, String, bool)> {
        list["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["name"].as_str().unwrap().to_string(),
                    entry["mode"].as_str().unwrap().to_string(),
                    entry["hasValue"].as_bool().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn turning_the_file_on_creates_a_private_file_and_never_moves_values() {
        let device = Device::new();
        let home = device.home.clone();
        let value = device.ok(&home, &["secret", "store", "use", "file"], None);
        assert_eq!(value["created"], true);
        assert_eq!(value["valuesMoved"], false);
        assert_eq!(value["store"]["kind"], "file");
        assert_eq!(value["store"]["file"], device.file().display().to_string());
        assert_eq!(mode(&device.file()), 0o600);
        assert_eq!(mode(&device.config()), 0o700);
        let bytes = fs::read(device.file()).unwrap();
        let modified = fs::metadata(device.file()).unwrap().modified().unwrap();

        // A repeat changes nothing and says so.
        let output = device.run(&home, &["secret", "store", "use", "file"], None, &[]);
        assert!(output.status.success());
        let human = String::from_utf8(output.stdout).unwrap();
        assert!(
            human.contains("already the active store with 0 values"),
            "{human}"
        );
        assert_eq!(fs::read(device.file()).unwrap(), bytes);
        assert_eq!(
            fs::metadata(device.file()).unwrap().modified().unwrap(),
            modified
        );

        // The first switch tells that values were not moved.
        let other = Device::new();
        let output = other.run(&other.home, &["secret", "store", "use", "file"], None, &[]);
        let human = String::from_utf8(output.stdout).unwrap();
        assert!(human.contains("Values were not moved"), "{human}");

        let status = device.ok(&home, &["secret", "store", "status"], None);
        assert_eq!(
            status["store"],
            json!({
                "kind": "file",
                "file": device.file().display().to_string(),
                "available": true,
                "problem": null,
                "values": 0,
            })
        );
    }

    #[test]
    fn device_values_come_from_stdin_and_never_appear_in_output() {
        let device = Device::new();
        let home = device.home.clone();
        device.ok(&home, &["secret", "store", "use", "file"], None);

        let set = device.ok(
            &home,
            &["secret", "set", "TOKEN"],
            Some(format!("{}\n", VALUES[0]).as_bytes()),
        );
        assert_eq!(set["owner"], "device");
        assert_eq!(set["mode"], "local");
        assert_eq!(set["created"], true);
        assert_eq!(set["store"]["kind"], "file");
        let stored = device.stored();
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored.values().next().unwrap(),
            VALUES[0],
            "one line break is dropped"
        );
        let settings = fs::read_to_string(device.config().join("settings.json")).unwrap();
        assert!(!settings.contains("synthetic"), "{settings}");
        assert_eq!(mode(&device.file()), 0o600);

        // Only one trailing line break is dropped; the rest of the value stays.
        let human = device.run(
            &home,
            &["secret", "set", "TOKEN"],
            Some(format!("  {}\r\n\n", VALUES[1]).as_bytes()),
            &[],
        );
        assert!(human.status.success(), "{human:?}");
        let stdout = String::from_utf8(human.stdout).unwrap();
        assert!(
            stdout.contains("Set the local device Secret TOKEN in the secrets file"),
            "{stdout}"
        );
        let stored = device.stored();
        assert_eq!(stored.len(), 1, "the replaced value is removed");
        assert_eq!(
            stored.values().next().unwrap(),
            &format!("  {}\r\n", VALUES[1])
        );

        let list = device.ok(&home, &["secret", "list"], None);
        assert_eq!(secrets(&list), [("TOKEN".into(), "local".into(), true)]);
        let human = device.run(&home, &["secret", "list"], None, &[]);
        assert_eq!(
            String::from_utf8(human.stdout).unwrap(),
            "TOKEN local set\n"
        );

        // Input failures exit 2 before anything is written.
        let before = fs::read(device.file()).unwrap();
        for (stdin, expected) in [
            (None, "INVALID_ARGUMENT"),
            (Some(&b"\n"[..]), "INVALID_ARGUMENT"),
            (Some(&b"\xff\xfe\n"[..]), "INPUT_UNREADABLE"),
        ] {
            let (exit, value) = device.json(&home, &["secret", "set", "OTHER"], stdin);
            assert_eq!((exit, code(&value)), (2, expected), "{value}");
        }
        let (exit, value) = device.json(&home, &["secret", "set", "not-a-name"], Some(b"x"));
        assert_eq!((exit, code(&value)), (2, "INVALID_ARGUMENT"), "{value}");
        assert_eq!(fs::read(device.file()).unwrap(), before);

        let removed = device.ok(&home, &["secret", "remove", "TOKEN"], None);
        assert_eq!(removed["removedDeclaration"], true);
        assert_eq!(removed["removedValue"], true);
        assert!(device.stored().is_empty());
        let list = device.ok(&home, &["secret", "list"], None);
        assert!(secrets(&list).is_empty());
    }

    #[test]
    fn parallel_sets_lose_no_value() {
        let device = Device::new();
        let home = device.home.clone();
        device.ok(&home, &["secret", "store", "use", "file"], None);
        let children = (0..8)
            .map(|index| {
                let mut child = device
                    .command(
                        &home,
                        &["secret", "set", &format!("NAME_{index}"), "--json"],
                        &[],
                    )
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(format!("value-{index}").as_bytes())
                    .unwrap();
                child
            })
            .collect::<Vec<_>>();
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        let list = device.ok(&home, &["secret", "list"], None);
        assert_eq!(secrets(&list).len(), 8);
        assert!(secrets(&list).iter().all(|(_, _, set)| *set));
        let mut stored = device
            .stored()
            .into_iter()
            .map(|(_, v)| v)
            .collect::<Vec<_>>();
        stored.sort_by_key(|value| value.to_string());
        assert_eq!(
            stored,
            (0..8)
                .map(|index| json!(format!("value-{index}")))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn project_and_space_owners_keep_git_declarations_and_change_no_files_under_git() {
        let device = Device::new();
        let home = device.home.clone();
        device.ok(&home, &["secret", "store", "use", "file"], None);
        device.ok(
            &home,
            &["project", "create", "acme", "--name", "Acme"],
            None,
        );
        let project = home.join("acme");
        let config = project.join(".svode/config.json");
        let mut portable: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        portable["variables"] = json!({ "S3_KEY": { "kind": "secret" } });
        fs::write(&config, serde_json::to_vec_pretty(&portable).unwrap()).unwrap();
        let git_available = has_git() && project.join(".git").exists();
        if git_available {
            git(&project, &["add", "-A"]);
            git(&project, &["commit", "-qm", "init"]);
        }
        let config_bytes = fs::read(&config).unwrap();

        let list = device.ok(&project, &["secret", "list", "--owner", "project"], None);
        assert_eq!(list["target"]["spaceId"], "root");
        assert_eq!(secrets(&list), [("S3_KEY".into(), "git".into(), false)]);

        // The value of a Git Secret from the environment counts as set and
        // is never stored.
        let (exit, list) = device.json_with(
            &project,
            &["secret", "list", "--owner", "project"],
            None,
            &[("SVODE_SECRET_S3_KEY", VALUES[3])],
        );
        assert_eq!(exit, 0);
        assert_eq!(secrets(&list), [("S3_KEY".into(), "git".into(), true)]);
        assert!(device.stored().is_empty());

        let set = device.ok(
            &project,
            &["secret", "set", "S3_KEY", "--owner", "project"],
            Some(VALUES[0].as_bytes()),
        );
        assert_eq!(
            (&set["mode"], &set["created"]),
            (&json!("git"), &json!(false))
        );
        let set = device.ok(
            &project,
            &["secret", "set", "LOCAL_KEY", "--owner", "project"],
            Some(VALUES[1].as_bytes()),
        );
        assert_eq!(
            (&set["mode"], &set["created"]),
            (&json!("local"), &json!(true))
        );
        assert_eq!(
            fs::read(&config).unwrap(),
            config_bytes,
            "files under Git stay"
        );
        if git_available {
            assert_eq!(git(&project, &["status", "--porcelain"]), "");
        }
        let list = device.ok(&project, &["secret", "list", "--owner", "project"], None);
        assert_eq!(
            secrets(&list),
            [
                ("S3_KEY".into(), "git".into(), true),
                ("LOCAL_KEY".into(), "local".into(), true)
            ]
        );
        // Device and project owners are separate.
        assert!(secrets(&device.ok(&project, &["secret", "list"], None)).is_empty());

        // A child Space is its own owner; its root Space is the Project.
        let created = device.ok(
            &project,
            &["space", "create", "wiki", "--name", "Wiki"],
            None,
        );
        let wiki = project.join("wiki");
        if git_available {
            git(&project, &["add", "-A"]);
            git(&project, &["commit", "-qm", "space"]);
        }
        let config_bytes = fs::read(&config).unwrap();
        let mut portable: Value = serde_json::from_slice(&config_bytes).unwrap();
        device.ok(
            &wiki,
            &["secret", "set", "WIKI_KEY", "--owner", "space"],
            Some(VALUES[2].as_bytes()),
        );
        let list = device.ok(&wiki, &["secret", "list", "--owner", "space"], None);
        assert_eq!(list["target"]["spaceId"], created["space"]["id"]);
        assert_eq!(secrets(&list), [("WIKI_KEY".into(), "local".into(), true)]);
        let root_space = device.ok(&project, &["secret", "list", "--owner", "space"], None);
        assert_eq!(
            secrets(&root_space),
            secrets(&device.ok(&project, &["secret", "list", "--owner", "project"], None))
        );

        // Removing keeps the Git declaration and drops only the device value.
        let removed = device.ok(
            &project,
            &["secret", "remove", "S3_KEY", "--owner", "project"],
            None,
        );
        assert_eq!(removed["removedDeclaration"], false);
        assert_eq!(removed["removedValue"], true);
        let human = device.run(
            &project,
            &["secret", "remove", "S3_KEY", "--owner", "project"],
            None,
            &[],
        );
        assert!(
            String::from_utf8(human.stdout)
                .unwrap()
                .contains("has no value on this device; its declaration in Git stays"),
        );
        assert_eq!(fs::read(&config).unwrap(), config_bytes);
        let list = device.ok(&project, &["secret", "list", "--owner", "project"], None);
        assert_eq!(
            secrets(&list),
            [
                ("S3_KEY".into(), "git".into(), false),
                ("LOCAL_KEY".into(), "local".into(), true)
            ]
        );
        assert_eq!(device.stored().len(), 2);
        if git_available {
            assert_eq!(
                git(&project, &["status", "--porcelain", "--", ".svode"]),
                ""
            );
        }

        // A Variable of the same name is not turned into a Secret.
        portable["variables"]["PLAIN"] = json!({ "kind": "variable", "value": "v" });
        fs::write(&config, serde_json::to_vec_pretty(&portable).unwrap()).unwrap();
        let (exit, value) = device.json(
            &project,
            &["secret", "set", "PLAIN", "--owner", "project"],
            Some(b"x"),
        );
        assert_eq!((exit, code(&value)), (1, "VARIABLES_ERROR"), "{value}");
        assert_eq!(value["error"]["reason"], "wrong_kind");
    }

    #[test]
    fn refusals_name_their_code_and_next_step_and_change_nothing() {
        let device = Device::new();
        let home = device.home.clone();
        let file = device.file();
        let shown = file.display().to_string();
        device.ok(&home, &["secret", "store", "use", "file"], None);
        device.ok(
            &home,
            &["secret", "set", "TOKEN"],
            Some(VALUES[0].as_bytes()),
        );
        let settings = device.config().join("settings.json");
        let settings_bytes = fs::read(&settings).unwrap();

        // SECRET_NOT_FOUND
        let (exit, value) = device.json(&home, &["secret", "remove", "MISSING"], None);
        assert_eq!((exit, code(&value)), (1, "SECRET_NOT_FOUND"), "{value}");
        assert_eq!(value["error"]["hint"], "run `svode secret set MISSING`");
        let output = device.run(&home, &["secret", "remove", "MISSING"], None, &[]);
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("error[SECRET_NOT_FOUND]"), "{stderr}");
        assert!(
            stderr.contains("hint: run `svode secret set MISSING`"),
            "{stderr}"
        );

        // SECRET_FILE_UNSAFE: group or other access, then a symbolic link.
        let bytes = fs::read(&file).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        for args in [
            &["secret", "set", "OTHER"][..],
            &["secret", "list"][..],
            &["secret", "store", "use", "file"][..],
            &["secret", "store", "use", "system"][..],
        ] {
            let (exit, value) = device.json(&home, args, Some(b"other"));
            assert_eq!(
                (exit, code(&value)),
                (1, "SECRET_FILE_UNSAFE"),
                "{args:?}: {value}"
            );
            let hint = value["error"]["hint"].as_str().unwrap();
            assert!(hint.contains(&format!("chmod 600 {shown}")), "{hint}");
            assert_eq!(value["error"]["file"], shown);
        }
        assert_eq!(mode(&file), 0o644, "permissions are never repaired");
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(fs::read(&settings).unwrap(), settings_bytes);
        let status = device.ok(&home, &["secret", "store", "status"], None);
        assert_eq!(status["store"]["available"], false);
        assert_eq!(status["store"]["problem"]["code"], "SECRET_FILE_UNSAFE");
        let doctor = device.ok(&home, &["doctor"], None);
        assert_eq!(doctor["doctor"]["secrets"]["store"], "file");
        assert_eq!(
            doctor["doctor"]["secrets"]["problem"]["code"],
            "SECRET_FILE_UNSAFE"
        );
        let human = device.run(&home, &["doctor"], None, &[]);
        let human = String::from_utf8(human.stdout).unwrap();
        assert!(
            human.contains(&format!("secrets: file {shown} — SECRET_FILE_UNSAFE")),
            "{human}"
        );
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let target = device.home.join("elsewhere.json");
        fs::rename(&file, &target).unwrap();
        std::os::unix::fs::symlink(&target, &file).unwrap();
        let (exit, value) = device.json(&home, &["secret", "set", "OTHER"], Some(b"other"));
        assert_eq!((exit, code(&value)), (1, "SECRET_FILE_UNSAFE"), "{value}");
        fs::remove_file(&file).unwrap();
        fs::rename(&target, &file).unwrap();

        // SECRET_FILE_INVALID: damaged JSON and an unknown version.
        for damaged in ["{", r#"{"version":2,"values":{}}"#] {
            fs::write(&file, damaged).unwrap();
            for args in [&["secret", "set", "OTHER"][..], &["secret", "list"][..]] {
                let (exit, value) = device.json(&home, args, Some(b"other"));
                assert_eq!((exit, code(&value)), (1, "SECRET_FILE_INVALID"), "{value}");
                let hint = value["error"]["hint"].as_str().unwrap();
                assert!(
                    hint.contains(&format!("restore {shown} from a backup")),
                    "{hint}"
                );
            }
            assert_eq!(
                fs::read_to_string(&file).unwrap(),
                damaged,
                "never rewritten"
            );
        }
        assert_eq!(fs::read(&settings).unwrap(), settings_bytes);

        // A device without a config directory has no store at all.
        let (exit, value) = device.json_with(
            &home,
            &["secret", "list"],
            None,
            &[("SVODE_PRODUCT_IDENTIFIER", "not/one/segment")],
        );
        assert_eq!(
            (exit, code(&value)),
            (1, "SECRET_STORE_UNAVAILABLE"),
            "{value}"
        );
        assert!(
            value["error"]["hint"]
                .as_str()
                .unwrap()
                .contains("SVODE_SECRET_")
        );
    }

    #[test]
    fn returning_to_the_system_store_keeps_values_until_they_are_deleted() {
        let device = Device::new();
        let home = device.home.clone();
        let file = device.file();
        device.ok(&home, &["secret", "store", "use", "file"], None);
        device.ok(
            &home,
            &["secret", "set", "TOKEN"],
            Some(VALUES[0].as_bytes()),
        );

        let (exit, value) = device.json(&home, &["secret", "store", "use", "system"], None);
        assert_eq!(
            (exit, code(&value)),
            (1, "SECRET_VALUES_PRESENT"),
            "{value}"
        );
        assert_eq!(value["error"]["values"], 1);
        assert!(
            value["error"]["hint"]
                .as_str()
                .unwrap()
                .contains("--delete-values")
        );
        assert!(file.is_file());

        let value = device.ok(
            &home,
            &["secret", "store", "use", "system", "--delete-values"],
            None,
        );
        assert_eq!(value["changed"], true);
        assert_eq!(value["deletedValues"], 1);
        assert_eq!(value["valuesMoved"], false);
        assert!(!file.exists());
        let doctor = device.ok(&home, &["doctor"], None);
        assert_eq!(doctor["doctor"]["secrets"]["store"], "system");
        assert_eq!(doctor["doctor"]["secrets"]["problem"], Value::Null);
        let value = device.ok(&home, &["secret", "store", "use", "system"], None);
        assert_eq!(value["changed"], false);

        // An empty file goes without the flag; a damaged one only with it,
        // and its values are reported as not counted.
        device.ok(&home, &["secret", "store", "use", "file"], None);
        let value = device.ok(&home, &["secret", "store", "use", "system"], None);
        assert_eq!(value["deletedValues"], 0);
        device.ok(&home, &["secret", "store", "use", "file"], None);
        fs::write(&file, "{").unwrap();
        let (exit, value) = device.json(&home, &["secret", "store", "use", "system"], None);
        assert_eq!((exit, code(&value)), (1, "SECRET_FILE_INVALID"), "{value}");
        let output = device.run(
            &home,
            &["secret", "store", "use", "system", "--delete-values"],
            None,
            &[],
        );
        assert!(output.status.success(), "{output:?}");
        let human = String::from_utf8(output.stdout).unwrap();
        assert!(human.contains("its values could not be counted"), "{human}");
        assert!(!file.exists());
    }

    /// `doctor` names the active file and reports a safe one without a
    /// problem; no command but `use file` creates the file.
    #[test]
    fn doctor_reports_the_active_store_and_only_use_file_creates_the_file() {
        let device = Device::new();
        let home = device.home.clone();
        let doctor = device.ok(&home, &["doctor"], None);
        assert_eq!(doctor["doctor"]["secrets"]["store"], "system");
        assert_eq!(
            doctor["doctor"]["secrets"]["file"],
            device.file().display().to_string()
        );
        for args in [&["doctor"][..], &["secret", "store", "use", "system"][..]] {
            device.ok(&home, args, None);
        }
        assert!(!device.file().exists());
        device.ok(&home, &["secret", "store", "use", "file"], None);
        let doctor = device.ok(&home, &["doctor"], None);
        assert_eq!(
            doctor["doctor"]["secrets"],
            json!({
                "store": "file",
                "file": device.file().display().to_string(),
                "problem": null,
            })
        );
        let human = device.run(&home, &["doctor"], None, &[]);
        assert!(
            String::from_utf8(human.stdout)
                .unwrap()
                .contains(&format!("secrets: file {}\n", device.file().display()))
        );
    }

    /// Without a D-Bus session the system password store of Linux cannot
    /// be used: the refusal names the file and the environment variable.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_unavailable_system_store_names_the_file_and_the_environment() {
        let device = Device::new();
        let home = device.home.clone();
        let missing = device.home.join("no-bus");
        let address = format!("unix:path={}", missing.display());
        let env = [("DBUS_SESSION_BUS_ADDRESS", address.as_str())];
        let (exit, value) = device.json_with(
            &home,
            &["secret", "set", "TOKEN"],
            Some(VALUES[0].as_bytes()),
            &env,
        );
        assert_eq!(
            (exit, code(&value)),
            (1, "SECRET_STORE_UNAVAILABLE"),
            "{value}"
        );
        let hint = value["error"]["hint"].as_str().unwrap();
        assert!(hint.contains("svode secret store use file"), "{hint}");
        assert!(hint.contains("SVODE_SECRET_TOKEN"), "{hint}");
        assert!(!device.config().join("settings.json").exists());
        let (exit, status) = device.json_with(&home, &["secret", "store", "status"], None, &env);
        assert_eq!(exit, 0);
        assert_eq!(
            status["store"]["problem"]["code"],
            "SECRET_STORE_UNAVAILABLE"
        );
        assert!(!device.file().exists());
    }
}
