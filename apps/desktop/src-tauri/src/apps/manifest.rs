use std::borrow::Cow;
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_yml::Value;
use serde_yml::libyml::parser::{Event, Parser};

use crate::AppError;
use crate::attachments::source::resolve_registered_owner;
use crate::files::tree::child_folder_names;
use crate::repo_path::{RootMode, normalize_repo_relative};

use super::environment;

pub(crate) const APP_MANIFEST_NAME: &str = "app.yaml";
const MAX_APP_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AppRuntimeType {
    Static,
    Process,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppManifestDiagnostic {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValidatedRuntime {
    Static { public_root: String, entry: String },
    Process(AppProcessRuntime),
    Url { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppCommandRecipe {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub inputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppProcessRuntime {
    pub setup: Option<AppCommandRecipe>,
    pub start: AppCommandRecipe,
    pub url: String,
    pub environment: BTreeMap<String, String>,
    pub environment_declaration: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedAppOwner {
    pub project_path: PathBuf,
    pub owner_path: PathBuf,
}

enum YamlContainer {
    Mapping {
        expecting_key: bool,
        keys: HashSet<String>,
    },
    Sequence,
}

pub(crate) fn has_direct_app_manifest(directory: &Path) -> bool {
    find_direct_app_manifest(directory).ok().flatten().is_some()
}

fn find_direct_app_manifest(directory: &Path) -> std::io::Result<Option<PathBuf>> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name() == OsStr::new(APP_MANIFEST_NAME) {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}

pub(crate) fn resolve_app_owner(
    project_path: &Path,
    space_id: Option<&str>,
    owner_path: &str,
) -> Result<ResolvedAppOwner, AppError> {
    let registered = resolve_registered_owner(project_path, space_id)?;
    if owner_path.trim().is_empty() || owner_path == "." {
        return Ok(ResolvedAppOwner {
            project_path: registered.project_path,
            owner_path: registered.owner_path,
        });
    }

    let normalized = normalize_repo_relative(owner_path, RootMode::Reject)?;
    let first_component = Path::new(&normalized)
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().to_string());
    if first_component
        .as_ref()
        .is_some_and(|component| child_folder_names(&registered.space_path).contains(component))
    {
        return Err(AppError::PathNotAccessible(format!(
            "App owner crosses a registered Space boundary: {normalized}"
        )));
    }

    let mut candidate = registered.space_path.clone();
    for component in Path::new(&normalized).components() {
        candidate.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::PathNotAccessible(format!(
                "App owner path contains a symbolic link: {}",
                candidate.display()
            )));
        }
    }
    let metadata = fs::symlink_metadata(&candidate)?;
    if !metadata.is_dir() {
        return Err(AppError::PathNotAccessible(format!(
            "App owner is not a directory: {}",
            candidate.display()
        )));
    }
    let canonical = fs::canonicalize(candidate)?;
    if !canonical.starts_with(&registered.space_path) {
        return Err(AppError::PathNotAccessible(format!(
            "App owner escapes Space boundary: {normalized}"
        )));
    }

    Ok(ResolvedAppOwner {
        project_path: registered.project_path,
        owner_path: canonical,
    })
}

pub(crate) fn read_and_validate_manifest(
    owner: &Path,
) -> Result<Option<Result<ValidatedRuntime, Vec<AppManifestDiagnostic>>>, AppError> {
    let Some(manifest_path) = find_direct_app_manifest(owner)? else {
        return Ok(None);
    };
    let metadata = fs::symlink_metadata(&manifest_path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(Some(Err(vec![diagnostic(
            "invalid_source",
            "$",
            "app.yaml must be a regular file",
        )])));
    }
    if metadata.len() > MAX_APP_MANIFEST_BYTES {
        return Ok(Some(Err(vec![diagnostic(
            "resource_limit",
            "$",
            "app.yaml exceeds the 64 KiB limit",
        )])));
    }
    let bytes = fs::read(&manifest_path)?;
    let source = match String::from_utf8(bytes) {
        Ok(source) => source,
        Err(_) => {
            return Ok(Some(Err(vec![diagnostic(
                "invalid_encoding",
                "$",
                "app.yaml must be UTF-8",
            )])));
        }
    };
    Ok(Some(validate_manifest_source(&source)))
}

pub(crate) fn validate_manifest_source(
    source: &str,
) -> Result<ValidatedRuntime, Vec<AppManifestDiagnostic>> {
    if source.len() as u64 > MAX_APP_MANIFEST_BYTES {
        return Err(vec![diagnostic(
            "resource_limit",
            "$",
            "app.yaml exceeds the 64 KiB limit",
        )]);
    }
    validate_safe_yaml(source)?;
    let value = serde_yml::from_str::<Value>(source).map_err(|error| {
        vec![diagnostic(
            "invalid_yaml",
            "$",
            format!("Cannot parse app.yaml: {error}"),
        )]
    })?;
    validate_manifest_value(&value)
}

fn validate_safe_yaml(source: &str) -> Result<(), Vec<AppManifestDiagnostic>> {
    let mut parser = Parser::new(Cow::Borrowed(source.as_bytes()));
    let mut documents = 0_u8;
    let mut containers: Vec<YamlContainer> = Vec::new();

    loop {
        let event = parser.parse_next_event().map_err(|error| {
            vec![diagnostic(
                "invalid_yaml",
                "$",
                format!("Cannot parse app.yaml: {error}"),
            )]
        })?;
        match event.0 {
            Event::StreamStart => {}
            Event::StreamEnd => break,
            Event::DocumentStart => {
                documents += 1;
                if documents > 1 {
                    return Err(vec![diagnostic(
                        "multiple_documents",
                        "$",
                        "app.yaml must contain exactly one YAML document",
                    )]);
                }
            }
            Event::DocumentEnd => {}
            Event::Alias(_) => {
                return Err(vec![diagnostic(
                    "unsafe_yaml",
                    "$",
                    "YAML aliases are not allowed",
                )]);
            }
            Event::Scalar(scalar) => {
                if scalar.anchor.is_some() || scalar.tag.is_some() {
                    return Err(vec![diagnostic(
                        "unsafe_yaml",
                        "$",
                        "YAML anchors and tags are not allowed",
                    )]);
                }
                if let Some(YamlContainer::Mapping {
                    expecting_key,
                    keys,
                }) = containers.last_mut()
                {
                    if *expecting_key {
                        let key = String::from_utf8_lossy(&scalar.value).into_owned();
                        if key == "<<" {
                            return Err(vec![diagnostic(
                                "unsafe_yaml",
                                "$",
                                "YAML merge keys are not allowed",
                            )]);
                        }
                        if !keys.insert(key.clone()) {
                            return Err(vec![diagnostic(
                                "duplicate_key",
                                "$",
                                format!("Duplicate mapping key: {key}"),
                            )]);
                        }
                        *expecting_key = false;
                    } else {
                        *expecting_key = true;
                    }
                }
            }
            Event::SequenceStart(sequence) => {
                if sequence.anchor.is_some() || sequence.tag.is_some() {
                    return Err(vec![diagnostic(
                        "unsafe_yaml",
                        "$",
                        "YAML anchors and tags are not allowed",
                    )]);
                }
                consume_collection_value(&mut containers)?;
                containers.push(YamlContainer::Sequence);
            }
            Event::MappingStart(mapping) => {
                if mapping.anchor.is_some() || mapping.tag.is_some() {
                    return Err(vec![diagnostic(
                        "unsafe_yaml",
                        "$",
                        "YAML anchors and tags are not allowed",
                    )]);
                }
                consume_collection_value(&mut containers)?;
                containers.push(YamlContainer::Mapping {
                    expecting_key: true,
                    keys: HashSet::new(),
                });
            }
            Event::SequenceEnd => {
                if !matches!(containers.pop(), Some(YamlContainer::Sequence)) {
                    return Err(vec![diagnostic(
                        "invalid_yaml",
                        "$",
                        "Unexpected sequence end",
                    )]);
                }
            }
            Event::MappingEnd => {
                if matches!(
                    containers.pop(),
                    Some(YamlContainer::Mapping {
                        expecting_key: false,
                        ..
                    })
                ) {
                    return Err(vec![diagnostic(
                        "invalid_yaml",
                        "$",
                        "Mapping key has no value",
                    )]);
                }
            }
        }
    }
    if documents != 1 {
        return Err(vec![diagnostic(
            "invalid_yaml",
            "$",
            "app.yaml must contain one YAML document",
        )]);
    }
    Ok(())
}

fn consume_collection_value(
    containers: &mut [YamlContainer],
) -> Result<(), Vec<AppManifestDiagnostic>> {
    if let Some(YamlContainer::Mapping { expecting_key, .. }) = containers.last_mut() {
        if *expecting_key {
            return Err(vec![diagnostic(
                "invalid_schema",
                "$",
                "Mapping keys must be strings",
            )]);
        }
        *expecting_key = true;
    }
    Ok(())
}

fn validate_manifest_value(value: &Value) -> Result<ValidatedRuntime, Vec<AppManifestDiagnostic>> {
    let root = mapping(value, "$")?;
    reject_unknown(root, &["runtime", "environment"], "$")?;
    let runtime = required_mapping(root, "runtime", "runtime")?;
    let runtime_type = required_string(runtime, "type", "runtime.type")?;

    match runtime_type.as_str() {
        "static" => {
            reject_unknown(runtime, &["type", "publicRoot", "entry"], "runtime")?;
            if root.contains_key(Value::String("environment".to_string())) {
                return Err(vec![diagnostic(
                    "field_not_allowed",
                    "environment",
                    "environment is only allowed for process Apps",
                )]);
            }
            let public_root =
                required_relative_path(runtime, "publicRoot", "runtime.publicRoot", true)?;
            let entry = required_relative_path(runtime, "entry", "runtime.entry", false)?;
            Ok(ValidatedRuntime::Static { public_root, entry })
        }
        "url" => {
            reject_unknown(runtime, &["type", "url"], "runtime")?;
            if root.contains_key(Value::String("environment".to_string())) {
                return Err(vec![diagnostic(
                    "field_not_allowed",
                    "environment",
                    "environment is only allowed for process Apps",
                )]);
            }
            Ok(ValidatedRuntime::Url {
                url: required_http_url(runtime, "url", "runtime.url")?,
            })
        }
        "process" => {
            reject_unknown(runtime, &["type", "setup", "start", "url"], "runtime")?;
            let setup = if let Some(setup) = optional_mapping(runtime, "setup", "runtime.setup")? {
                reject_unknown(setup, &["argv", "cwd", "inputs"], "runtime.setup")?;
                Some(parse_command(setup, "runtime.setup", true)?)
            } else {
                None
            };
            let start = required_mapping(runtime, "start", "runtime.start")?;
            reject_unknown(start, &["argv", "cwd"], "runtime.start")?;
            let start = parse_command(start, "runtime.start", false)?;
            let environment = if let Some(environment) = get(root, "environment") {
                let environment = mapping(environment, "environment")?;
                let mut parsed = BTreeMap::new();
                for (key, value) in environment {
                    let Value::String(name) = key else {
                        return Err(vec![diagnostic(
                            "invalid_schema",
                            "environment",
                            "environment names must be non-empty strings",
                        )]);
                    };
                    if name.is_empty() {
                        return Err(vec![diagnostic(
                            "invalid_schema",
                            "environment",
                            "environment names must be non-empty strings",
                        )]);
                    }
                    if !environment::is_variable_name(name) {
                        return Err(vec![diagnostic(
                            "invalid_environment_name",
                            format!("environment.{name}"),
                            "environment names must match [A-Za-z_][A-Za-z0-9_]*",
                        )]);
                    }
                    let Value::String(value) = value else {
                        return Err(vec![diagnostic(
                            "invalid_schema",
                            "environment",
                            "environment values must be strings",
                        )]);
                    };
                    parsed.insert(name.clone(), value.clone());
                }
                environment::references(&parsed).map_err(|error| {
                    vec![diagnostic(
                        "invalid_environment_reference",
                        "environment",
                        error.message,
                    )]
                })?;
                parsed
            } else {
                BTreeMap::new()
            };
            Ok(ValidatedRuntime::Process(AppProcessRuntime {
                setup,
                start,
                url: required_http_url(runtime, "url", "runtime.url")?,
                environment: environment.clone(),
                environment_declaration: environment,
            }))
        }
        _ => Err(vec![diagnostic(
            "invalid_value",
            "runtime.type",
            "runtime.type must be static, process, or url",
        )]),
    }
}

fn parse_command(
    command: &serde_yml::Mapping,
    path: &str,
    allow_inputs: bool,
) -> Result<AppCommandRecipe, Vec<AppManifestDiagnostic>> {
    let argv_value = get(command, "argv").ok_or_else(|| {
        vec![diagnostic(
            "missing_field",
            format!("{path}.argv"),
            "argv is required",
        )]
    })?;
    validate_string_array(argv_value, &format!("{path}.argv"), false)?;
    let Value::Sequence(argv_values) = argv_value else {
        unreachable!("validated as a sequence")
    };
    let argv = argv_values
        .iter()
        .map(|value| match value {
            Value::String(value) => value.clone(),
            _ => unreachable!("validated as a string"),
        })
        .collect();
    let cwd = if let Some(cwd) = get(command, "cwd") {
        let cwd = string(cwd, &format!("{path}.cwd"))?.to_string();
        normalize_repo_relative(&cwd, RootMode::Allow).map_err(|_| {
            vec![diagnostic(
                "invalid_path",
                format!("{path}.cwd"),
                "cwd must be a normalized relative path",
            )]
        })?;
        Some(cwd)
    } else {
        None
    };
    let inputs = if allow_inputs {
        if let Some(inputs) = get(command, "inputs") {
            validate_relative_path_array(inputs, &format!("{path}.inputs"))?;
            let Value::Sequence(values) = inputs else {
                unreachable!("validated as a sequence")
            };
            values
                .iter()
                .map(|value| match value {
                    Value::String(value) => value.clone(),
                    _ => unreachable!("validated as a string"),
                })
                .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    Ok(AppCommandRecipe { argv, cwd, inputs })
}

fn validate_string_array(
    value: &Value,
    path: &str,
    allow_empty: bool,
) -> Result<(), Vec<AppManifestDiagnostic>> {
    let Value::Sequence(values) = value else {
        return Err(vec![diagnostic(
            "invalid_schema",
            path,
            "Expected an array",
        )]);
    };
    if !allow_empty && values.is_empty() {
        return Err(vec![diagnostic(
            "invalid_value",
            path,
            "Array must not be empty",
        )]);
    }
    for value in values {
        if !matches!(value, Value::String(_)) {
            return Err(vec![diagnostic(
                "invalid_schema",
                path,
                "Array values must be strings",
            )]);
        }
    }
    Ok(())
}

fn validate_relative_path_array(
    value: &Value,
    path: &str,
) -> Result<(), Vec<AppManifestDiagnostic>> {
    validate_string_array(value, path, true)?;
    let Value::Sequence(values) = value else {
        unreachable!("validated as a sequence")
    };
    for value in values {
        let Value::String(value) = value else {
            unreachable!("validated as a string")
        };
        normalize_repo_relative(value, RootMode::Reject).map_err(|_| {
            vec![diagnostic(
                "invalid_path",
                path,
                "setup inputs must be normalized relative paths",
            )]
        })?;
    }
    Ok(())
}

fn required_relative_path(
    map: &serde_yml::Mapping,
    key: &str,
    path: &str,
    allow_root: bool,
) -> Result<String, Vec<AppManifestDiagnostic>> {
    let raw = required_string(map, key, path)?;
    normalize_repo_relative(
        &raw,
        if allow_root {
            RootMode::Allow
        } else {
            RootMode::Reject
        },
    )
    .map_err(|_| {
        vec![diagnostic(
            "invalid_path",
            path,
            "Expected a normalized relative path",
        )]
    })
}

fn required_http_url(
    map: &serde_yml::Mapping,
    key: &str,
    path: &str,
) -> Result<String, Vec<AppManifestDiagnostic>> {
    let url = required_string(map, key, path)?;
    let parsed = tauri::Url::parse(&url).map_err(|_| {
        vec![diagnostic(
            "invalid_url",
            path,
            "Expected an absolute HTTP(S) URL",
        )]
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(vec![diagnostic(
            "invalid_url",
            path,
            "Expected an absolute HTTP(S) URL",
        )]);
    }
    Ok(url)
}

fn reject_unknown(
    map: &serde_yml::Mapping,
    allowed: &[&str],
    path: &str,
) -> Result<(), Vec<AppManifestDiagnostic>> {
    for key in map.keys() {
        let Value::String(key) = key else {
            return Err(vec![diagnostic(
                "invalid_schema",
                path,
                "Mapping keys must be strings",
            )]);
        };
        if !allowed.contains(&key.as_str()) {
            let field_path = if path == "$" {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            return Err(vec![diagnostic(
                "unknown_field",
                field_path,
                format!("Unknown field: {key}"),
            )]);
        }
    }
    Ok(())
}

fn mapping<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a serde_yml::Mapping, Vec<AppManifestDiagnostic>> {
    match value {
        Value::Mapping(map) => Ok(map),
        _ => Err(vec![diagnostic(
            "invalid_schema",
            path,
            "Expected a mapping",
        )]),
    }
}

fn required_mapping<'a>(
    map: &'a serde_yml::Mapping,
    key: &str,
    path: &str,
) -> Result<&'a serde_yml::Mapping, Vec<AppManifestDiagnostic>> {
    let value = get(map, key).ok_or_else(|| {
        vec![diagnostic(
            "missing_field",
            path,
            format!("{key} is required"),
        )]
    })?;
    mapping(value, path)
}

fn optional_mapping<'a>(
    map: &'a serde_yml::Mapping,
    key: &str,
    path: &str,
) -> Result<Option<&'a serde_yml::Mapping>, Vec<AppManifestDiagnostic>> {
    get(map, key).map(|value| mapping(value, path)).transpose()
}

fn required_string(
    map: &serde_yml::Mapping,
    key: &str,
    path: &str,
) -> Result<String, Vec<AppManifestDiagnostic>> {
    let value = get(map, key).ok_or_else(|| {
        vec![diagnostic(
            "missing_field",
            path,
            format!("{key} is required"),
        )]
    })?;
    string(value, path).map(ToString::to_string)
}

fn string<'a>(value: &'a Value, path: &str) -> Result<&'a str, Vec<AppManifestDiagnostic>> {
    match value {
        Value::String(value) if !value.is_empty() => Ok(value),
        _ => Err(vec![diagnostic(
            "invalid_schema",
            path,
            "Expected a non-empty string",
        )]),
    }
}

fn get<'a>(map: &'a serde_yml::Mapping, key: &str) -> Option<&'a Value> {
    map.get(Value::String(key.to_string()))
}

