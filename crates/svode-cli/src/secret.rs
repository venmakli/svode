//! `svode secret`: Secret values of this device without the desktop app,
//! through the device store and the Variables service of `svode-core`. The
//! commands exist only in the CLI: no catalog tool serves them. A value comes
//! only from stdin and never appears in output, errors or logs.

use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use svode_core::variables::{
    Context, DeviceSecretStore, Error, Failure, Kind, Mode, Owner, SECRET_STORE_UNAVAILABLE,
    Service, SourceOwner, StoreKind, UseSystem, valid_name,
};

use crate::error::CliError;
use crate::grammar::{SecretNameArgs, SecretOwner, SecretStoreChoice, SecretStoreVerb, SecretVerb};
use crate::output::Outcome;
use crate::target::Selectors;
use crate::tools::envelope;

/// `use system` refused while the secrets file holds values.
const SECRET_VALUES_PRESENT: &str = "SECRET_VALUES_PRESENT";
/// `use file` on a platform where the secrets file is never used.
#[cfg(not(unix))]
const SECRET_FILE_UNSUPPORTED: &str = "SECRET_FILE_UNSUPPORTED";
/// A Variables failure without a Secret code of its own; `reason` names it.
const VARIABLES_ERROR: &str = "VARIABLES_ERROR";

pub async fn run(verb: SecretVerb, selectors: &Selectors<'_>) -> Result<Outcome, CliError> {
    let config = config_dir()?;
    let store = DeviceSecretStore::new(&config);
    match verb {
        SecretVerb::Store {
            verb: SecretStoreVerb::Status,
        } => Ok(status(&store)),
        SecretVerb::Store {
            verb:
                SecretStoreVerb::Use {
                    store: SecretStoreChoice::File,
                },
        } => use_file(&store),
        SecretVerb::Store {
            verb:
                SecretStoreVerb::Use {
                    store: SecretStoreChoice::System { delete_values },
                },
        } => use_system(&store, delete_values),
        SecretVerb::List(args) => list(&store, &config, selectors, args.owner),
        SecretVerb::Set(args) => set(&store, &config, selectors, args).await,
        SecretVerb::Remove(args) => remove(&store, &config, selectors, args),
    }
}

/// Active store and safety of the secrets file for `svode doctor`. The
/// system password store is not touched; `secret store status` checks it.
pub fn diagnostics() -> Value {
    let config = match config_dir() {
        Ok(config) => config,
        Err(error) => {
            return json!({
                "store": null,
                "file": null,
                "problem": { "code": error.code, "message": error.message, "hint": error.evidence.get("hint") },
            });
        }
    };
    let store = DeviceSecretStore::new(&config);
    let active = store.active();
    let problem = match active.kind {
        StoreKind::File => store.status().problem,
        StoreKind::System => None,
    };
    json!({
        "store": active.kind,
        "file": active.file.display().to_string(),
        "problem": problem.map(|error| problem_report(&error, &active.file)),
    })
}

pub(crate) fn config_dir() -> Result<PathBuf, CliError> {
    svode_core::runtime::device::config_dir().ok_or_else(|| {
        let mut failure = CliError::operation(
            SECRET_STORE_UNAVAILABLE,
            "This account has no device config directory: HOME is not set or SVODE_PRODUCT_IDENTIFIER is not one path segment",
        );
        failure.evidence.insert(
            "hint".into(),
            json!("set HOME, or pass the value as SVODE_SECRET_<NAME>"),
        );
        failure
    })
}

/// Refusal for a Variables failure: the stable Secret code with its next
/// step, otherwise `VARIABLES_ERROR` with the cause and the config file.
fn failure(
    failure: impl Into<Failure>,
    secrets: &Path,
    name: Option<&str>,
    target: Map<String, Value>,
) -> CliError {
    let Failure { error, file, .. } = failure.into();
    let code = error.secret_code().unwrap_or(VARIABLES_ERROR);
    let mut refusal = CliError::operation(code, error.to_string()).with_target(target);
    let file = match error {
        Error::SecretFileUnsafe | Error::SecretFileInvalid => Some(secrets.to_path_buf()),
        _ if code == VARIABLES_ERROR => file,
        _ => None,
    };
    if code == VARIABLES_ERROR {
        refusal.evidence.insert(
            "reason".into(),
            serde_json::to_value(&error).unwrap_or_default(),
        );
    }
    if let Some(file) = file {
        refusal
            .evidence
            .insert("file".into(), json!(file.display().to_string()));
    }
    let hint = error
        .secret_hint(secrets, name)
        .or_else(|| match (&error, name) {
            (Error::Collision, Some(name)) => Some(format!(
                "run `svode secret remove {name}` to keep the declaration in Git"
            )),
            _ => None,
        });
    if let Some(hint) = hint {
        refusal.evidence.insert("hint".into(), json!(hint));
    }
    refusal
}

