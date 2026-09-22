//! Structured input of one command from a file or stdin (`-`). A command
//! reads stdin at most once.

use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::error::CliError;

/// Rejects a command that names stdin for more than one flag, before any
/// input is read.
pub fn one_stdin(flags: &[(&str, Option<&str>)]) -> Result<(), CliError> {
    let stdin = flags
        .iter()
        .filter(|(_, source)| *source == Some("-"))
        .map(|(flag, _)| format!("--{flag}"))
        .collect::<Vec<_>>();
    if stdin.len() > 1 {
        return Err(CliError::argument(format!(
            "only one flag can read stdin, got {}",
            stdin.join(" and ")
        )));
    }
    Ok(())
}

/// Text of `--<flag> <path|->`; a relative path is read from `cwd`.
pub fn text(cwd: &Path, flag: &str, source: &str) -> Result<String, CliError> {
    if source == "-" {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| {
                CliError::input("INPUT_UNREADABLE", format!("--{flag}: stdin: {error}"))
            })?;
        return Ok(text);
    }
    let path = cwd.join(source);
    std::fs::read_to_string(&path).map_err(|error| {
        CliError::input(
            "INPUT_UNREADABLE",
            format!("--{flag}: {}: {error}", path.display()),
        )
    })
}

/// JSON value of `--<flag> <path|->`; a relative path is read from `cwd`.
pub fn json(cwd: &Path, flag: &str, source: &str) -> Result<Value, CliError> {
    serde_json::from_str(&text(cwd, flag, source)?).map_err(|error| {
        CliError::input("INVALID_ARGUMENT", format!("--{flag}: not JSON: {error}"))
    })
}