fn diagnostic(
    code: &'static str,
    path: impl Into<String>,
    message: impl Into<String>,
) -> AppManifestDiagnostic {
    AppManifestDiagnostic {
        code,
        path: path.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_all_runtime_variants() {
        assert_eq!(
            validate_manifest_source(
                "runtime:\n  type: static\n  publicRoot: public\n  entry: index.html\n"
            )
            .unwrap(),
            ValidatedRuntime::Static {
                public_root: "public".into(),
                entry: "index.html".into(),
            }
        );
        assert!(matches!(
            validate_manifest_source("runtime:\n  type: url\n  url: https://example.com/tool\n"),
            Ok(ValidatedRuntime::Url { .. })
        ));
        assert!(matches!(
            validate_manifest_source(
                "runtime:\n  type: process\n  start:\n    argv: [bun, run, dev]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: ${TOKEN}\n"
            ),
            Ok(ValidatedRuntime::Process(_))
        ));

        let process = validate_manifest_source(
            "runtime:\n  type: process\n  setup:\n    argv: [tool, install]\n    cwd: packages/app\n    inputs: [package.json, lockfile]\n  start:\n    argv: [tool, serve, --port, '3210']\n  url: http://127.0.0.1:3210\n",
        )
        .unwrap();
        let ValidatedRuntime::Process(process) = process else {
            unreachable!()
        };
        assert_eq!(process.setup.unwrap().inputs, ["package.json", "lockfile"]);
        assert_eq!(process.start.argv[1], "serve");
        assert_eq!(process.url, "http://127.0.0.1:3210");
    }

    #[test]
    fn validates_environment_reference_grammar_and_source_limit() {
        for environment in [
            "environment:\n  1TOKEN: value\n",
            "environment:\n  TOKEN: ${TOKEN:-default}\n",
            "environment:\n  TOKEN: ${env(TOKEN)}\n",
        ] {
            let source = format!(
                "runtime:\n  type: process\n  start:\n    argv: [tool]\n  url: http://127.0.0.1:3210\n{environment}"
            );
            assert!(validate_manifest_source(&source).is_err());
        }

        assert_eq!(
            validate_manifest_source(&" ".repeat(MAX_APP_MANIFEST_BYTES as usize + 1)).unwrap_err()
                [0]
            .code,
            "resource_limit"
        );
    }

    #[test]
    fn rejects_unsafe_yaml_and_multiple_documents() {
        for source in [
            "runtime: &runtime\n  type: url\n  url: https://example.com\n",
            "runtime: *runtime\n",
            "runtime: !custom { type: url, url: https://example.com }\n",
            "runtime: { type: url, url: https://example.com }\n---\nruntime: { type: url, url: https://example.org }\n",
            "runtime: { type: url, type: static, url: https://example.com }\n",
        ] {
            assert!(
                validate_manifest_source(source).is_err(),
                "accepted {source}"
            );
        }
    }

    #[test]
    fn rejects_unknown_and_cross_variant_fields() {
        let unknown = validate_manifest_source(
            "runtime:\n  type: url\n  url: https://example.com\n  label: Dashboard\n",
        )
        .unwrap_err();
        assert_eq!(unknown[0].code, "unknown_field");
        assert_eq!(unknown[0].path, "runtime.label");

        let environment = validate_manifest_source(
            "runtime:\n  type: static\n  publicRoot: public\n  entry: index.html\nenvironment: {}\n",
        )
        .unwrap_err();
        assert_eq!(environment[0].code, "field_not_allowed");
    }

    #[test]
    fn presence_is_capability_before_parsing() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(APP_MANIFEST_NAME), "not: valid: yaml").unwrap();
        assert!(has_direct_app_manifest(temp.path()));
        assert!(
            read_and_validate_manifest(temp.path())
                .unwrap()
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn exact_marker_and_manifest_size_are_bounded() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("App.yaml"), "runtime: {}").unwrap();
        assert!(!has_direct_app_manifest(temp.path()));
        fs::remove_file(temp.path().join("App.yaml")).unwrap();

        fs::write(
            temp.path().join(APP_MANIFEST_NAME),
            vec![b'a'; MAX_APP_MANIFEST_BYTES as usize + 1],
        )
        .unwrap();
        let diagnostics = read_and_validate_manifest(temp.path())
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(diagnostics[0].code, "resource_limit");
    }

    #[test]
    fn rejects_paths_outside_the_declared_owner() {
        for source in [
            "runtime:\n  type: static\n  publicRoot: ../public\n  entry: index.html\n",
            "runtime:\n  type: static\n  publicRoot: public\n  entry: ../secret.html\n",
            "runtime:\n  type: process\n  setup:\n    argv: [tool, install]\n    inputs: [../lock]\n  start:\n    argv: [tool, run]\n  url: http://127.0.0.1:3210\n",
            "runtime:\n  type: process\n  start:\n    argv: [tool, run]\n    cwd: ../outside\n  url: http://127.0.0.1:3210\n",
        ] {
            assert!(
                validate_manifest_source(source).is_err(),
                "accepted {source}"
            );
        }
    }
}
