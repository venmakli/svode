use super::*;

pub(super) async fn validate_app_manifest(
    args: ValidateAppManifestArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let result = crate::apps::manifest::validate_manifest_source(&args.yaml);
    let structured = match result {
        Ok(runtime) => {
            let (runtime_type, settings_references) = match runtime {
                crate::apps::manifest::ValidatedRuntime::Static { .. } => ("static", Vec::new()),
                crate::apps::manifest::ValidatedRuntime::Url { .. } => ("url", Vec::new()),
                crate::apps::manifest::ValidatedRuntime::Process(runtime) => (
                    "process",
                    crate::apps::environment::references(&runtime.environment_declaration)
                        .expect("manifest validation checked environment references"),
                ),
            };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn validates_with_the_host_parser_and_reports_only_reference_names() {
        let result = validate_app_manifest(ValidateAppManifestArgs {
            yaml: "runtime:\n  type: process\n  start:\n    argv: [bun, run, dev]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: Bearer ${API_TOKEN}\n".to_string(),
        })
        .await
        .unwrap()
        .structured_content
        .unwrap();

        assert_eq!(result["valid"], true);
        assert_eq!(result["runtimeType"], "process");
        assert_eq!(result["settingsReferences"], json!(["API_TOKEN"]));
        assert_eq!(result["diagnostics"], json!([]));
    }

    #[tokio::test]
    async fn returns_structured_diagnostics_without_touching_runtime_or_settings() {
        let result = validate_app_manifest(ValidateAppManifestArgs {
            yaml: "runtime:\n  type: url\n  url: javascript:alert(1)\n".to_string(),
        })
        .await
        .unwrap()
        .structured_content
        .unwrap();

        assert_eq!(result["valid"], false);
        assert_eq!(result["runtimeType"], Value::Null);
        assert_eq!(result["settingsReferences"], json!([]));
        assert_eq!(result["diagnostics"][0]["code"], "invalid_url");
    }
}
