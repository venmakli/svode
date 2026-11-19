//! `svode storage status`, `svode storage s3 connect` and `svode storage s3
//! enable` through real processes (`svode`, `git`, `git-lfs`, `svode-lfs`)
//! against a loopback S3 stand, in a temporary home with the secrets file
//! active: the system password store and the Git config of the user are
//! never touched.

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
    use svode_core::git::cli::GitCli;
    use svode_core::git::state::GitRuntime;
    use svode_core::storage::lfs_download::{DownloadStop, LfsFile, download, missing_files};

    const ACCESS: &str = "fixture-access";
    /// Values the tests set; none may appear in any output.
    const VALUES: [&str; 3] = [ACCESS, "fixture-secret-value", "fixture-wrong-access"];
    const BUCKET: &str = "assets";
    const PREFIX: &str = "project/root";

    struct Device {
        temp: tempfile::TempDir,
        home: PathBuf,
        /// Every process starts as in a new SSH login session, see
        /// [`Device::login_session`].
        login: bool,
    }

    impl Device {
        fn new() -> Self {
            Self::with(false)
        }

        /// A server account reached over SSH: each process gets only what a
        /// login session sets (`HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`,
        /// `LANG`), so no D-Bus session, no XDG directories, no `SVODE_*`
        /// variable and the default product identifier under the temporary
        /// home.
        fn login_session() -> Self {
            Self::with(true)
        }

        fn with(login: bool) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().canonicalize().unwrap().join("home");
            fs::create_dir_all(&home).unwrap();
            fs::write(
                home.join(".gitconfig"),
                "[user]\n\tname = Fixture\n\temail = fixture@example.test\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n",
            )
            .unwrap();
            Self { temp, home, login }
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
            base.join(if self.login {
                svode_core::runtime::device::PRODUCT_IDENTIFIER
            } else {
                TEST_IDENTIFIER
            })
        }

        fn file(&self) -> PathBuf {
            self.config().join("secrets.json")
        }

        fn env(&self, command: &mut Command) {
            if self.login {
                let user = std::env::var("USER").unwrap_or_else(|_| "fixture".into());
                command
                    .env_clear()
                    .env("HOME", &self.home)
                    .env("USER", &user)
                    .env("LOGNAME", &user)
                    .env("PATH", login_path())
                    .env("SHELL", "/bin/sh")
                    .env("LANG", "C.UTF-8");
                return;
            }
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
            if !self.login {
                command.env("RUST_LOG", "trace");
            }
            let mut child = command
                .args(args)
                .current_dir(cwd)
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
            let output = self.git_output(dir, args, env);
            assert!(output.status.success(), "git {args:?}: {output:?}");
            String::from_utf8(output.stdout).unwrap()
        }

        /// Runs `git`, whatever its exit, and checks that no test value
        /// appears in its stdout or stderr, which carry svode-lfs messages.
        fn git_output(&self, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
            let mut command = Command::new("git");
            self.env(&mut command);
            let output = command
                .args(args)
                .current_dir(dir)
                .envs(env.iter().copied())
                .output()
                .unwrap();
            for stream in [&output.stdout, &output.stderr] {
                let text = String::from_utf8_lossy(stream);
                for value in VALUES {
                    assert!(!text.contains(value), "git {args:?}: {text}");
                }
            }
            output
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

    /// Whether `git`, `git-lfs` and the svode-lfs next to `svode` are there.
    /// Without them a test is skipped, unless `SVODE_STORAGE_REQUIRE_TOOLS`
    /// is set, as in CI, where a skip would hide the server scenario.
    fn tools_available() -> bool {
        let lfs = Command::new("git").args(["lfs", "version"]).output();
        let missing = if !lfs.is_ok_and(|output| output.status.success()) {
            "git and git-lfs are needed"
        } else if !Path::new(BIN).with_file_name("svode-lfs").is_file() {
            // `svode` registers the svode-lfs binary next to itself.
            "build svode-lfs next to svode (`cargo build -p svode-lfs`)"
        } else {
            return true;
        };
        assert!(
            std::env::var_os("SVODE_STORAGE_REQUIRE_TOOLS").is_none(),
            "{missing}"
        );
        eprintln!("skipped: {missing}");
        false
    }

    /// `PATH` of a login session: the directories of `git`, `git-lfs` and
    /// `svode`, as an install puts them on it, and the system ones.
    fn login_path() -> String {
        let mut dirs = Vec::new();
        for tool in ["git", "git-lfs"] {
            let output = Command::new("sh")
                .args(["-c", &format!("command -v {tool}")])
                .output()
                .unwrap();
            let path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
            dirs.push(path.parent().unwrap().display().to_string());
        }
        dirs.push(Path::new(BIN).parent().unwrap().display().to_string());
        dirs.extend(["/usr/bin".into(), "/bin".into()]);
        dirs.dedup();
        dirs.join(":")
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
        let origin = origin(device, assets, photo);
        clone(device, &origin)
    }

    /// The bare origin of a Project committed with `assets` and, with
    /// `photo`, the Git LFS pointer of `photo.png`, as the desktop app
    /// pushes it.
    fn origin(device: &Device, assets: Value, photo: Option<&[u8]>) -> PathBuf {
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
        origin
    }

    /// `origin` cloned without LFS content, with verified repository access.
    fn clone(device: &Device, origin: &Path) -> PathBuf {
        let base = device.base();
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

    /// DF-368 R1 for `lfs-s3`: a fresh clone whose sync brings nothing in
    /// gets the content of its LFS files from the download Svode runs after
    /// every sync, through svode-lfs and the S3 stand.
    #[test]
    fn a_fresh_lfs_s3_clone_downloads_its_content_after_a_sync_without_incoming_changes() {
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
        device.ok(&clone, &["secret", "store", "use", "file"]);
        device.set_secret(&clone, "S3_ACCESS_KEY", VALUES[0]);
        device.set_secret(&clone, "S3_SECRET_KEY", VALUES[1]);
        device.ok(&clone, &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"));

        // The sync brings nothing in, and the file stays a pointer.
        let head = device.git(&clone, &["rev-parse", "HEAD"]);
        device.git(&clone, &["pull", "-q", "--ff-only"]);
        assert_eq!(device.git(&clone, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            fs::read_to_string(clone.join("photo.png")).unwrap(),
            pointer
        );

        // The Git of the device: its home, secrets file and Git config.
        let git = device.base().join("git-device");
        svode_testkit::write_executable(
            &git,
            format!(
                "#!/bin/sh\nunset XDG_CONFIG_HOME\nexport HOME='{home}' GIT_CONFIG_NOSYSTEM=1 SVODE_PRODUCT_IDENTIFIER='{TEST_IDENTIFIER}'\nexec '{real}' \"$@\"\n",
                home = device.home.display(),
                real = which_git().display(),
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(git);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let run = || {
            runtime.block_on(async {
                let missing = missing_files(&cli, &clone).await.unwrap();
                assert_eq!(
                    missing.files(),
                    vec![LfsFile {
                        path: "photo.png".into(),
                        size: photo.len() as u64,
                    }]
                );
                download(&GitRuntime::new(), &cli, &clone, &missing).await
            })
        };

        // A key the storage refuses stops the download as no access.
        device.set_secret(&clone, "S3_ACCESS_KEY", VALUES[2]);
        let refused = run();
        assert_eq!(refused.stop, Some(DownloadStop::NoAccess), "{refused:?}");
        assert_eq!(
            fs::read_to_string(clone.join("photo.png")).unwrap(),
            pointer
        );

        device.set_secret(&clone, "S3_ACCESS_KEY", VALUES[0]);
        let outcome = run();
        assert_eq!(outcome.stop, None, "{outcome:?}");
        assert!(outcome.missing.is_empty());
        assert_eq!(fs::read(clone.join("photo.png")).unwrap(), photo);
        assert_eq!(device.git(&clone, &["status", "--porcelain"]), "");
        assert!(
            stand
                .requests()
                .iter()
                .any(|request| request.starts_with("GET ") && request.contains(&oid)),
            "{:?}",
            stand.requests()
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

    fn enable<'a>(endpoint: &'a str, access: &'a str, secret: &'a str) -> Vec<&'a str> {
        vec![
            "storage",
            "s3",
            "enable",
            "--endpoint",
            endpoint,
            "--bucket",
            BUCKET,
            "--region",
            "us-east-1",
            "--access-key",
            access,
            "--secret-key",
            secret,
        ]
    }

    /// A new `local` Project at `<base>/<parent>/project`, as `svode project
    /// create` makes it, committed.
    fn local_project(device: &Device, parent: &str) -> PathBuf {
        let dir = device.base().join(parent);
        fs::create_dir_all(&dir).unwrap();
        device.ok(&dir, &["project", "create", "project", "--name", "Project"]);
        let project = dir.join("project");
        device.git(&project, &["add", "-A"]);
        device.git(&project, &["commit", "-q", "-m", "scaffold"]);
        project
    }

    /// Environment of the child that enables `lfs-s3` as the desktop app.
    const DESKTOP_PROJECT: &str = "SVODE_TEST_DESKTOP_ENABLE_PROJECT";
    const DESKTOP_ENDPOINT: &str = "SVODE_TEST_DESKTOP_ENABLE_ENDPOINT";
    const DESKTOP_CATALOG: &str = "SVODE_TEST_DESKTOP_ENABLE_CATALOG";

    /// Runs [`enable_as_desktop`] in a child of this test binary with the
    /// environment of the `svode` processes, so Git sees the same home.
    fn run_enable_as_desktop(device: &Device, project: &Path, endpoint: &str) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        device.env(&mut command);
        let output = command
            .args(["--exact", "unix::desktop_enable_child", "--nocapture"])
            .env(DESKTOP_PROJECT, project)
            .env(DESKTOP_ENDPOINT, endpoint)
            .env(DESKTOP_CATALOG, device.config())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{output:?}"
        );
    }

    /// The child of [`run_enable_as_desktop`]; a no-op in an ordinary run.
    #[test]
    fn desktop_enable_child() {
        let Some(project) = std::env::var_os(DESKTOP_PROJECT) else {
            return;
        };
        enable_as_desktop(
            Path::new(&std::env::var_os(DESKTOP_CATALOG).unwrap()),
            Path::new(&project),
            &std::env::var(DESKTOP_ENDPOINT).unwrap(),
        );
    }

    /// Enables `lfs-s3` in `project` as the desktop command does with the
    /// input of its storage settings: the effective binary routing shown,
    /// the address with an empty prefix and the two Secrets; the strategy
    /// is applied with the svode-lfs next to `svode` and the agent config is
    /// published, without the S3 check the settings run before saving.
    fn enable_as_desktop(catalog: &Path, project: &Path, endpoint: &str) {
        use svode_core::storage::config::{AssetsS3Config, BinaryRoutingConfig};
        use svode_core::storage::policy::effective_binary_routing;
        use svode_core::storage::s3::{AgentConfig, SecretBindings};
        use svode_core::storage::strategy::{self, StrategyRequest, StrategyScope};
        use svode_core::variables::{DeviceSecretStore, SourceOwner, SourceReference};

        let current = svode_core::space_config::read(project)
            .unwrap()
            .assets
            .unwrap();
        let shown = effective_binary_routing(&current);
        let mut lfs_extensions = shown.lfs_extensions;
        lfs_extensions.sort();
        let mut local_extensions = shown.local_extensions;
        local_extensions.sort();
        let routing = BinaryRoutingConfig {
            version: 1,
            lfs_extensions,
            lfs_threshold_bytes: shown.lfs_threshold_bytes,
            local_extensions: Some(local_extensions),
            extensions: Default::default(),
        };
        let target = AssetsS3Config {
            endpoint: endpoint.to_string(),
            bucket: BUCKET.to_string(),
            region: "us-east-1".to_string(),
            prefix: String::new(),
            extensions: Default::default(),
        };
        let reference = |name: &str| SourceReference {
            owner: SourceOwner::Global,
            name: name.to_string(),
        };
        let bindings = SecretBindings {
            access_key: reference("S3_ACCESS_KEY"),
            secret_key: reference("S3_SECRET_KEY"),
        };
        let binary = Path::new(BIN).with_file_name("svode-lfs");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let git = svode_core::git::state::GitRuntime::new();
                let index = svode_core::index::state::IndexRuntimeState::default();
                let scope = svode_core::storage::scope::resolve_assets_scope(&index, project, None)
                    .await
                    .unwrap();
                let default_prefix = strategy::default_s3_prefix(project, &scope);
                let planned = strategy::plan(
                    StrategyScope {
                        config_dir: &scope.config_dir,
                        inherited_from_project: scope.inherited_from_project,
                        default_s3_prefix: &default_prefix,
                    },
                    StrategyRequest {
                        strategy: svode_core::storage::config::AssetsStrategy::LfsS3,
                        binary_routing: routing,
                        s3: Some(target),
                    },
                )
                .unwrap();
                let agent = AgentConfig::prepare(
                    catalog,
                    project,
                    None,
                    planned.assets().s3.as_ref().unwrap(),
                    bindings,
                    &DeviceSecretStore::new(catalog),
                )
                .unwrap();
                let result = planned
                    .apply(&git, &scope.repo_dir, Some(&binary))
                    .await
                    .unwrap();
                assert!(result.warnings.is_empty(), "{result:?}");
                agent
                    .publish(catalog, project, &DeviceSecretStore::new(catalog))
                    .unwrap();
            });
    }

    /// The agent config of `project` without its absolute `projectPath`.
    fn agent_config(project: &Path) -> Value {
        let mut agent: Value =
            serde_json::from_slice(&fs::read(project.join(".svode/lfs-s3-agent.json")).unwrap())
                .unwrap();
        assert_eq!(agent["projectPath"], project.display().to_string());
        agent.as_object_mut().unwrap().remove("projectPath");
        agent
    }

    #[test]
    fn enable_writes_the_files_of_the_desktop_app_connects_and_a_repeat_changes_nothing() {
        if !tools_available() {
            return;
        }
        let stand = S3Stand::start(ACCESS);
        let device = Device::new();
        device.ok(&device.home, &["secret", "store", "use", "file"]);
        device.set_secret(&device.home, "S3_ACCESS_KEY", VALUES[0]);
        device.set_secret(&device.home, "S3_SECRET_KEY", VALUES[1]);
        device.set_secret(&device.home, "BAD_ACCESS", VALUES[2]);
        let desktop = local_project(&device, "desktop");
        let project = local_project(&device, "cli");
        assert_eq!(
            fs::read(desktop.join(".svode/config.json")).unwrap(),
            fs::read(project.join(".svode/config.json")).unwrap()
        );
        let head = device.git(&project, &["rev-parse", "HEAD"]);

        // Every failed check leaves the `local` Project as it was.
        let path = git_without_lfs(&device);
        for (args, env, expected, step) in [
            (
                enable(&stand.endpoint, "S3_ACCESS_KEY", "MISSING_KEY"),
                vec![],
                "SECRET_NOT_FOUND",
                "svode secret set MISSING_KEY",
            ),
            (
                enable(&stand.endpoint, "BAD_ACCESS", "S3_SECRET_KEY"),
                vec![],
                "S3_CHECK_FAILED",
                "bucket",
            ),
            (
                enable(&stand.endpoint, "S3_ACCESS_KEY", "S3_SECRET_KEY"),
                vec![("PATH", path.as_str())],
                "LFS_TOOLING_UNAVAILABLE",
                "install git-lfs",
            ),
        ] {
            refused(&device, &project, &args, &env, expected, step);
        }
        assert!(!project.join(".svode/lfs-s3-agent.json").exists());
        let status = device.ok(&project, &["storage", "status"]);
        assert_eq!(status["storage"]["strategy"], "local", "{status}");

        run_enable_as_desktop(&device, &desktop, &stand.endpoint);
        let enabled = device.ok(
            &project,
            &enable(&stand.endpoint, "S3_ACCESS_KEY", "S3_SECRET_KEY"),
        );

        // The managed files are the bytes the desktop command writes; Git LFS
        // writes the keys of its filter in no fixed order, so the Git config
        // compares by its entries.
        let entries = |project: &Path| {
            let mut entries = device
                .git(project, &["config", "--local", "--list"])
                .lines()
                .map(str::to_string)
                .collect::<Vec<_>>();
            entries.sort();
            entries
        };
        assert_eq!(entries(&desktop), entries(&project));
        for file in [
            ".svode/config.json",
            ".gitignore",
            ".gitattributes",
            ".lfsconfig",
            ".git/hooks/pre-push",
            ".git/hooks/post-checkout",
            ".git/hooks/post-commit",
            ".git/hooks/post-merge",
        ] {
            assert_eq!(
                fs::read(desktop.join(file)).ok(),
                fs::read(project.join(file)).ok(),
                "{file}"
            );
        }
        assert_eq!(agent_config(&desktop), agent_config(&project));
        let config: Value =
            serde_json::from_slice(&fs::read(project.join(".svode/config.json")).unwrap()).unwrap();
        assert_eq!(config["assets"]["strategy"], "lfs-s3");
        assert_eq!(
            config["assets"]["s3"],
            json!({ "endpoint": stand.endpoint, "bucket": BUCKET, "region": "us-east-1", "prefix": PREFIX })
        );
        assert_eq!(
            fs::read_to_string(project.join(".lfsconfig")).unwrap(),
            "[lfs]\n\turl = https://lfs-s3.svode.invalid/\n"
        );

        // Nothing is committed; the changed files are listed.
        let changed = enabled["changedPaths"].as_array().unwrap();
        for expected in [
            ".svode/config.json",
            ".gitignore",
            ".gitattributes",
            ".lfsconfig",
            ".svode/lfs-s3-agent.json",
            ".git/config",
        ] {
            assert!(changed.contains(&json!(expected)), "{enabled}");
        }
        assert!(
            changed.contains(&json!(
                device.config().join("settings.json").display().to_string()
            )),
            "{enabled}"
        );
        assert_eq!(enabled["committed"], false);
        assert_eq!(enabled["warnings"], json!([]), "{enabled}");
        assert_eq!(enabled["storage"]["strategy"], "lfs-s3");
        assert_eq!(enabled["storage"]["s3"]["prefix"], PREFIX);
        assert_eq!(
            enabled["storage"]["bindings"]["secretKey"],
            json!({ "name": "S3_SECRET_KEY", "owner": "device" })
        );
        assert_eq!(device.git(&project, &["rev-parse", "HEAD"]), head);
        let mut dirty = device
            .git(&project, &["status", "--porcelain"])
            .lines()
            .map(|line| line[3..].to_string())
            .collect::<Vec<_>>();
        dirty.sort();
        assert_eq!(
            dirty,
            [
                ".gitattributes",
                ".gitignore",
                ".lfsconfig",
                ".svode/config.json"
            ]
        );
        let probes = stand
            .requests()
            .into_iter()
            .filter(|request| request.contains("/.svode-probe/"))
            .count();
        assert!(probes >= 3, "{probes}");
        assert!(!stand.keys().iter().any(|key| key.contains(".svode-probe")));

        let status = device.ok(&project, &["storage", "status"]);
        assert_eq!(status["storage"]["ready"], true, "{status}");
        assert_eq!(status["storage"]["lfs"], "ready");

        // A repeat with the same data changes no file.
        let again = device.ok(
            &project,
            &enable(&stand.endpoint, "S3_ACCESS_KEY", "S3_SECRET_KEY"),
        );
        assert_eq!(again["changedPaths"], json!([]), "{again}");
        let human = device.run(
            &project,
            &enable(&stand.endpoint, "S3_ACCESS_KEY", "S3_SECRET_KEY"),
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
            &project,
            &enable(&stand.endpoint, "BAD_ACCESS", "S3_SECRET_KEY"),
            &[],
            "S3_CHECK_FAILED",
            "bucket",
        );
    }

    #[test]
    fn enable_refuses_an_active_strategy_and_an_inline_space_without_writing() {
        if !tools_available() {
            return;
        }
        let stand = S3Stand::start(ACCESS);
        let device = Device::new();
        device.ok(&device.home, &["secret", "store", "use", "file"]);
        device.set_secret(&device.home, "S3_ACCESS_KEY", VALUES[0]);
        device.set_secret(&device.home, "S3_SECRET_KEY", VALUES[1]);
        let args = enable(&stand.endpoint, "S3_ACCESS_KEY", "S3_SECRET_KEY");

        // The transition rule of the desktop app: an active strategy is kept.
        let clone = cloned(&device, json!({ "strategy": "in-git" }), None);
        let value = refused(
            &device,
            &clone,
            &args,
            &[],
            "STORAGE_STRATEGY_MISMATCH",
            "keep the strategy `in-git`",
        );
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Changing an active assets storage strategy is not supported"),
            "{value}"
        );
        assert!(
            !stand
                .requests()
                .iter()
                .any(|request| request.contains("/.svode-probe/"))
        );

        // An inline Space uses the storage of the Project.
        let project = local_project(&device, "inline");
        let space = device.ok(&project, &["space", "create", "notes", "--name", "Notes"]);
        let id = space["space"]["id"].as_str().unwrap().to_string();
        device.git(&project, &["add", "-A"]);
        device.git(&project, &["commit", "-q", "-m", "space"]);
        let mut inline = vec!["--space", id.as_str()];
        inline.extend(args.iter().copied());
        refused(
            &device,
            &project,
            &inline,
            &[],
            "STORAGE_STRATEGY_INHERITED",
            "--space root",
        );
    }

    /// Imports `name` with `bytes` into the Page at `path`, commits it and
    /// pushes its Git LFS object to the stand; returns the canonical Page
    /// path after the import.
    fn import_and_push(
        device: &Device,
        stand: &S3Stand,
        clone: &Path,
        path: &str,
        name: &str,
        bytes: &[u8],
    ) -> String {
        let file = device.base().join("elsewhere").join(name);
        write(&file, bytes);
        let imported = device.ok(
            clone,
            &[
                "asset",
                "import",
                "--path",
                path,
                "--file",
                file.to_str().unwrap(),
            ],
        );
        let (_, oid) = device.pointer(&file);
        device.git(clone, &["add", "-A"]);
        device.git(clone, &["commit", "-q", "-m", name]);
        assert!(
            device
                .git(clone, &["lfs", "ls-files", "--long"])
                .contains(&oid),
            "{name} is stored as a Git LFS pointer"
        );
        assert!(stand.get(&object_key(&oid)).is_none());
        device.git(clone, &["lfs", "push", "origin", "main"]);
        assert_eq!(stand.get(&object_key(&oid)).unwrap(), bytes);
        imported["contentPath"].as_str().unwrap().to_string()
    }

    /// Drops the local Git LFS objects and checks `photo.png` out as its
    /// pointer, as a clone without LFS content has it.
    fn forget_lfs_content(device: &Device, clone: &Path, pointer: &str) {
        fs::remove_dir_all(clone.join(".git/lfs/objects")).unwrap();
        fs::remove_file(clone.join("photo.png")).unwrap();
        device.git_with(
            clone,
            &["checkout", "--", "photo.png"],
            &[("GIT_LFS_SKIP_SMUDGE", "1")],
        );
        assert_eq!(
            fs::read_to_string(clone.join("photo.png")).unwrap(),
            pointer
        );
        assert_eq!(device.git(clone, &["status", "--porcelain"]), "");
    }

    /// DF-367 on a server reached over SSH, with no desktop session: every
    /// process starts with only the environment of a login session. The
    /// path of the example — clone without LFS content, the secrets file,
    /// two Secrets from stdin, `connect` — gives real bytes on `git lfs
    /// pull`, and an import goes out with `git lfs push`; a new session does
    /// it again with nothing kept but the files; svode-lfs started by Git
    /// takes `SVODE_SECRET_<NAME>` over the file.
    #[test]
    fn a_server_without_a_desktop_session_uses_the_lfs_s3_project_in_every_new_ssh_session() {
        if !tools_available() {
            return;
        }
        let stand = S3Stand::start(ACCESS);
        let desktop = Device::new();
        let photo = (0..=255u8).cycle().take(16 * 1024).collect::<Vec<_>>();
        let origin = origin(&desktop, assets(&stand.endpoint), Some(&photo));
        let (pointer, oid) = desktop.pointer(&desktop.base().join("blob.png"));
        stand.put(&object_key(&oid), &photo);

        let server = Device::login_session();
        // Without a session bus the system password store cannot be used.
        // The macOS run skips it: there the login keychain of the user
        // would answer.
        #[cfg(target_os = "linux")]
        {
            let status = server.ok(&server.home, &["secret", "store", "status"]);
            eprintln!(
                "system password store in a login session without D-Bus: {}",
                status["store"]
            );
            assert_eq!(status["store"]["kind"], "system", "{status}");
            assert_eq!(status["store"]["available"], false, "{status}");
            assert_eq!(
                status["store"]["problem"]["code"], "SECRET_STORE_UNAVAILABLE",
                "{status}"
            );
        }

        // The session that sets the server up.
        let clone = clone(&server, &origin);
        assert_eq!(
            fs::read_to_string(clone.join("photo.png")).unwrap(),
            pointer
        );
        let used = server.ok(&clone, &["secret", "store", "use", "file"]);
        assert_eq!(used["store"]["kind"], "file", "{used}");
        assert_eq!(
            used["store"]["file"],
            server.file().display().to_string(),
            "{used}"
        );
        server.set_secret(&clone, "S3_ACCESS_KEY", VALUES[0]);
        server.set_secret(&clone, "S3_SECRET_KEY", VALUES[1]);
        let connected = server.ok(&clone, &connect("S3_ACCESS_KEY", "S3_SECRET_KEY"));
        assert_eq!(connected["committed"], false, "{connected}");
        let agent: Value =
            serde_json::from_slice(&fs::read(clone.join(".svode/lfs-s3-agent.json")).unwrap())
                .unwrap();
        assert_eq!(
            agent["globalDirectory"],
            server.config().display().to_string()
        );
        server.git(&clone, &["lfs", "pull"]);
        assert_eq!(fs::read(clone.join("photo.png")).unwrap(), photo);
        let page = import_and_push(
            &server,
            &stand,
            &clone,
            "notes.md",
            "first.png",
            &(0..200u8).rev().cycle().take(9000).collect::<Vec<_>>(),
        );

        // A new session: nothing of the earlier processes is kept but the
        // files, and the content comes again from S3.
        forget_lfs_content(&server, &clone, &pointer);
        let status = server.ok(&clone, &["storage", "status"]);
        assert_eq!(status["storage"]["ready"], true, "{status}");
        server.git(&clone, &["lfs", "pull"]);
        assert_eq!(fs::read(clone.join("photo.png")).unwrap(), photo);
        import_and_push(
            &server,
            &stand,
            &clone,
            &page,
            "second.png",
            &(0..150u8).cycle().take(7000).collect::<Vec<_>>(),
        );

        // svode-lfs started by Git sees `SVODE_SECRET_<NAME>`: with a wrong
        // access key in the file the transfer is refused, with the right one
        // in the environment of Git it passes, and nothing is written.
        server.set_secret(&clone, "S3_ACCESS_KEY", VALUES[2]);
        forget_lfs_content(&server, &clone, &pointer);
        let refused = server.git_output(&clone, &["lfs", "pull"], &[]);
        assert!(!refused.status.success(), "{refused:?}");
        assert_eq!(
            fs::read_to_string(clone.join("photo.png")).unwrap(),
            pointer
        );
        server.git_with(
            &clone,
            &["lfs", "pull"],
            &[("SVODE_SECRET_S3_ACCESS_KEY", ACCESS)],
        );
        assert_eq!(fs::read(clone.join("photo.png")).unwrap(), photo);
        let secrets = fs::read_to_string(server.file()).unwrap();
        assert!(secrets.contains(VALUES[2]) && !secrets.contains(ACCESS));
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