fn problem_report(error: &Error, secrets: &Path) -> Value {
    json!({
        "code": error.secret_code().unwrap_or(VARIABLES_ERROR),
        "message": error.to_string(),
        "hint": error.secret_hint(secrets, None),
    })
}

fn values(count: usize) -> String {
    match count {
        1 => "1 value".into(),
        count => format!("{count} values"),
    }
}

fn store_name(kind: StoreKind, file: &Path) -> String {
    match kind {
        StoreKind::File => format!("the secrets file {}", file.display()),
        StoreKind::System => "the system password store".into(),
    }
}

fn status(store: &DeviceSecretStore) -> Outcome {
    let status = store.status();
    let file = status.file.display().to_string();
    let problem = status
        .problem
        .as_ref()
        .map(|error| problem_report(error, &status.file));
    let mut human = match status.kind {
        StoreKind::File => format!("store: file {file}\n"),
        StoreKind::System => "store: system password store\n".to_string(),
    };
    match &problem {
        None => human.push_str("available: yes\n"),
        Some(problem) => human.push_str(&format!(
            "available: no — {}: {}\n  hint: {}\n",
            problem["code"].as_str().unwrap_or_default(),
            problem["message"].as_str().unwrap_or_default(),
            problem["hint"].as_str().unwrap_or_default(),
        )),
    }
    match (status.kind, status.values) {
        (StoreKind::File, Some(count)) => human.push_str(&format!("values: {count}\n")),
        (StoreKind::System, _) => human.push_str(&format!("secrets file: {file} (absent)\n")),
        _ => {}
    }
    Outcome {
        human,
        envelope: envelope(
            Map::new(),
            json!({ "store": {
                "kind": status.kind,
                "file": file,
                "available": problem.is_none(),
                "problem": problem,
                "values": status.values,
            }}),
        ),
        warnings: Vec::new(),
    }
}

#[cfg(unix)]
fn use_file(store: &DeviceSecretStore) -> Result<Outcome, CliError> {
    use svode_core::variables::UseFile;
    let file = store.file();
    let (created, count) = match store
        .use_file()
        .map_err(|error| failure(error, &file, None, Map::new()))?
    {
        UseFile::Created => (true, 0),
        UseFile::AlreadyActive { values } => (false, values),
    };
    let human = if created {
        format!(
            "The secrets file {} is now the active store.\nValues were not moved from the system password store: set them again with `svode secret set <NAME>`.\n",
            file.display()
        )
    } else {
        format!(
            "The secrets file {} is already the active store with {}; nothing changed.\n",
            file.display(),
            values(count)
        )
    };
    Ok(Outcome {
        human,
        envelope: envelope(
            Map::new(),
            json!({
                "store": { "kind": StoreKind::File, "file": file.display().to_string() },
                "created": created,
                "values": count,
                "valuesMoved": false,
            }),
        ),
        warnings: Vec::new(),
    })
}

#[cfg(not(unix))]
fn use_file(_: &DeviceSecretStore) -> Result<Outcome, CliError> {
    let mut refusal = CliError::operation(
        SECRET_FILE_UNSUPPORTED,
        "The secrets file is not available on Windows: Secret values stay in the system password store",
    );
    refusal.evidence.insert(
        "hint".into(),
        json!(
            "pass the value as SVODE_SECRET_<NAME> when the system password store cannot be used"
        ),
    );
    Err(refusal)
}

fn use_system(store: &DeviceSecretStore, delete_values: bool) -> Result<Outcome, CliError> {
    let file = store.file();
    let shown = file.display();
    let (changed, deleted, human) = match store
        .use_system(delete_values)
        .map_err(|error| failure(error, &file, None, Map::new()))?
    {
        UseSystem::AlreadyActive => (
            false,
            Some(0),
            "The system password store is already the active store; nothing changed.\n".to_string(),
        ),
        UseSystem::Restored {
            deleted_values: Some(count),
        } => (
            true,
            Some(count),
            format!(
                "Removed the secrets file {shown} with {}; the system password store is the active store again.\nValues were not moved to it.\n",
                values(count)
            ),
        ),
        UseSystem::Restored {
            deleted_values: None,
        } => (
            true,
            None,
            format!(
                "Removed the unreadable secrets file {shown}; its values could not be counted. The system password store is the active store again.\nValues were not moved to it.\n"
            ),
        ),
        UseSystem::HasValues { values: count } => {
            let mut refusal = CliError::operation(
                SECRET_VALUES_PRESENT,
                format!(
                    "The secrets file {shown} holds {} and was kept",
                    values(count)
                ),
            );
            refusal.evidence.insert("values".into(), json!(count));
            refusal
                .evidence
                .insert("file".into(), json!(shown.to_string()));
            refusal.evidence.insert(
                "hint".into(),
                json!(
                    "run `svode secret store use system --delete-values` to delete them with the file"
                ),
            );
            return Err(refusal);
        }
    };
    Ok(Outcome {
        human,
        envelope: envelope(
            Map::new(),
            json!({
                "store": { "kind": StoreKind::System, "file": shown.to_string() },
                "changed": changed,
                "deletedValues": deleted,
                "valuesMoved": false,
            }),
        ),
        warnings: Vec::new(),
    })
}

