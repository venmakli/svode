use std::path::Path;

use serde::Deserialize;
use serde_json::json;
use svode_core::apps::catalog::{describe_app, list_apps as list_space_apps};

use crate::args::SpaceArgs;
use crate::error::ToolError;
use crate::host::RequestTarget;
use crate::result::ToolCallResult;
use crate::target::resolve_space;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ValidateAppManifestArgs {
    yaml: String,
}

pub(crate) fn validate_app_manifest(
    args: ValidateAppManifestArgs,
) -> Result<ToolCallResult, ToolError> {
    let result = svode_core::apps::manifest::validate_manifest_source(&args.yaml);
    let structured = match result {
        Ok(runtime) => {
            let runtime_type = runtime.runtime_type().as_str();
            let settings_references = runtime.settings_references();
            json!({
                "valid": true,
                "runtimeType": runtime_type,
                "settingsReferences": settings_references,
                "diagnostics": [],
            })
        }
        Err(diagnostics) => json!({
            "valid": false,
            "runtimeType": null,
            "settingsReferences": [],
            "diagnostics": diagnostics,
        }),
    };
    Ok(ToolCallResult::ok(
        if structured["valid"] == true {
            "App manifest is valid."
        } else {
            "App manifest is invalid."
        },
        structured,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetAppArgs {
    #[serde(default)]
    space_id: Option<String>,
    owner_path: String,
}

/// App owners of the selected Space as its tree shows them.
pub(crate) fn list_apps(
    target: &RequestTarget,
    args: SpaceArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let apps = list_space_apps(Path::new(&space))?;
    Ok(ToolCallResult::ok(
        format!("Found {} Apps.", apps.len()),
        json!({ "apps": apps }),
    ))
}

/// Description of one App with the README of its owner.
pub(crate) fn get_app(
    target: &RequestTarget,
    args: GetAppArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let app = describe_app(Path::new(&space), &args.owner_path)?;
    let summary = format!("Described App {}.", app.owner_path);
    Ok(ToolCallResult::ok(summary, json!(app)))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn validates_with_the_host_parser_and_reports_only_reference_names() {
        let result = validate_app_manifest(ValidateAppManifestArgs {
            yaml: "runtime:\n  type: process\n  start:\n    argv: [bun, run, dev]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: Bearer ${API_TOKEN}\n".to_string(),
        })
        .unwrap()
        .structured_content
        .unwrap();

        assert_eq!(result["valid"], true);
        assert_eq!(result["runtimeType"], "process");
        assert_eq!(result["settingsReferences"], json!(["API_TOKEN"]));
        assert_eq!(result["diagnostics"], json!([]));
    }

    #[test]
    fn returns_structured_diagnostics_without_touching_runtime_or_settings() {
        let result = validate_app_manifest(ValidateAppManifestArgs {
            yaml: "runtime:\n  type: url\n  url: javascript:alert(1)\n".to_string(),
        })
        .unwrap()
        .structured_content
        .unwrap();

        assert_eq!(result["valid"], false);
        assert_eq!(result["runtimeType"], Value::Null);
        assert_eq!(result["settingsReferences"], json!([]));
        assert_eq!(result["diagnostics"][0]["code"], "invalid_url");
    }
}
