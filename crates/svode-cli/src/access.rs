//! `svode git access verify`: CLI-owned explicit verification of the
//! repository access of the selected Space. It runs the shared service-ref
//! verification of the host, which records the evidence the install shares
//! with the desktop app, and prints the resulting snapshot. Every access
//! state is a result; only a failed target or verification is a failure.

use serde_json::{Value, json};
use svode_tools::host::ToolHost;

use crate::error::CliError;
use crate::output::Outcome;
use crate::target::Selectors;
use crate::tools::envelope;

pub async fn verify(host: &impl ToolHost, selectors: Selectors<'_>) -> Result<Outcome, CliError> {
    let target = selectors.resolve()?;
    let known = target.envelope();
    let snapshot = host
        .verify_repository_access(&target.space.space_path)
        .await
        .map_err(|error| {
            let mut failure =
                CliError::operation(error.code, error.message).with_target(known.clone());
            failure.evidence = error.evidence;
            failure
        })?;
    let access = serde_json::to_value(&snapshot).unwrap_or_default();
    Ok(Outcome {
        human: human(&access),
        envelope: envelope(known, json!({ "repositoryAccess": access })),
        warnings: Vec::new(),
    })
}

fn human(access: &Value) -> String {
    let status = access["status"].as_str().unwrap_or_default();
    match access["reason"].as_str() {
        Some(reason) => format!("repository access: {status} ({reason})\n"),
        None => format!("repository access: {status}\n"),
    }
}
