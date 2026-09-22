//! stdout carries only the result; stderr carries warnings, diagnostics and usage.

use serde_json::Value;

use crate::error::CliError;

/// Successful command result in both output modes.
pub struct Outcome {
    pub envelope: Value,
    pub human: String,
    pub warnings: Vec<String>,
}

/// Rendered process output of one command.
#[derive(Debug)]
pub struct Rendered {
    pub stdout: String,
    pub stderr: String,
    pub exit: i32,
}

pub fn success(outcome: &Outcome, json: bool) -> Rendered {
    let stderr = outcome
        .warnings
        .iter()
        .map(|warning| format!("{warning}\n"))
        .collect();
    let stdout = if json {
        format!("{}\n", outcome.envelope)
    } else {
        outcome.human.clone()
    };
    Rendered {
        stdout,
        stderr,
        exit: 0,
    }
}

pub fn failure(error: &CliError, json: bool) -> Rendered {
    let stdout = if json {
        format!("{}\n", error.envelope())
    } else {
        String::new()
    };
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
    report.push('\n');
    Rendered {
        stdout,
        stderr: report,
        exit: error.exit,
    }
}