/// Variables owner of a command with its label and resolved target.
struct Selected {
    owner: Owner,
    label: &'static str,
    target: Map<String, Value>,
}

/// `device` needs no Project; `project` and `space` resolve the target like
/// every command, and the root Space is the Project, as in the desktop app.
fn select(
    owner: SecretOwner,
    config: &Path,
    selectors: &Selectors<'_>,
    secrets: &Path,
) -> Result<Selected, CliError> {
    if owner == SecretOwner::Device {
        return Ok(Selected {
            owner: Owner::global(config)
                .map_err(|error| failure(error, secrets, None, Map::new()))?,
            label: "device",
            target: Map::new(),
        });
    }
    let target = selectors.resolve()?;
    let known = target.envelope();
    let space = match owner {
        SecretOwner::Space => target.space.space_id.clone(),
        _ => None,
    };
    let source = space
        .clone()
        .map_or(SourceOwner::Project, |id| SourceOwner::Space { id });
    let resolved = Context::new(&target.space.project_path, space.as_deref(), config)
        .and_then(|context| Owner::in_context(&context, &source))
        .map_err(|error| failure(error, secrets, None, known.clone()))?;
    Ok(Selected {
        owner: resolved,
        label: match owner {
            SecretOwner::Space => "space",
            _ => "project",
        },
        target: known,
    })
}

fn checked_name(name: &str) -> Result<(), CliError> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(CliError::argument(format!(
            "{name}: {}",
            Error::InvalidName
        )))
    }
}

fn mode(mode: Mode) -> &'static str {
    match mode {
        Mode::Local => "local",
        Mode::Git => "git",
    }
}

fn list(
    store: &DeviceSecretStore,
    config: &Path,
    selectors: &Selectors<'_>,
    owner: SecretOwner,
) -> Result<Outcome, CliError> {
    let file = store.file();
    let selected = select(owner, config, selectors, &file)?;
    let catalog = Service::new(store)
        .catalog(&selected.owner)
        .map_err(|error| failure(error, &file, None, selected.target.clone()))?;
    let secrets = catalog
        .entries
        .iter()
        .filter(|entry| entry.kind == Kind::Secret)
        .collect::<Vec<_>>();
    let collisions = catalog
        .collisions
        .iter()
        .filter(|name| secrets.iter().any(|entry| &&entry.name == name))
        .collect::<Vec<_>>();
    let mut human = String::new();
    if secrets.is_empty() {
        human.push_str(&format!(
            "No Secrets are declared for {}.\n",
            selected.label
        ));
    }
    for entry in &secrets {
        human.push_str(&format!(
            "{} {} {}{}\n",
            entry.name,
            mode(entry.mode),
            if entry.has_value { "set" } else { "not set" },
            if collisions.contains(&&entry.name) {
                " (collision)"
            } else {
                ""
            }
        ));
    }
    Ok(Outcome {
        human,
        envelope: envelope(
            selected.target,
            json!({
                "owner": selected.label,
                "secrets": secrets
                    .iter()
                    .map(|entry| json!({
                        "name": entry.name,
                        "mode": mode(entry.mode),
                        "hasValue": entry.has_value,
                    }))
                    .collect::<Vec<_>>(),
                "collisions": collisions,
            }),
        ),
        warnings: Vec::new(),
    })
}

async fn set(
    store: &DeviceSecretStore,
    config: &Path,
    selectors: &Selectors<'_>,
    args: SecretNameArgs,
) -> Result<Outcome, CliError> {
    let name = args.name;
    checked_name(&name)?;
    let file = store.file();
    let selected = select(args.owner.owner, config, selectors, &file)?;
    let value = read_value(&name).await?;
    let set = Service::new(store)
        .set_secret(&selected.owner, &name, value)
        .map_err(|error| failure(error, &file, Some(&name), selected.target.clone()))?;
    let active = store.active();
    Ok(Outcome {
        human: format!(
            "Set the {} {} Secret {name} in {}.\n",
            mode(set.mode),
            selected.label,
            store_name(active.kind, &active.file)
        ),
        envelope: envelope(
            selected.target,
            json!({
                "owner": selected.label,
                "name": name,
                "mode": mode(set.mode),
                "created": set.created,
                "store": { "kind": active.kind, "file": active.file.display().to_string() },
            }),
        ),
        warnings: Vec::new(),
    })
}

