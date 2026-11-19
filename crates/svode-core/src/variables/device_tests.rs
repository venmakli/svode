use super::*;
use crate::variables::{Context, Kind, Mode, Owner, Save, SaveOperation, Service, SourceOwner};
use std::cell::RefCell;

thread_local! {
    /// The system store of the current test thread; `None` denies access.
    static SYSTEM: RefCell<Option<BTreeMap<String, String>>> = const { RefCell::new(None) };
}

struct TestCredential(String);
impl keyring::credential::CredentialApi for TestCredential {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        SYSTEM.with(|system| match system.borrow_mut().as_mut() {
            Some(values) => {
                values.insert(self.0.clone(), String::from_utf8(secret.to_vec()).unwrap());
                Ok(())
            }
            None => Err(keyring::Error::PlatformFailure("denied".into())),
        })
    }
    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        SYSTEM.with(|system| match system.borrow().as_ref() {
            Some(values) => values
                .get(&self.0)
                .map(|value| value.as_bytes().to_vec())
                .ok_or(keyring::Error::NoEntry),
            None => Err(keyring::Error::PlatformFailure("denied".into())),
        })
    }
    fn delete_credential(&self) -> keyring::Result<()> {
        SYSTEM.with(|system| match system.borrow_mut().as_mut() {
            Some(values) => values
                .remove(&self.0)
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry),
            None => Err(keyring::Error::PlatformFailure("denied".into())),
        })
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[derive(Debug)]
struct TestBuilder;
impl keyring::credential::CredentialBuilderApi for TestBuilder {
    fn build(
        &self,
        _: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<keyring::credential::Credential>> {
        assert_eq!(service, KEYCHAIN_SERVICE);
        Ok(Box::new(TestCredential(user.into())))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Replaces the OS password store of this test process; each test thread
/// starts with a store that denies access.
fn system(values: Option<&[(&str, &str)]>) {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| keyring::set_default_credential_builder(Box::new(TestBuilder)));
    SYSTEM.with(|system| {
        *system.borrow_mut() = values.map(|values| {
            values
                .iter()
                .map(|(account, value)| (account.to_string(), value.to_string()))
                .collect()
        })
    });
}

const A: &str = "secret:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B: &str = "secret:01ARZ3NDEKTSV4RRFFQ69G5FAW";

fn device() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config").join("app.svode.desktop");
    (dir, config)
}

#[test]
fn without_a_file_values_use_the_system_store_and_no_file_appears() {
    system(Some(&[(A, "system")]));
    let (_dir, config) = device();
    let store = DeviceSecretStore::with_environment(&config, []);
    assert_eq!(store.active().kind, StoreKind::System);
    assert_eq!(store.get(A).unwrap().as_deref(), Some("system"));
    store.set(B, "new").unwrap();
    assert_eq!(store.get(B).unwrap().as_deref(), Some("new"));
    store.remove(B).unwrap();
    assert_eq!(store.get(B).unwrap(), None);
    assert!(!config.exists(), "no file or lock is created");
    assert_eq!(store.status().problem, None);
}

#[test]
fn an_unavailable_system_store_is_refused_with_its_code() {
    system(None);
    let (_dir, config) = device();
    let store = DeviceSecretStore::with_environment(&config, []);
    let error = store.get(A).unwrap_err();
    assert_eq!(error, Error::SecretStore);
    assert_eq!(error.secret_code(), Some("SECRET_STORE_UNAVAILABLE"));
    assert_eq!(store.status().problem, Some(Error::SecretStore));
}

#[cfg(unix)]
mod file {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn enabled() -> (tempfile::TempDir, PathBuf, DeviceSecretStore) {
        let (dir, config) = device();
        let store = DeviceSecretStore::with_environment(&config, []);
        assert_eq!(store.use_file().unwrap(), UseFile::Created);
        (dir, config, store)
    }

