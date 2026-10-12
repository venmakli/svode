use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use saphyr_parser::{Event, Parser, ScalarStyle};
use serde::Serialize;
use serde_norway::{Mapping, Value};

use crate::content_tree::child_folder_names;
use crate::git::GitError;
use crate::git::path::{RootMode, normalize_repo_relative};
use crate::page::{PageSourceError, resolve_space_target};

use super::environment;

pub const APP_MANIFEST_NAME: &str = "app.yaml";
const MAX_APP_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AppManifestError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    PageSource(#[from] PageSourceError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppRuntimeType {
    Static,
    Process,
    Url,
}

impl AppRuntimeType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Static => "static",
            Self::Process => "process",
            Self::Url => "url",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppManifestDiagnostic {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidatedRuntime {
    Static { public_root: String, entry: String },
    Process(AppProcessRuntime),
    Url { url: String },
}

impl ValidatedRuntime {
    pub const fn runtime_type(&self) -> AppRuntimeType {
        match self {
            Self::Static { .. } => AppRuntimeType::Static,
            Self::Process(_) => AppRuntimeType::Process,
            Self::Url { .. } => AppRuntimeType::Url,
        }
    }

    pub fn settings_references(&self) -> Vec<String> {
        match self {
            Self::Process(runtime) => runtime.settings_references(),
            Self::Static { .. } | Self::Url { .. } => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppCommandRecipe {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub inputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppProcessRuntime {
    pub setup: Option<AppCommandRecipe>,
    pub start: AppCommandRecipe,
    pub url: String,
    pub environment: BTreeMap<String, String>,
    pub environment_declaration: BTreeMap<String, String>,
}

impl AppProcessRuntime {
    pub fn settings_references(&self) -> Vec<String> {
        environment::references(&self.environment_declaration)
            .expect("validated manifest contains valid environment references")
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedAppOwner {
    pub project_path: PathBuf,
    pub owner_path: PathBuf,
}

enum YamlContainer {
    Mapping { map: Mapping, key: Option<Value> },
    Sequence(Vec<Value>),
}

pub fn has_direct_app_manifest(directory: &Path) -> bool {
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

pub fn resolve_app_owner(
    project_path: &Path,
    space_id: Option<&str>,
    owner_path: &str,
) -> Result<ResolvedAppOwner, AppManifestError> {
    let registered = resolve_space_target(project_path, space_id)?;
    if owner_path.trim().is_empty() || owner_path == "." {
        return Ok(ResolvedAppOwner {
            project_path: registered.project_path,
            owner_path: registered.space_path,
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
        return Err(AppManifestError::PathNotAccessible(format!(
            "App owner crosses a registered Space boundary: {normalized}"
        )));
    }

    let mut candidate = registered.space_path.clone();
    for component in Path::new(&normalized).components() {
        candidate.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)?;
        if metadata.file_type().is_symlink() {
            return Err(AppManifestError::PathNotAccessible(format!(
                "App owner path contains a symbolic link: {}",
                candidate.display()
            )));
        }
    }
    let metadata = fs::symlink_metadata(&candidate)?;
    if !metadata.is_dir() {
        return Err(AppManifestError::PathNotAccessible(format!(
            "App owner is not a directory: {}",
            candidate.display()
        )));
    }
    let canonical = fs::canonicalize(candidate)?;
    if !canonical.starts_with(&registered.space_path) {
        return Err(AppManifestError::PathNotAccessible(format!(
            "App owner escapes Space boundary: {normalized}"
        )));
    }

    Ok(ResolvedAppOwner {
        project_path: registered.project_path,
        owner_path: canonical,
    })
}

pub fn read_and_validate_manifest(
    owner: &Path,
) -> Result<Option<Result<ValidatedRuntime, Vec<AppManifestDiagnostic>>>, AppManifestError> {
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

pub fn validate_manifest_source(
    source: &str,
) -> Result<ValidatedRuntime, Vec<AppManifestDiagnostic>> {
    if source.len() as u64 > MAX_APP_MANIFEST_BYTES {
        return Err(vec![diagnostic(
            "resource_limit",
            "$",
            "app.yaml exceeds the 64 KiB limit",
        )]);
    }
    let value = parse_manifest_yaml(source)?;
    validate_manifest_value(&value)
}

/// Parses `app.yaml` once: the same event stream enforces the safe-YAML rules
/// and builds the manifest value, so no second parser can read it differently.
fn parse_manifest_yaml(source: &str) -> Result<Value, Vec<AppManifestDiagnostic>> {
    let mut documents = 0_u8;
    let mut containers: Vec<YamlContainer> = Vec::new();
    let mut root = None;

    for event in Parser::new_from_str(source) {
        let (event, _) = event.map_err(|error| {
            vec![diagnostic(
                "invalid_yaml",
                "$",
                format!("Cannot parse app.yaml: {error}"),
            )]
        })?;
        let node = match event {
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => {
                continue;
            }
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err(vec![diagnostic(
                        "multiple_documents",
                        "$",
                        "app.yaml must contain exactly one YAML document",
                    )]);
                }
                continue;
            }
            Event::Alias(_) => {
                return Err(vec![diagnostic(
                    "unsafe_yaml",
                    "$",
                    "YAML aliases are not allowed",
                )]);
            }
            Event::Scalar(text, style, anchor, tag) => {
                reject_node_properties(anchor, tag.is_some())?;
                if let Some(YamlContainer::Mapping {
                    map,
                    key: key @ None,
                }) = containers.last_mut()
                {
                    if text == "<<" {
                        return Err(vec![diagnostic(
                            "unsafe_yaml",
                            "$",
                            "YAML merge keys are not allowed",
                        )]);
                    }
                    let value = scalar_value(&text, style);
                    if map.contains_key(&value) {
                        return Err(vec![diagnostic(
                            "duplicate_key",
                            "$",
                            format!("Duplicate mapping key: {text}"),
                        )]);
                    }
                    *key = Some(value);
                    continue;
                }
                scalar_value(&text, style)
            }
            Event::SequenceStart(anchor, tag) => {
                reject_node_properties(anchor, tag.is_some())?;
                reject_collection_key(&containers)?;
                containers.push(YamlContainer::Sequence(Vec::new()));
                continue;
            }
            Event::MappingStart(anchor, tag) => {
                reject_node_properties(anchor, tag.is_some())?;
                reject_collection_key(&containers)?;
                containers.push(YamlContainer::Mapping {
                    map: Mapping::new(),
                    key: None,
                });
                continue;
            }
            Event::SequenceEnd => match containers.pop() {
                Some(YamlContainer::Sequence(values)) => Value::Sequence(values),
                _ => return Err(unbalanced_yaml()),
            },
            Event::MappingEnd => match containers.pop() {
                Some(YamlContainer::Mapping { map, key: None }) => Value::Mapping(map),
                _ => return Err(unbalanced_yaml()),
            },
        };
        match containers.last_mut() {
            None => root = Some(node),
            Some(YamlContainer::Sequence(values)) => values.push(node),
            Some(YamlContainer::Mapping { map, key }) => {
                let Some(key) = key.take() else {
                    return Err(unbalanced_yaml());
                };
                map.insert(key, node);
            }
        }
    }
    match root {
        Some(root) if documents == 1 && containers.is_empty() => Ok(root),
        _ => Err(vec![diagnostic(
            "invalid_yaml",
            "$",
            "app.yaml must contain one YAML document",
        )]),
    }
}

fn reject_node_properties(anchor: usize, tagged: bool) -> Result<(), Vec<AppManifestDiagnostic>> {
    if anchor != 0 || tagged {
        return Err(vec![diagnostic(
            "unsafe_yaml",
            "$",
            "YAML anchors and tags are not allowed",
        )]);
    }
    Ok(())
}

fn reject_collection_key(containers: &[YamlContainer]) -> Result<(), Vec<AppManifestDiagnostic>> {
    if matches!(
        containers.last(),
        Some(YamlContainer::Mapping { key: None, .. })
    ) {
        return Err(vec![diagnostic(
            "invalid_schema",
            "$",
            "Mapping keys must be strings",
        )]);
    }
    Ok(())
}

fn unbalanced_yaml() -> Vec<AppManifestDiagnostic> {
    vec![diagnostic(
        "invalid_yaml",
        "$",
        "Unbalanced YAML collection events",
    )]
}

/// Quoted and block scalars are strings; plain scalars resolve by the YAML 1.2
/// core schema, so `yes` stays a string while `true`, `3210` and `~` do not.
fn scalar_value(text: &str, style: ScalarStyle) -> Value {
    if style != ScalarStyle::Plain {
        return Value::String(text.to_string());
    }
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        ".nan" | ".NaN" | ".NAN" => return Value::Number(f64::NAN.into()),
        _ => {}
    }
    let (sign, unsigned) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return Value::Number((sign * f64::INFINITY).into());
    }
    let radix_digits = text
        .strip_prefix("0o")
        .filter(|digits| {
            !digits.is_empty() && digits.bytes().all(|byte| matches!(byte, b'0'..=b'7'))
        })
        .map(|digits| (digits, 8))
        .or_else(|| {
            text.strip_prefix("0x")
                .filter(|digits| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .map(|digits| (digits, 16))
        });
    if let Some((digits, radix)) = radix_digits {
        return Value::Number(match u64::from_str_radix(digits, radix) {
            Ok(value) => value.into(),
            Err(_) => digits
                .chars()
                .filter_map(|digit| digit.to_digit(radix))
                .fold(0.0, |value, digit| {
                    value * f64::from(radix) + f64::from(digit)
                })
                .into(),
        });
    }
    if !unsigned.is_empty() && unsigned.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Ok(value) = text.parse::<i64>() {
            return Value::Number(value.into());
        }
        if let Ok(value) = text.parse::<u64>() {
            return Value::Number(value.into());
        }
    }
    if is_core_float(unsigned) {
        if let Ok(value) = text.parse::<f64>() {
            return Value::Number(value.into());
        }
    }
    Value::String(text.to_string())
}

/// `(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?` from the YAML 1.2 core schema, without the sign.
fn is_core_float(text: &str) -> bool {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(index) => (&text[..index], Some(&text[index + 1..])),
        None => (text, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    let mantissa_valid = match fraction {
        Some(fraction) => {
            digits(whole) && digits(fraction) && (!whole.is_empty() || !fraction.is_empty())
        }
        None => !whole.is_empty() && digits(whole),
    };
    let exponent_valid = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['-', '+']).unwrap_or(exponent);
        !exponent.is_empty() && digits(exponent)
    });
    mantissa_valid && exponent_valid
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
    command: &Mapping,
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
    map: &Mapping,
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
    map: &Mapping,
    key: &str,
    path: &str,
) -> Result<String, Vec<AppManifestDiagnostic>> {
    let url = required_string(map, key, path)?;
    let parsed = url::Url::parse(&url).map_err(|_| {
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
    map: &Mapping,
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

fn mapping<'a>(value: &'a Value, path: &str) -> Result<&'a Mapping, Vec<AppManifestDiagnostic>> {
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
    map: &'a Mapping,
    key: &str,
    path: &str,
) -> Result<&'a Mapping, Vec<AppManifestDiagnostic>> {
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
    map: &'a Mapping,
    key: &str,
    path: &str,
) -> Result<Option<&'a Mapping>, Vec<AppManifestDiagnostic>> {
    get(map, key).map(|value| mapping(value, path)).transpose()
}

fn required_string(
    map: &Mapping,
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

fn get<'a>(map: &'a Mapping, key: &str) -> Option<&'a Value> {
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
    fn exposes_runtime_type_and_sorted_reference_names_from_the_validated_manifest() {
        let source = "runtime:\n  type: process\n  start:\n    argv: [tool]\n  url: http://127.0.0.1:3210\nenvironment:\n  FIRST: ${SECOND}-${FIRST}\n  LITERAL: $${IGNORED}\n";
        let runtime = validate_manifest_source(source).unwrap();
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(APP_MANIFEST_NAME), source).unwrap();
        let runtime_from_file = read_and_validate_manifest(temp.path())
            .unwrap()
            .unwrap()
            .unwrap();

        assert_eq!(runtime.runtime_type(), AppRuntimeType::Process);
        assert_eq!(runtime.runtime_type().as_str(), "process");
        assert_eq!(runtime.settings_references(), ["FIRST", "SECOND"]);
        assert_eq!(runtime_from_file, runtime);
    }

    #[test]
    fn rejects_unsafe_yaml_and_multiple_documents() {
        for (source, code) in [
            (
                "runtime: { type: url, url: https://example.com }\n---\nruntime: { type: url, url: https://example.org }\n",
                "multiple_documents",
            ),
            (
                "base: &base https://example.com\nruntime:\n  type: url\n  url: *base\n",
                "unsafe_yaml",
            ),
            (
                "runtime: &runtime\n  type: url\n  url: https://example.com\n",
                "unsafe_yaml",
            ),
            (
                "runtime:\n  type: url\n  url: &url https://example.com\n",
                "unsafe_yaml",
            ),
            (
                "runtime: !custom { type: url, url: https://example.com }\n",
                "unsafe_yaml",
            ),
            (
                "runtime:\n  type: !!str url\n  url: https://example.com\n",
                "unsafe_yaml",
            ),
            (
                "runtime: !!map { type: url, url: https://example.com }\n",
                "unsafe_yaml",
            ),
            (
                "runtime:\n  type: url\n  url: !<tag:yaml.org,2002:str> https://example.com\n",
                "unsafe_yaml",
            ),
            (
                "runtime:\n  <<: { type: url }\n  url: https://example.com\n",
                "unsafe_yaml",
            ),
            (
                "runtime: { type: url, url: https://example.com }\nruntime: { type: url, url: https://example.org }\n",
                "duplicate_key",
            ),
            (
                "runtime:\n  type: url\n  type: static\n  url: https://example.com\n",
                "duplicate_key",
            ),
            (
                "runtime: { type: url, type: static, url: https://example.com }\n",
                "duplicate_key",
            ),
            (
                "? [runtime]\n: { type: url, url: https://example.com }\n",
                "invalid_schema",
            ),
            (
                "runtime: { type: url, url: https://example.com }\n1: value\n",
                "invalid_schema",
            ),
            ("runtime: [unclosed\n", "invalid_yaml"),
            ("", "invalid_yaml"),
        ] {
            let diagnostics = validate_manifest_source(source).unwrap_err();
            assert_eq!(diagnostics[0].code, code, "{source}");
            assert_eq!(diagnostics[0].path, "$", "{source}");
        }
    }

    #[test]
    fn resolves_plain_scalars_by_the_core_schema() {
        for (field, path) in [
            ("url: true", "runtime.url"),
            ("url: 3210", "runtime.url"),
            ("url: null", "runtime.url"),
            ("url: ~", "runtime.url"),
            ("url:", "runtime.url"),
            ("url: 0x1F", "runtime.url"),
            ("url: -1.5e3", "runtime.url"),
            ("url: .inf", "runtime.url"),
        ] {
            let source = format!("runtime:\n  type: url\n  {field}\n");
            let diagnostics = validate_manifest_source(&source).unwrap_err();
            assert_eq!(diagnostics[0].code, "invalid_schema", "{field}");
            assert_eq!(diagnostics[0].path, path, "{field}");
        }

        let runtime = validate_manifest_source(
            "runtime:\n  type: process\n  start:\n    argv:\n      - tool\n      - '3210'\n      - \"true\"\n      - yes\n      - 1.2.3\n      - 0x\n      - |\n        block\n  url: http://127.0.0.1:3210\nenvironment:\n  PORT: '3210'\n",
        );
        let ValidatedRuntime::Process(process) = runtime.unwrap() else {
            unreachable!()
        };
        assert_eq!(
            process.start.argv,
            ["tool", "3210", "true", "yes", "1.2.3", "0x", "block\n"]
        );
        assert_eq!(process.environment["PORT"], "3210");

        let number_argv = validate_manifest_source(
            "runtime:\n  type: process\n  start:\n    argv: [tool, 3210]\n  url: http://127.0.0.1:3210\n",
        )
        .unwrap_err();
        assert_eq!(number_argv[0].code, "invalid_schema");
        assert_eq!(number_argv[0].path, "runtime.start.argv");
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

    #[test]
    fn resolves_only_registered_app_owners_without_creating_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("child/app")).unwrap();
        fs::write(
            project.join(".svode/config.json"),
            r#"{"name":"Project","spaces":[{"id":"child-id","path":"child"}]}"#,
        )
        .unwrap();
        fs::write(
            project.join("child/app/app.yaml"),
            "runtime:\n  type: url\n  url: https://example.com\n",
        )
        .unwrap();

        let owner = resolve_app_owner(project, Some("child-id"), "app").unwrap();
        assert_eq!(owner.project_path, project.canonicalize().unwrap());
        assert_eq!(
            owner.owner_path,
            project.join("child/app").canonicalize().unwrap()
        );
        assert!(matches!(
            read_and_validate_manifest(&owner.owner_path).unwrap(),
            Some(Ok(ValidatedRuntime::Url { .. }))
        ));
        assert!(resolve_app_owner(project, None, "child").is_err());
        assert!(resolve_app_owner(project, Some("unknown"), ".").is_err());
        assert!(resolve_app_owner(project, Some("child-id"), "../.svode").is_err());
        assert!(!project.join(".svode/index.db").exists());
        assert!(!project.join("child/.svode").exists());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(project.join("child/app"), project.join("child/alias"))
                .unwrap();
            assert!(resolve_app_owner(project, Some("child-id"), "alias").is_err());
        }
    }
}
