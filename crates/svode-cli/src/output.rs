//! stdout carries only the result; stderr carries warnings, diagnostics and usage.

use std::io::Write;

use serde_json::Value;

use crate::error::CliError;

/// Successful command result in both output modes.
pub struct Outcome {
    pub envelope: Value,
    pub human: String,
    pub warnings: Vec<String>,
}

pub fn success(outcome: &Outcome, json: bool) {
    for warning in &outcome.warnings {
        eprintln!("{warning}");
    }
    if json {
        stdout(&format!("{}\n", outcome.envelope));
    } else {
        stdout(&outcome.human);
    }
}

pub fn failure(error: &CliError, json: bool) {
    if json {
        stdout(&format!("{}\n", error.envelope()));
    }
    let mut report = format!("error[{}]: {}", error.code, error.message);
    if !error.target.is_empty() {
        let target = error
            .target
            .iter()
            .map(|(key, value)| match value {
                Value::String(value) => format!("{key}={value}"),
                other => format!("{key}={other}"),
            })
            .collect::<Vec<_>>()
            .join(" ");
        report.push_str(&format!("\n  target: {target}"));
    }
    if let Some(hint) = error.hint {
        report.push_str(&format!("\n  hint: {hint}"));
    }
    if let Some(usage) = &error.usage {
        report.push_str(&format!("\n\n{usage}"));
    }
    eprintln!("{report}");
}

fn stdout(text: &str) {
    let mut out = std::io::stdout().lock();
    // A closed pipe on the reader side is not a command failure.
    let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
}