    #[test]
    fn turning_the_file_on_creates_a_private_empty_file_and_a_repeat_changes_nothing() {
        let (_dir, config) = device();
        fs::create_dir_all(&config).unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o755)).unwrap();
        let store = DeviceSecretStore::with_environment(&config, []);
        assert_eq!(store.active().kind, StoreKind::System);
        assert_eq!(store.use_file().unwrap(), UseFile::Created);
        let file = config.join(SECRETS_FILE);
        assert_eq!(
            store.active(),
            ActiveStore {
                kind: StoreKind::File,
                file: file.clone()
            }
        );
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&config), 0o700);
        let bytes = fs::read(&file).unwrap();
        let written: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(written, serde_json::json!({"version": 1, "values": {}}));
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(
            store.use_file().unwrap(),
            UseFile::AlreadyActive { values: 0 }
        );
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), modified);
        let status = store.status();
        assert_eq!(
            (status.kind, status.problem, status.values),
            (StoreKind::File, None, Some(0))
        );
    }

    #[test]
    fn an_active_file_holds_the_values_and_the_system_store_is_never_read() {
        // The system store denies every access: any read of it would fail.
        system(None);
        let (_dir, config, store) = enabled();
        assert_eq!(store.get(A).unwrap(), None);
        store.set(A, "first").unwrap();
        store.set(B, "second").unwrap();
        store.remove(B).unwrap();
        store.remove(B).unwrap();
        assert_eq!(store.get(A).unwrap().as_deref(), Some("first"));
        assert_eq!(store.get(B).unwrap(), None);
        let file = config.join(SECRETS_FILE);
        assert_eq!(mode(&file), 0o600);
        let written: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            written,
            serde_json::json!({"version": 1, "values": {A: "first"}})
        );
        assert_eq!(store.status().values, Some(1));
    }

    #[test]
    fn an_unsafe_file_is_refused_without_a_value_or_a_repair() {
        system(None);
        let (dir, config, store) = enabled();
        store.set(A, "value").unwrap();
        let file = config.join(SECRETS_FILE);
        let bytes = fs::read(&file).unwrap();
        for unsafe_mode in [0o644, 0o640, 0o604, 0o660] {
            fs::set_permissions(&file, fs::Permissions::from_mode(unsafe_mode)).unwrap();
            assert_eq!(
                store.get(A).unwrap_err(),
                Error::SecretFileUnsafe,
                "{unsafe_mode:o}"
            );
            assert_eq!(store.set(B, "other").unwrap_err(), Error::SecretFileUnsafe);
            assert_eq!(store.use_file().unwrap_err(), Error::SecretFileUnsafe);
            assert_eq!(store.status().problem, Some(Error::SecretFileUnsafe));
            assert_eq!(store.active().kind, StoreKind::File);
            assert_eq!(mode(&file), unsafe_mode, "permissions are not repaired");
        }
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), bytes);

        // A symbolic link to a private file is refused too, dangling or not.
        let target = dir.path().join("elsewhere.json");
        fs::rename(&file, &target).unwrap();
        std::os::unix::fs::symlink(&target, &file).unwrap();
        assert_eq!(store.active().kind, StoreKind::File);
        assert_eq!(store.get(A).unwrap_err(), Error::SecretFileUnsafe);
        assert_eq!(store.set(B, "other").unwrap_err(), Error::SecretFileUnsafe);
        fs::remove_file(&target).unwrap();
        assert_eq!(store.get(A).unwrap_err(), Error::SecretFileUnsafe);
        assert_eq!(
            Error::SecretFileUnsafe.secret_code(),
            Some("SECRET_FILE_UNSAFE")
        );
    }

    #[test]
    fn a_damaged_file_or_unknown_version_is_refused_and_never_rewritten() {
        system(None);
        let (_dir, config, store) = enabled();
        let file = config.join(SECRETS_FILE);
        for damaged in [
            "{".to_string(),
            "[]".into(),
            r#"{"values":{}}"#.into(),
            r#"{"version":2,"values":{}}"#.into(),
            r#"{"version":1,"values":{"not-a-reference":"value"}}"#.into(),
            format!(r#"{{"version":1,"values":{{"{A}":1}}}}"#),
            format!(r#"{{"version":1,"values":{{}},"extra":true}}"#),
        ] {
            fs::write(&file, &damaged).unwrap();
            assert_eq!(
                store.get(A).unwrap_err(),
                Error::SecretFileInvalid,
                "{damaged}"
            );
            assert_eq!(store.set(A, "value").unwrap_err(), Error::SecretFileInvalid);
            assert_eq!(store.remove(A).unwrap_err(), Error::SecretFileInvalid);
            assert_eq!(store.use_file().unwrap_err(), Error::SecretFileInvalid);
            assert_eq!(
                store.use_system(false).unwrap_err(),
                Error::SecretFileInvalid
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), damaged);
            assert_eq!(store.status().problem, Some(Error::SecretFileInvalid));
        }
        assert_eq!(
            Error::SecretFileInvalid.secret_code(),
            Some("SECRET_FILE_INVALID")
        );
    }

    #[test]
    fn concurrent_writers_lose_no_value_and_readers_never_see_a_partial_file() {
        let (_dir, config, _store) = enabled();
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let config = config.clone();
                std::thread::spawn(move || {
                    let store = DeviceSecretStore::with_environment(&config, []);
                    for round in 0..10 {
                        let account = format!("secret:01ARZ3NDEKTSV4RRFFQ69G5F{index}{round}");
                        store.set(&account, &"x".repeat(4096)).unwrap();
                    }
                })
            })
            .collect();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (config, done) = (config.clone(), done.clone());
            std::thread::spawn(move || {
                let store = DeviceSecretStore::with_environment(&config, []);
                let mut reads = 0;
                while !done.load(std::sync::atomic::Ordering::SeqCst) || reads == 0 {
                    store.get(A).expect("every read sees a whole file");
                    reads += 1;
                }
            })
        };
        for writer in writers {
            writer.join().unwrap();
        }
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        reader.join().unwrap();
        let store = DeviceSecretStore::with_environment(&config, []);
        assert_eq!(store.status().values, Some(80));
        assert_eq!(mode(&config.join(SECRETS_FILE)), 0o600);
    }

    #[test]
    fn returning_to_the_system_store_keeps_a_file_with_values_until_they_are_deleted() {
        system(Some(&[(A, "system")]));
        let (_dir, config, store) = enabled();
        assert_eq!(store.get(A).unwrap(), None, "file values only, never moved");
        store.set(B, "file").unwrap();
        let file = config.join(SECRETS_FILE);
        assert_eq!(
            store.use_system(false).unwrap(),
            UseSystem::HasValues { values: 1 }
        );
        assert!(file.exists());
        assert_eq!(
            store.use_system(true).unwrap(),
            UseSystem::Restored { deleted_values: 1 }
        );
        assert!(!file.exists());
        assert_eq!(store.active().kind, StoreKind::System);
        assert_eq!(store.get(A).unwrap().as_deref(), Some("system"));
        assert_eq!(store.use_system(false).unwrap(), UseSystem::AlreadyActive);

        // An empty file goes without an explicit deletion; a damaged one only
        // with it, since its values cannot be counted.
        store.use_file().unwrap();
        assert_eq!(
            store.use_system(false).unwrap(),
            UseSystem::Restored { deleted_values: 0 }
        );
        store.use_file().unwrap();
        fs::write(&file, "{").unwrap();
        assert_eq!(
            store.use_system(false).unwrap_err(),
            Error::SecretFileInvalid
        );
        assert_eq!(
            store.use_system(true).unwrap(),
            UseSystem::Restored { deleted_values: 0 }
        );
        assert!(!file.exists());
    }

    fn project() -> (tempfile::TempDir, PathBuf, Context) {
        let (dir, config) = device();
        let project = dir.path().join("project");
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join(".svode/config.json"), r#"{"name":"Project"}"#).unwrap();
        let context = Context::new(&project, None, &config).unwrap();
        (dir, config, context)
    }

    fn declare(store: &DeviceSecretStore, context: &Context, name: &str, value: Option<&str>) {
        let owner = Owner::in_context(context, &SourceOwner::Project).unwrap();
        let service = Service::new(store);
        let revision = service.catalog(&owner).unwrap().revision;
        service
            .save(
                &owner,
                Save {
                    name: name.into(),
                    mode: Mode::Git,
                    kind: Kind::Secret,
                    value: value.map(str::to_string),
                    revision,
                    operation: SaveOperation::Create,
                    keep: None,
                },
            )
            .unwrap();
    }

    fn resolve(store: &DeviceSecretStore, context: &Context, name: &str) -> Result<String> {
        Service::new(store)
            .resolve(context, &[name.into()], &BTreeMap::new())
            .map(|mut values| values.remove(name).unwrap().value)
    }

    #[test]
    fn the_environment_sets_a_git_secret_without_a_device_value_and_is_never_stored() {
        system(None);
        let (_dir, config, context) = project();
        let empty = DeviceSecretStore::with_environment(&config, []);
        assert_eq!(empty.use_file().unwrap(), UseFile::Created);
        declare(&empty, &context, "TOKEN", None);
        assert_eq!(
            resolve(&empty, &context, "TOKEN").unwrap_err(),
            Error::Missing
        );

        let store = DeviceSecretStore::with_environment(
            &config,
            [("SVODE_SECRET_TOKEN".to_string(), "from-env".to_string())],
        );
        assert_eq!(resolve(&store, &context, "TOKEN").unwrap(), "from-env");
        let owner = Owner::in_context(&context, &SourceOwner::Project).unwrap();
        let catalog = Service::new(&store).catalog(&owner).unwrap();
        assert!(catalog.entries.iter().all(|entry| entry.has_value));
        assert_eq!(
            store.status().values,
            Some(0),
            "nothing is written to the file"
        );

        // The name matches with case; an empty variable is not set.
        let other_case = DeviceSecretStore::with_environment(
            &config,
            [("SVODE_SECRET_token".to_string(), "lower".to_string())],
        );
        assert_eq!(
            resolve(&other_case, &context, "TOKEN").unwrap_err(),
            Error::Missing
        );
        let blank = DeviceSecretStore::with_environment(
            &config,
            [("SVODE_SECRET_TOKEN".to_string(), String::new())],
        );
        assert_eq!(
            resolve(&blank, &context, "TOKEN").unwrap_err(),
            Error::Missing
        );
        assert_eq!(Error::Missing.secret_code(), Some("SECRET_NOT_FOUND"));
    }

    #[test]
    fn the_environment_takes_precedence_and_a_store_failure_does_not_fall_back() {
        system(None);
        let (_dir, config, context) = project();
        let plain = DeviceSecretStore::with_environment(&config, []);
        plain.use_file().unwrap();
        declare(&plain, &context, "TOKEN", Some("stored"));
        assert_eq!(resolve(&plain, &context, "TOKEN").unwrap(), "stored");
        let store = DeviceSecretStore::with_environment(
            &config,
            [("SVODE_SECRET_TOKEN".to_string(), "from-env".to_string())],
        );
        assert_eq!(resolve(&store, &context, "TOKEN").unwrap(), "from-env");

        // With the variable present, a broken store is not even read.
        let file = config.join(SECRETS_FILE);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(resolve(&store, &context, "TOKEN").unwrap(), "from-env");
        // Without it the store's failure is the answer, not another source.
        assert_eq!(
            resolve(&plain, &context, "TOKEN").unwrap_err(),
            Error::SecretFileUnsafe
        );
        fs::remove_file(&file).unwrap();
        assert_eq!(
            resolve(&plain, &context, "TOKEN").unwrap_err(),
            Error::SecretStore
        );
    }

    #[test]
    fn a_secret_in_an_inherited_environment_is_removed_from_launched_processes() {
        const CHILD: &str = "SVODE_DEVICE_STORE_ENV_CHILD";
        if std::env::var_os(CHILD).is_some() {
            assert!(inherited_secret_environment().contains(&OsString::from("SVODE_SECRET_LEAK")));
            let run = |strip: bool| {
                let mut command = std::process::Command::new("/bin/sh");
                command.args(["-c", "env"]).env("SVODE_SECRET_SET", "set");
                if strip {
                    strip_secret_environment(&mut command);
                }
                command.env("SVODE_AFTER", "after");
                String::from_utf8(command.output().unwrap().stdout).unwrap()
            };
            let inherited = run(false);
            assert!(inherited.contains("SVODE_SECRET_LEAK=leak"), "{inherited}");
            let stripped = run(true);
            assert!(!stripped.contains("SVODE_SECRET_"), "{stripped}");
            assert!(stripped.contains("SVODE_VISIBLE=visible"), "{stripped}");
            assert!(stripped.contains("SVODE_AFTER=after"), "{stripped}");
            return;
        }
        assert!(is_secret_environment(OsStr::new("SVODE_SECRET_X")));
        assert!(!is_secret_environment(OsStr::new("SVODE_SECRET_")));
        assert!(!is_secret_environment(OsStr::new("SVODE_SECRETS")));
        assert!(!is_secret_environment(OsStr::new("MY_SVODE_SECRET_X")));
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "variables::device::tests::file::a_secret_in_an_inherited_environment_is_removed_from_launched_processes",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("SVODE_SECRET_LEAK", "leak")
            .env("SVODE_VISIBLE", "visible")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("1 passed;"), "{stdout}");
    }
}
