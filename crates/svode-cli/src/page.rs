//! `page` commands.

use serde_json::json;
use svode_core::page::entry::entry_from_source;
use svode_core::page::{PageSourceError, read_standalone_page};

use crate::error::CliError;
use crate::grammar::PageReadArgs;
use crate::output::Outcome;
use crate::target::Target;

/// `svode page read`: source-only read of one standalone Page.
pub async fn read(target: Target, args: PageReadArgs) -> Result<Outcome, CliError> {
    let mut known = target.envelope();
    known.insert("path".into(), json!(args.path));
    let source = read_standalone_page(&target.space, &args.path)
        .await
        .map_err(|error| source_error(error).with_target(known.clone()))?;
    let source_version = source.version.as_str().to_string();
    let entry = entry_from_source(source).map_err(|error| {
        CliError::operation("IO_ERROR", error.to_string()).with_target(known.clone())
    })?;
    known.insert("path".into(), json!(entry.path));

    let mut warnings = entry
        .warnings
        .iter()
        .map(|warning| format!("warning[{}]: {}", warning.kind, warning.message))
        .collect::<Vec<_>>();
    if let Some(conflict) = &entry.name_conflict {
        let paths = conflict
            .conflicts
            .iter()
            .map(|evidence| evidence.path.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!(
            "warning[name_conflict]: Page title is also used by: {paths}"
        ));
    }
    let mut human = format!("{}\n\n{}", entry.path, entry.body);
    if !entry.body.is_empty() && !entry.body.ends_with('\n') {
        human.push('\n');
    }
    Ok(Outcome {
        envelope: json!({
            "schemaVersion": 1,
            "ok": true,
            "target": known,
            "page": entry,
            "sourceVersion": source_version,
        }),
        human,
        warnings,
    })
}

fn source_error(error: PageSourceError) -> CliError {
    let code = match &error {
        PageSourceError::InvalidPath(_) => "INVALID_PATH",
        PageSourceError::Forbidden(_) => "PATH_FORBIDDEN",
        PageSourceError::InvalidOwner(_) => "NOT_A_STANDALONE_PAGE",
        PageSourceError::Missing(_) => "FILE_NOT_FOUND",
        PageSourceError::InvalidEncoding(_) => "INVALID_SOURCE_ENCODING",
        PageSourceError::Access(_) => "PATH_NOT_ACCESSIBLE",
        PageSourceError::Io(_) => "IO_ERROR",
        PageSourceError::SpaceNotFound(_) => "SPACE_UNAVAILABLE",
        PageSourceError::InvalidConfig(_) => "INVALID_PROJECT_CONFIG",
    };
    CliError::operation(code, error.to_string())
}
