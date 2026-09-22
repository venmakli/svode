//! `svode doctor`: read-only diagnostics composed from existing reads. It
//! opens no index or store, and a target failure is part of the result.

use serde_json::{Value, json};
use svode_core::git::cli::GitCli;
use svode_core::index::lifecycle::index_path;
use svode_tools::dispatch::{call_tool, served_definitions};
use svode_tools::host::ToolHost;

use crate::output::Outcome;
use crate::target::Selectors;
use crate::tools::envelope;

pub async fn run(host: &impl ToolHost, selectors: Selectors<'_>) -> Outcome {
    let git = match GitCli::detect() {
        Ok(cli) => {
            let availability = cli.check_availability().await;
            json!({
                "available": availability.git,
                "version": availability.git_version,
                "lfs": availability.git_lfs,
                "lfsVersion": availability.git_lfs_version,
            })
        }
        Err(error) => json!({ "available": false, "error": error.to_string() }),
    };
    let served = served_definitions(host)
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    let (target, project, spaces) = match selectors.resolve() {
        Ok(target) => {
            let listing = call_tool(host, Some(&target.request()), "list_spaces", json!({})).await;
            let listing = listing.structured_content.unwrap_or_default();
            let spaces = listing["spaces"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|mut space| {
                    let present = space["path"]
                        .as_str()
                        .is_some_and(|path| index_path(path.as_ref()).is_file());
                    space["index"] = json!({ "present": present });
                    space
                })
                .collect::<Vec<_>>();
            let project = json!({ "ok": true, "config": "valid" });
            let project = match listing.get("error") {
                Some(error) => json!({ "ok": false, "error": error }),
                None => project,
            };
            (target.envelope(), project, spaces)
        }
        Err(error) => (
            error.target.clone(),
            json!({
                "ok": false,
                "error": { "code": error.code, "message": error.message },
            }),
            Vec::new(),
        ),
    };
    let report = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "project": project,
        "spaces": spaces,
        "git": git,
        "runtime": { "servedTools": served },
    });
    Outcome {
        human: human(&report),
        envelope: envelope(target, json!({ "doctor": report })),
        warnings: Vec::new(),
    }
}

fn human(report: &Value) -> String {
    let mut out = format!("svode {}\n", report["version"].as_str().unwrap_or_default());
    match report["project"]["ok"].as_bool() {
        Some(true) => out.push_str("project: ok\n"),
        _ => out.push_str(&format!(
            "project: {} — {}\n",
            report["project"]["error"]["code"]
                .as_str()
                .unwrap_or_default(),
            report["project"]["error"]["message"]
                .as_str()
                .unwrap_or_default()
        )),
    }
    for space in report["spaces"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "space {}: {} ({}), index {}\n",
            space["id"].as_str().unwrap_or_default(),
            space["status"].as_str().unwrap_or_default(),
            space["path"].as_str().unwrap_or_default(),
            if space["index"]["present"] == true {
                "present"
            } else {
                "absent"
            }
        ));
    }
    match report["git"]["version"].as_str() {
        Some(version) => out.push_str(&format!("git: {version}\n")),
        None => out.push_str("git: unavailable\n"),
    }
    out.push_str(&format!(
        "served tools: {}\n",
        report["runtime"]["servedTools"]
            .as_array()
            .map_or(0, Vec::len)
    ));
    out
}