fn remove(
    store: &DeviceSecretStore,
    config: &Path,
    selectors: &Selectors<'_>,
    args: SecretNameArgs,
) -> Result<Outcome, CliError> {
    let name = args.name;
    checked_name(&name)?;
    let file = store.file();
    let selected = select(args.owner.owner, config, selectors, &file)?;
    let removed = Service::new(store)
        .remove_secret(&selected.owner, &name)
        .map_err(|error| failure(error, &file, Some(&name), selected.target.clone()))?;
    let human = match (removed.mode, removed.value_removed) {
        (Mode::Local, _) => format!(
            "Removed the local {} Secret {name} with its value on this device.\n",
            selected.label
        ),
        (Mode::Git, true) => format!(
            "Removed the value of the Secret {name} on this device; its declaration in Git stays.\n"
        ),
        (Mode::Git, false) => format!(
            "The Secret {name} has no value on this device; its declaration in Git stays.\n"
        ),
    };
    Ok(Outcome {
        human,
        envelope: envelope(
            selected.target,
            json!({
                "owner": selected.label,
                "name": name,
                "mode": mode(removed.mode),
                "removedDeclaration": removed.mode == Mode::Local,
                "removedValue": removed.value_removed,
            }),
        ),
        warnings: Vec::new(),
    })
}

/// The value from stdin: a line typed with echo off in a terminal, otherwise
/// everything up to the end of input. One trailing line break is dropped and
/// an empty value is an input failure. The read runs on its own thread, so a
/// signal still stops the command, and dropping the command restores echo.
async fn read_value(name: &str) -> Result<String, CliError> {
    let terminal = std::io::stdin().is_terminal();
    let _hidden = if terminal {
        eprint!("Value of {name}: ");
        let _ = std::io::stderr().flush();
        Some(HiddenInput::new().map_err(|error| {
            CliError::input(
                "INPUT_UNREADABLE",
                format!("stdin: the typed value cannot be hidden: {error}"),
            )
        })?)
    } else {
        None
    };
    // Ends the prompt line however the read ends, an interrupt included.
    struct EndLine(bool);
    impl Drop for EndLine {
        fn drop(&mut self) {
            if self.0 {
                eprintln!();
            }
        }
    }
    let end_line = EndLine(terminal);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut bytes = Vec::new();
        let read = if terminal {
            stdin.read_until(b'\n', &mut bytes)
        } else {
            stdin.read_to_end(&mut bytes)
        };
        let _ = sender.send(read.map(|_| bytes));
    });
    let read = receiver.await;
    drop(end_line);
    let bytes = match read {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            return Err(CliError::input(
                "INPUT_UNREADABLE",
                format!("stdin: {error}"),
            ));
        }
        Err(_) => return Err(CliError::input("INPUT_UNREADABLE", "stdin: not read")),
    };
    let mut value = String::from_utf8(bytes)
        .map_err(|_| CliError::input("INPUT_UNREADABLE", "stdin: the value is not UTF-8"))?;
    if value.ends_with('\n') {
        value.pop();
        if value.ends_with('\r') {
            value.pop();
        }
    }
    if value.is_empty() {
        return Err(CliError::argument("the Secret value from stdin is empty"));
    }
    Ok(value)
}

/// Terminal echo of stdin turned off until drop.
#[cfg(unix)]
struct HiddenInput(libc::termios);

#[cfg(unix)]
impl HiddenInput {
    fn new() -> std::io::Result<Self> {
        let mut saved = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: `tcgetattr` writes the settings of stdin into `saved`.
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, saved.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: initialized by the successful call above.
        let saved = unsafe { saved.assume_init() };
        let mut hidden = saved;
        hidden.c_lflag &= !libc::ECHO;
        // SAFETY: `hidden` is a valid copy of the settings of stdin.
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &hidden) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self(saved))
    }
}

#[cfg(unix)]
impl Drop for HiddenInput {
    fn drop(&mut self) {
        // SAFETY: restores the settings read from stdin in `new`.
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0);
        }
    }
}

/// Console echo of stdin turned off until drop.
#[cfg(windows)]
struct HiddenInput(windows_sys::Win32::System::Console::CONSOLE_MODE);

#[cfg(windows)]
impl HiddenInput {
    fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::System::Console::{
            ENABLE_ECHO_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode,
        };
        let mut mode = 0;
        // SAFETY: the standard input handle and a valid out pointer.
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            if GetConsoleMode(handle, &mut mode) == 0
                || SetConsoleMode(handle, mode & !ENABLE_ECHO_INPUT) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(Self(mode))
    }
}

#[cfg(windows)]
impl Drop for HiddenInput {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode};
        // SAFETY: restores the console mode read in `new`.
        unsafe {
            SetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), self.0);
        }
    }
}
