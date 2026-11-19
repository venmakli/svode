//! `svode storage status` and `svode storage s3 connect` through real
//! processes (`svode`, `git`, `git-lfs`, `svode-lfs`) against a loopback S3
//! stand, in a temporary home with the secrets file active: the system
//! password store and the Git config of the user are never touched.

mod common;

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};

    use serde_json::{Value, json};

    use super::common::process::{BIN, ROUTINE_CALLER_TOKEN, TEST_IDENTIFIER, code};
    use super::common::s3::S3Stand;

    const ACCESS: &str = "fixture-access";
    /// Values the tests set; none may appear in any output.
    const VALUES: [&str; 3] = [ACCESS, "fixture-secret-value", "fixture-wrong-access"];
    const BUCKET: &str = "assets";
    const PREFIX: &str = "project/root";

    struct Device {
        temp: tempfile::TempDir,
        home: PathBuf,
    }

    impl Device {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().canonicalize().unwrap().join("home");
            fs::create_dir_all(&home).unwrap();
            fs::write(
                home.join(".gitconfig"),
                "[user]\n\tname = Fixture\n\temail = fixture@example.test\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n",
            )
            .unwrap();
            Self { temp, home }
        }

        fn base(&self) -> PathBuf {
            self.temp.path().canonicalize().unwrap()
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

        fn env(&self, command: &mut Command) {
            command
                .env("HOME", &self.home)
                .env_remove("XDG_CONFIG_HOME")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env_remove(ROUTINE_CALLER_TOKEN);
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("SVODE_SECRET_") {
                    command.env_remove(key);
                }
            }
        }

        /// Runs `svode` and checks that no test value appears in its
        /// arguments, stdout or stderr, which carries the trace log too.
        fn run(
            &self,
            cwd: &Path,
            args: &[&str],
            stdin: Option<&str>,
            env: &[(&str, &str)],
        ) -> Output {
            for arg in args {
                assert!(!VALUES.iter().any(|value| arg.contains(value)));
            }
            let mut command = Command::new(BIN);
            self.env(&mut command);
            let mut child = command
                .args(args)
                .current_dir(cwd)
                .env("RUST_LOG", "trace")
                .envs(env.iter().copied())
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
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(stdin.as_bytes())
                    .unwrap();
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

        fn json_with(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> (i32, Value) {
            let mut full = args.to_vec();
            full.push("--json");
            let output = self.run(cwd, &full, None, env);
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert_eq!(stdout.lines().count(), 1, "{args:?}: {stdout}");
            (
                output.status.code().unwrap(),
                serde_json::from_str(&stdout).unwrap(),
            )
        }

        fn json(&self, cwd: &Path, args: &[&str]) -> (i32, Value) {
            self.json_with(cwd, args, &[])
        }

        fn ok(&self, cwd: &Path, args: &[&str]) -> Value {
            let (exit, value) = self.json(cwd, args);
            assert_eq!((exit, &value["ok"]), (0, &json!(true)), "{args:?}: {value}");
            value
        }

        fn set_secret(&self, cwd: &Path, name: &str, value: &str) {
            let output = self.run(cwd, &["secret", "set", name], Some(value), &[]);
            assert!(output.status.success(), "{output:?}");
        }

        fn git(&self, dir: &Path, args: &[&str]) -> String {
            self.git_with(dir, args, &[])
        }

        fn git_with(&self, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
            let mut command = Command::new("git");
            self.env(&mut command);
            let output = command
                .args(args)
                .current_dir(dir)
                .envs(env.iter().copied())
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {output:?}");
            let stdout = String::from_utf8(output.stdout).unwrap();
            for value in VALUES {
                assert!(!stdout.contains(value), "git {args:?}: {stdout}");
            }
            stdout
        }

        /// Git LFS pointer of `file`: its text and OID.
        fn pointer(&self, file: &Path) -> (String, String) {
            let text = self.git(
                file.parent().unwrap(),
                &["lfs", "pointer", &format!("--file={}", file.display())],
            );
            let oid = text
                .lines()
                .find_map(|line| line.strip_prefix("oid sha256:"))
                .unwrap()
                .to_string();
            (text, oid)
        }
    }

    fn tools_available() -> bool {
        let lfs = Command::new("git").args(["lfs", "version"]).output();
        if !lfs.is_ok_and(|output| output.status.success()) {
            eprintln!("skipped: git and git-lfs are needed");
            return false;
        }
        // `svode` registers the svode-lfs binary next to itself.
        if !Path::new(BIN).with_file_name("svode-lfs").is_file() {
            eprintln!("skipped: build svode-lfs next to svode (`cargo build -p svode-lfs`)");
            return false;
        }
        true
    }

    fn object_key(oid: &str) -> String {
        format!("/{BUCKET}/{PREFIX}/{}/{}/{oid}", &oid[0..2], &oid[2..4])
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn assets(endpoint: &str) -> Value {
        json!({
            "strategy": "lfs-s3",
            "binaryRouting": { "version": 1, "lfsExtensions": ["png"] },
            "s3": { "endpoint": endpoint, "bucket": BUCKET, "region": "us-east-1", "prefix": PREFIX }
        })
    }

    /// A Project committed with `assets` in `source`, pushed to a bare
    /// origin and cloned without LFS content, as a server clones it.
    fn cloned(device: &Device, assets: Value, photo: Option<&[u8]>) -> PathBuf {
        let base = device.base();
        let source = base.join("source");
        write(
            &source.join(".svode/config.json"),
            json!({ "name": "Project", "assets": assets })
                .to_string()
                .as_bytes(),
        );
        write(&source.join("README.md"), b"---\ntitle: Project\n---\n");
        write(&source.join("notes.md"), b"---\ntitle: Notes\n---\nBody\n");
        write(
            &source.join(".gitattributes"),
            b"*.png filter=lfs diff=lfs merge=lfs -text\n",
        );
        write(
            &source.join(".lfsconfig"),
            b"[lfs]\n\turl = https://lfs-s3.svode.invalid/\n",
        );
        svode_core::git::ops::ensure_svode_gitignore(&source).unwrap();
        device.git(&source, &["init", "-q"]);
        if let Some(photo) = photo {
            // The source commits the pointer as the desktop app would push it.
            let blob = base.join("blob.png");
            write(&blob, photo);
            let (pointer, _) = device.pointer(&blob);
            write(&source.join("photo.png"), pointer.as_bytes());
        }
        device.git(&source, &["add", "-A"]);
        device.git(&source, &["commit", "-q", "-m", "fixture"]);
        let origin = base.join("origin.git");
        device.git(&base, &["init", "-q", "--bare", origin.to_str().unwrap()]);
        device.git(
            &source,
            &["push", "-q", origin.to_str().unwrap(), "HEAD:main"],
        );
        let clone = base.join("clone");
        device.git_with(
            &base,
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
            &[("GIT_LFS_SKIP_SMUDGE", "1")],
        );
        // Writes need verified repository access, as every write command.
        let verified = device.ok(&clone, &["git", "access", "verify"]);
        assert_eq!(
            verified["repositoryAccess"]["status"], "writable",
            "{verified}"
        );
        clone
    }

    /// Everything a refusal must leave as it was: the files of the clone
    /// outside Git internals, its Git config and hooks, and the device
    /// settings.
    fn state(device: &Device, clone: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
        let mut files = super::common::process::snapshot(clone)
            .into_iter()
            .filter(|(path, _)| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let derived = name.starts_with("index.db")
                    || name.starts_with("routines.db")
                    || name == "local.json"
                    || name.ends_with(".lock");
                let git = path.components().any(|part| part.as_os_str() == ".git");
                let kept = path.starts_with(".git/config") || path.starts_with(".git/hooks");
                (kept || !git) && !derived
            })
            .map(|(path, bytes)| (path, Some(bytes)))
            .collect::<Vec<_>>();
        files.push((
            device.config().join("settings.json"),
            fs::read(device.config().join("settings.json")).ok(),
        ));
        files
    }

    /// The command fails with `expected`, a next step and no change.
    fn refused(
        device: &Device,
        clone: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        expected: &str,
        step: &str,
    ) -> Value {
        let before = state(device, clone);
        let (exit, value) = device.json_with(clone, args, env);
        assert_eq!((exit, code(&value)), (1, expected), "{args:?}: {value}");
        let hint = value["error"]["hint"].as_str().unwrap_or_default();
        assert!(hint.contains(step), "{args:?}: {hint}");
        assert_eq!(state(device, clone), before, "{args:?} changed the project");
        value
    }

    fn connect<'a>(access: &'a str, secret: &'a str) -> Vec<&'a str> {
        vec![
            "storage",
            "s3",
            "connect",
            "--access-key",
            access,
            "--secret-key",
            secret,
        ]
    }

    /// A `git` that has no `lfs` subcommand, ahead of the real one on PATH.
    fn git_without_lfs(device: &Device) -> String {
        let real = which_git();
        let bin = device.base().join("git-without-lfs");
        fs::create_dir_all(&bin).unwrap();
        svode_testkit::write_executable(
            bin.join("git"),
            format!(
                "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = lfs ]; then echo \"git: 'lfs' is not a git command\" >&2; exit 1; fi\ndone\nexec '{}' \"$@\"\n",
                real.display()
            ),
        )
        .unwrap();
        format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        )
    }

    fn which_git() -> PathBuf {
        let output = Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap();
        PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
    }

    #[test]
    fn a_clone_of_an_lfs_s3_project_connects_pulls_real_bytes_and_pushes_new_files() {
        if !tools_available() {
            return;
        }
        let stand = S3Stand::start(ACCESS);
        let device = Device::new();
        let photo = (0..=255u8).cycle().take(16 * 1024).collect::<Vec<_>>();
        let clone = cloned(&device, assets(&stand.endpoint), Some(&photo));
        let blob = device.base().join("blob.png");
        let (pointer, oid) = device.pointer(&blob);
        stand.put(&object_key(&oid), &photo);
        assert_eq!(
            fs::read_to_string(clone.join("photo.png")).unwrap(),
            pointer
        );
        let head = device.git(&clone, &["rev-parse", "HEAD"]);

        device.ok(&clone, &["secret", "store", "use", "file"]);
        device.set_secret(&clone, "S3_ACCESS_KEY", VALUES[0]);
        device.set_secret(&clone, "S3_SECRET_KEY", VALUES[1]);
        device.set_secret(&clone, "BAD_ACCESS", VALUES[2]);

        // Not connected yet: status, import and every refusal name the reason
        // and the next step and change nothing.
        let status = device.ok(&clone, &["storage", "status"]);
        let storage = &status["storage"];
        assert_eq!(storage["strategy"], "lfs-s3");
        assert_eq!(storage["repository"], ".");
        assert_eq!(storage["s3"]["bucket"], BUCKET);
        assert_eq!(storage["s3"]["endpoint"], stand.endpoint);
        assert_eq!(storage["bindings"], Value::Null);
        assert_eq!(storage["ready"], false);
        assert_eq!(storage["problem"]["code"], "S3_NOT_CONNECTED");
        assert!(
            storage["nextStep"]
                .as_str()
                .unwrap()
                .contains("svode storage s3 connect")
        );
        let human = device.run(&clone, &["storage", "status"], None, &[]);
        let human = String::from_utf8(human.stdout).unwrap();
        assert!(human.contains("strategy: lfs-s3"), "{human}");
        assert!(
            human.contains("next step: run `svode storage s3 connect"),
            "{human}"
        );

        let new = device.base().join("elsewhere/new.png");
        write(
            &new,
            &(0..200u8).rev().cycle().take(9000).collect::<Vec<_>>(),
        );
        let new_path = new.to_str().unwrap();
        let import = ["asset", "import", "--path", "notes.md", "--file", new_path];
        let value = refused(
            &device,
            &clone,
            &import,
            &[],
            "S3_NOT_CONNECTED",
            "svode storage s3 connect",
        );
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Git LFS route is not ready"),
            "{value}"
        );
        refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "MISSING_KEY"),
            &[],
            "SECRET_NOT_FOUND",
            "svode secret set MISSING_KEY",
        );
        refused(
            &device,
            &clone,
            &connect("BAD_ACCESS", "S3_SECRET_KEY"),
            &[],
            "S3_CHECK_FAILED",
            "bucket",
        );
        let path = git_without_lfs(&device);
        refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            &[("PATH", path.as_str())],
            "LFS_TOOLING_UNAVAILABLE",
            "install git-lfs",
        );
        let (_, status) =
            device.json_with(&clone, &["storage", "status"], &[("PATH", path.as_str())]);
        assert_eq!(
            status["storage"]["problem"]["code"], "LFS_TOOLING_UNAVAILABLE",
            "{status}"
        );

        let file = device.file();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            &[],
            "SECRET_FILE_UNSAFE",
            "chmod 600",
        );
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let secrets = fs::read(&file).unwrap();
        fs::write(&file, "{").unwrap();
        refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            &[],
            "SECRET_FILE_INVALID",
            "restore",
        );
        fs::write(&file, &secrets).unwrap();
        assert!(!clone.join(".svode/lfs-s3-agent.json").exists());

        // Connect: a probe round trip, the agent config and the svode-lfs
        // registration, nothing committed and nothing in Git status.
        let connected = device.ok(&clone, &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"));
        let changed = connected["changedPaths"].as_array().unwrap();
        for expected in [".svode/lfs-s3-agent.json", ".git/config"] {
            assert!(changed.contains(&json!(expected)), "{connected}");
        }
        assert!(
            changed.contains(&json!(
                device.config().join("settings.json").display().to_string()
            )),
            "{connected}"
        );
        assert_eq!(connected["committed"], false);
        assert_eq!(
            connected["storage"]["bindings"]["accessKey"],
            json!({ "name": "S3_ACCESS_KEY", "owner": "device" })
        );
        assert_eq!(device.git(&clone, &["status", "--porcelain"]), "");
        assert_eq!(device.git(&clone, &["rev-parse", "HEAD"]), head);
        let probes = stand
            .requests()
            .into_iter()
            .filter(|request| request.contains("/.svode-probe/"))
            .collect::<Vec<_>>();
        for method in ["PUT ", "GET ", "DELETE "] {
            assert!(
                probes.iter().any(|request| request.starts_with(method)),
                "{probes:?}"
            );
        }
        assert!(!stand.keys().iter().any(|key| key.contains(".svode-probe")));
        let agent: Value =
            serde_json::from_slice(&fs::read(clone.join(".svode/lfs-s3-agent.json")).unwrap())
                .unwrap();
        assert_eq!(
            agent["globalDirectory"],
            device.config().display().to_string()
        );
        assert_eq!(agent["projectPath"], clone.display().to_string());
        let agent_text = agent.to_string();
        assert!(!VALUES.iter().any(|value| agent_text.contains(value)));
        assert_eq!(
            device
                .git(
                    &clone,
                    &["config", "--local", "--get", "lfs.standalonetransferagent"]
                )
                .trim(),
            "svode-lfs"
        );

        // A repeat with the same Secrets changes no file.
        let again = device.ok(&clone, &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"));
        assert_eq!(again["changedPaths"], json!([]), "{again}");
        let human = device.run(
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            None,
            &[],
        );
        assert!(
            String::from_utf8(human.stdout)
                .unwrap()
                .contains("no file changed")
        );

        // A failed check keeps the working setup as it was.
        refused(
            &device,
            &clone,
            &connect("BAD_ACCESS", "S3_SECRET_KEY"),
            &[],
            "S3_CHECK_FAILED",
            "bucket",
        );

        let status = device.ok(&clone, &["storage", "status"]);
        assert_eq!(status["storage"]["ready"], true, "{status}");
        assert_eq!(status["storage"]["lfs"], "ready");
        assert_eq!(status["storage"]["problem"], Value::Null);
        assert_eq!(
            status["storage"]["bindings"]["secretKey"]["name"],
            "S3_SECRET_KEY"
        );

        // Real bytes after `git lfs pull` through svode-lfs.
        device.git(&clone, &["lfs", "pull"]);
        assert_eq!(fs::read(clone.join("photo.png")).unwrap(), photo);
        assert_eq!(device.git(&clone, &["status", "--porcelain"]), "");

        // A new file imports by its LFS route and goes out with `git lfs push`.
        device.ok(&clone, &import);
        let (_, new_oid) = device.pointer(&new);
        device.git(&clone, &["add", "-A"]);
        device.git(&clone, &["commit", "-q", "-m", "import"]);
        assert!(
            device
                .git(&clone, &["lfs", "ls-files", "--long"])
                .contains(&new_oid),
            "the import is stored as a Git LFS pointer"
        );
        assert!(stand.get(&object_key(&new_oid)).is_none());
        device.git(&clone, &["lfs", "push", "origin", "main"]);
        assert_eq!(
            stand.get(&object_key(&new_oid)).unwrap(),
            fs::read(&new).unwrap()
        );
    }

    #[test]
    fn connect_refuses_a_project_without_the_lfs_s3_strategy() {
        if !tools_available() {
            return;
        }
        let device = Device::new();
        device.ok(&device.home, &["secret", "store", "use", "file"]);
        let clone = cloned(&device, json!({ "strategy": "in-git" }), None);
        device.set_secret(&clone, "S3_ACCESS_KEY", VALUES[0]);
        device.set_secret(&clone, "S3_SECRET_KEY", VALUES[1]);
        let value = refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            &[],
            "STORAGE_STRATEGY_MISMATCH",
            "svode storage s3 enable",
        );
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("in-git"),
            "{value}"
        );
        let status = device.ok(&clone, &["storage", "status"]);
        assert_eq!(status["storage"]["strategy"], "in-git");
        assert_eq!(status["storage"]["lfs"], "n/a");
        assert_eq!(status["storage"]["ready"], true);
        assert_eq!(status["storage"]["nextStep"], Value::Null);
        assert!(!clone.join(".svode/lfs-s3-agent.json").exists());

        // `lfs-s3` without an S3 address cannot be connected either.
        let device = Device::new();
        device.ok(&device.home, &["secret", "store", "use", "file"]);
        let clone = cloned(&device, json!({ "strategy": "lfs-s3" }), None);
        device.set_secret(&clone, "S3_ACCESS_KEY", VALUES[0]);
        device.set_secret(&clone, "S3_SECRET_KEY", VALUES[1]);
        refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            &[],
            "STORAGE_STRATEGY_MISMATCH",
            "svode storage s3 enable",
        );
    }

    /// Without a D-Bus session the system password store cannot be used;
    /// the refusal names the secrets file and the environment variable.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_unavailable_system_store_refuses_the_connection() {
        if !tools_available() {
            return;
        }
        let stand = S3Stand::start(ACCESS);
        let device = Device::new();
        let clone = cloned(&device, assets(&stand.endpoint), None);
        write(
            &device.config().join("settings.json"),
            json!({ "variables": {
                "S3_ACCESS_KEY": { "kind": "secret", "secretRef": "secret:01ARZ3NDEKTSV4RRFFQ69G5FAV" },
                "S3_SECRET_KEY": { "kind": "secret", "secretRef": "secret:01ARZ3NDEKTSV4RRFFQ69G5FAW" }
            }})
            .to_string()
            .as_bytes(),
        );
        let address = format!("unix:path={}", device.home.join("no-bus").display());
        refused(
            &device,
            &clone,
            &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"),
            &[("DBUS_SESSION_BUS_ADDRESS", address.as_str())],
            "SECRET_STORE_UNAVAILABLE",
            "svode secret store use file",
        );
    }
}
