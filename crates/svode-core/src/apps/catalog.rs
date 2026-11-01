//! Read-only projection of the Apps of a Space for agents: the App owners
//! the Space tree shows and the description of one App with its README.
//! Nothing here launches an App, opens its URL, resolves Variables or
//! writes a file.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::content_tree::ContentTreeError;
use crate::content_tree::app_owners::{app_owner_sources, owner_readme_path};
use crate::page::PageError;
use crate::page::entry::{self, EntryMeta, EntryWarning};

use super::manifest::{
    AppManifestDiagnostic, AppManifestError, AppRuntimeType, ValidatedRuntime,
    read_and_validate_manifest, resolve_owner_in_space,
};

/// Bytes of README body an App description returns; the rest is read from
/// the same path with the reader of that source.
pub const APP_README_TEXT_LIMIT_BYTES: usize = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AppCatalogError {
    #[error("{0} is not an App: it has no app.yaml")]
    NotAnApp(String),
    #[error("App owner not found: {0}")]
    OwnerNotFound(String),
    #[error(transparent)]
    Manifest(#[from] AppManifestError),
    #[error(transparent)]
    Tree(#[from] ContentTreeError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSummary {
    /// Owner directory relative to the Space; `.` for the Space root.
    pub owner_path: String,
    pub runtime_type: Option<AppRuntimeType>,
    pub valid: bool,
    pub diagnostic_count: usize,
    pub has_readme: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDescription {
    pub owner_path: String,
    pub runtime_type: Option<AppRuntimeType>,
    pub valid: bool,
    /// Declared URL of a process or url App.
    pub url: Option<String>,
    pub diagnostics: Vec<AppManifestDiagnostic>,
    /// The README of the owner, absent when it has none.
    pub readme: Option<AppReadme>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppReadme {
    /// Path relative to the Space.
    pub path: String,
    /// Frontmatter of a readable README.
    pub meta: Option<EntryMeta>,
    /// Body of a readable README, cut at [`APP_README_TEXT_LIMIT_BYTES`].
    pub body: Option<String>,
    pub truncated: bool,
    pub warnings: Vec<EntryWarning>,
    /// Why the README could not be read.
    pub diagnostic: Option<AppReadmeDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppReadmeDiagnostic {
    pub code: &'static str,
    pub message: String,
}

/// App owners of a Space with their runtime, manifest validity and README
/// presence, in owner path order.
pub fn list_apps(space: &Path) -> Result<Vec<AppSummary>, AppCatalogError> {
    let space = canonical_space(space)?;
    let mut apps = Vec::new();
    for owner in app_owner_sources(&space)? {
        // A marker removed since the walk is no App any more.
        let Some(manifest) = read_and_validate_manifest(&owner.owner_dir)? else {
            continue;
        };
        let (runtime_type, diagnostic_count) = match &manifest {
            Ok(runtime) => (Some(runtime.runtime_type()), 0),
            Err(diagnostics) => (None, diagnostics.len()),
        };
        apps.push(AppSummary {
            owner_path: owner.owner_path,
            runtime_type,
            valid: manifest.is_ok(),
            diagnostic_count,
            has_readme: owner.readme_path.is_some(),
        });
    }
    Ok(apps)
}

/// Description of the App at any owner path the App host opens: runtime,
/// declared URL, manifest diagnostics and the README its `Описание` tab
/// shows, read like every Markdown source.
pub fn describe_app(space: &Path, owner_path: &str) -> Result<AppDescription, AppCatalogError> {
    let space = canonical_space(space)?;
    let owner = match resolve_owner_in_space(&space, owner_path) {
        Ok(owner) => owner,
        Err(AppManifestError::Io(error)) if error.kind() == ErrorKind::NotFound => {
            return Err(AppCatalogError::OwnerNotFound(owner_path.to_string()));
        }
        Err(error) => return Err(error.into()),
    };
    let relative_owner = relative(&space, &owner);
    let Some(manifest) = read_and_validate_manifest(&owner)? else {
        return Err(AppCatalogError::NotAnApp(relative_owner));
    };
    let (runtime_type, url, diagnostics) = match manifest {
        Ok(runtime) => {
            let url = match &runtime {
                ValidatedRuntime::Process(process) => Some(process.url.clone()),
                ValidatedRuntime::Url { url } => Some(url.clone()),
                ValidatedRuntime::Static { .. } => None,
            };
            (Some(runtime.runtime_type()), url, Vec::new())
        }
        Err(diagnostics) => (None, None, diagnostics),
    };
    let readme = owner_readme_path(&space, &owner)?.map(|path| read_readme(&space, path));
    Ok(AppDescription {
        owner_path: relative_owner,
        runtime_type,
        valid: runtime_type.is_some(),
        url,
        diagnostics,
        readme,
    })
}

fn read_readme(space: &Path, path: String) -> AppReadme {
    match entry::read(&space.to_string_lossy(), &path) {
        Ok(source) => {
            let (body, truncated) = cut(source.body, APP_README_TEXT_LIMIT_BYTES);
            AppReadme {
                path: source.path,
                meta: Some(source.meta),
                body: Some(body),
                truncated,
                warnings: source.warnings,
                diagnostic: None,
            }
        }
        Err(error) => AppReadme {
            path,
            meta: None,
            body: None,
            truncated: false,
            warnings: Vec::new(),
            diagnostic: Some(AppReadmeDiagnostic {
                code: match error {
                    PageError::InvalidEncoding(_) => "invalid_encoding",
                    _ => "unreadable",
                },
                message: error.to_string(),
            }),
        },
    }
}

/// `text` within `limit` bytes, cut at a character boundary.
fn cut(mut text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

fn canonical_space(space: &Path) -> Result<PathBuf, AppCatalogError> {
    fs::canonicalize(space).map_err(|error| match error.kind() {
        ErrorKind::NotFound => {
            AppCatalogError::Tree(ContentTreeError::FileNotFound(space.display().to_string()))
        }
        _ => AppCatalogError::Tree(ContentTreeError::Io(error)),
    })
}

fn relative(space: &Path, owner: &Path) -> String {
    match owner.strip_prefix(space) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => owner.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL_APP: &str = "runtime:\n  type: url\n  url: https://example.com/tool\n";
    const PROCESS_APP: &str = "runtime:\n  type: process\n  start:\n    argv: [bun, run, dev]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: ${API_TOKEN}\n";

    fn write(path: &Path, text: impl AsRef<[u8]>) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    files.push((path.clone(), fs::read(&path).unwrap()));
                }
            }
        }
        files.sort();
        files
    }

    fn space() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let space = temp.path().canonicalize().unwrap();
        write(&space.join(".svode/config.json"), r#"{"name":"Space"}"#);
        (temp, space)
    }

    #[test]
    fn list_reports_runtime_validity_and_readme_without_effects() {
        let (_temp, space) = space();
        write(&space.join("app.yaml"), URL_APP);
        write(&space.join("README.md"), "# Space\n");
        write(&space.join("tools/README.md"), "# Tools\n");
        write(&space.join("tools/api/app.yaml"), PROCESS_APP);
        write(&space.join("tools/api/Readme.md"), "# API\n");
        write(&space.join("broken/app.yaml"), "runtime:\n  type: static\n");
        let before = snapshot(&space);

        let apps = list_apps(&space).unwrap();

        assert_eq!(
            apps,
            vec![
                AppSummary {
                    owner_path: ".".into(),
                    runtime_type: Some(AppRuntimeType::Url),
                    valid: true,
                    diagnostic_count: 0,
                    has_readme: true,
                },
                AppSummary {
                    owner_path: "broken".into(),
                    runtime_type: None,
                    valid: false,
                    diagnostic_count: 1,
                    has_readme: false,
                },
                AppSummary {
                    owner_path: "tools/api".into(),
                    runtime_type: Some(AppRuntimeType::Process),
                    valid: true,
                    diagnostic_count: 0,
                    has_readme: true,
                },
            ]
        );
        assert_eq!(snapshot(&space), before);
    }

    #[test]
    fn description_returns_the_readme_of_the_description_tab_read_as_markdown() {
        let (_temp, space) = space();
        write(&space.join("tools/api/app.yaml"), PROCESS_APP);
        write(
            &space.join("tools/api/readme.MD"),
            "---\ntitle: API\nicon: 🔧\n---\n## For agents\n\nRun `bun run seed`.\n",
        );
        let before = snapshot(&space);

        let app = describe_app(&space, "tools/api").unwrap();

        assert_eq!(app.owner_path, "tools/api");
        assert_eq!(app.runtime_type, Some(AppRuntimeType::Process));
        assert!(app.valid);
        assert_eq!(app.url.as_deref(), Some("http://127.0.0.1:3210"));
        assert!(app.diagnostics.is_empty());
        let readme = app.readme.unwrap();
        assert_eq!(readme.path, "tools/api/readme.MD");
        assert_eq!(readme.meta.unwrap().title, "API");
        assert_eq!(
            readme.body.as_deref(),
            Some("## For agents\n\nRun `bun run seed`.\n")
        );
        assert!(!readme.truncated);
        assert!(readme.diagnostic.is_none());
        // Variables are named by the manifest only; no value is resolved.
        let json = serde_json::to_string(&describe_app(&space, "tools/api").unwrap()).unwrap();
        assert!(!json.contains("API_TOKEN"));
        assert_eq!(snapshot(&space), before);
    }

    #[test]
    fn description_of_the_space_root_static_app_and_missing_readme() {
        let (_temp, space) = space();
        write(
            &space.join("app.yaml"),
            "runtime:\n  type: static\n  publicRoot: public\n  entry: index.html\n",
        );
        let root = describe_app(&space, ".").unwrap();
        assert_eq!(root.owner_path, ".");
        assert_eq!(root.runtime_type, Some(AppRuntimeType::Static));
        assert_eq!(root.url, None);
        assert!(root.readme.is_none());
        assert_eq!(describe_app(&space, "").unwrap().owner_path, ".");
    }

    #[test]
    fn long_readme_is_cut_at_the_limit_on_a_character_boundary() {
        let (_temp, space) = space();
        write(&space.join("board/app.yaml"), URL_APP);
        let body = "я".repeat(APP_README_TEXT_LIMIT_BYTES);
        write(&space.join("board/README.md"), &body);

        let readme = describe_app(&space, "board").unwrap().readme.unwrap();

        assert!(readme.truncated);
        let text = readme.body.unwrap();
        assert!(text.len() <= APP_README_TEXT_LIMIT_BYTES);
        assert_eq!(text.len(), APP_README_TEXT_LIMIT_BYTES);
        assert!(body.starts_with(&text));
        // The full text stays readable on the same path.
        assert_eq!(
            entry::read(&space.to_string_lossy(), &readme.path)
                .unwrap()
                .body,
            body
        );
    }

    #[test]
    fn unreadable_readme_is_a_diagnostic_and_the_rest_is_described() {
        let (_temp, space) = space();
        write(&space.join("board/app.yaml"), "runtime:\n  type: url\n");
        write(&space.join("board/README.md"), [0xff, 0xfe, 0x00]);

        let app = describe_app(&space, "board").unwrap();

        assert!(!app.valid);
        assert_eq!(app.runtime_type, None);
        assert!(!app.diagnostics.is_empty());
        let readme = app.readme.unwrap();
        assert_eq!(readme.path, "board/README.md");
        assert!(readme.body.is_none() && readme.meta.is_none());
        assert_eq!(readme.diagnostic.unwrap().code, "invalid_encoding");
    }

    #[test]
    fn description_refuses_an_owner_that_is_no_app_or_does_not_exist() {
        let (_temp, space) = space();
        write(&space.join("notes/README.md"), "# Notes\n");
        assert!(matches!(
            describe_app(&space, "notes"),
            Err(AppCatalogError::NotAnApp(path)) if path == "notes"
        ));
        assert!(matches!(
            describe_app(&space, "missing"),
            Err(AppCatalogError::OwnerNotFound(path)) if path == "missing"
        ));
        assert!(matches!(
            describe_app(&space, "../outside"),
            Err(AppCatalogError::Manifest(_))
        ));
    }

    #[test]
    fn description_opens_an_owner_whose_marker_the_tree_hides() {
        let (_temp, space) = space();
        write(&space.join(".gitignore"), "generated/\n");
        write(&space.join("generated/app.yaml"), URL_APP);
        assert!(list_apps(&space).unwrap().is_empty());
        assert_eq!(
            describe_app(&space, "generated").unwrap().runtime_type,
            Some(AppRuntimeType::Url)
        );
    }
}
