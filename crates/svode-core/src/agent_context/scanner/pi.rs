//! `packages` of the pi settings, JSON (E02, pi 1.0.0): where each package
//! is installed. Only the package sources are kept: a git source may carry
//! a token, so only its host and path become a folder.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};

use super::io::{diagnostic, path_string, read_config_text};
use super::{DiscoveryResult, TargetPlaces};

#[derive(Deserialize)]
struct Settings {
    #[serde(default)]
    packages: Vec<serde_json::Value>,
}

/// A package of the pi settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Package {
    pub settings: PathBuf,
    pub inside: bool,
    /// The package's name in its source: an npm name, a git path or a
    /// folder.
    pub name: String,
    /// Where it is installed, when it is.
    pub folder: Option<PathBuf>,
}

/// The packages of the user settings when `global`, then of the project
/// settings of the target.
pub(super) fn packages(
    environment: &SourceRegistryEnvironment,
    places: &TargetPlaces,
    global: bool,
    result: &mut DiscoveryResult,
) -> Vec<Package> {
    let mut settings = Vec::new();
    if global {
        settings.push((environment.pi_agent_dir.clone(), false));
    }
    settings.push((places.target_root.join(".pi"), true));
    let mut packages = Vec::new();
    for (base, inside) in settings {
        let path = base.join("settings.json");
        let observed = path_string(&path);
        if inside {
            result.observed_project_paths.push(observed);
        } else {
            result.observed_personal_paths.push(observed);
        }
        let Some(text) = read_config_text(
            &path,
            Some(AgentAdapterKind::Pi),
            "pi_settings",
            "pi settings",
            &mut result.diagnostics,
        ) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Settings>(&text) else {
            result.diagnostics.push(diagnostic(
                &path,
                Some(AgentAdapterKind::Pi),
                "pi_settings_parse",
                "Could not parse pi settings".to_string(),
            ));
            continue;
        };
        for entry in parsed.packages {
            let source = match &entry {
                serde_json::Value::String(source) => source.as_str(),
                serde_json::Value::Object(entry) => {
                    match entry.get("source").and_then(serde_json::Value::as_str) {
                        Some(source) => source,
                        None => continue,
                    }
                }
                _ => continue,
            };
            let Some((name, folder)) = install_folder(source, &base, &environment.home_dir) else {
                continue;
            };
            packages.push(Package {
                settings: path.clone(),
                inside,
                name,
                folder: folder.filter(|folder| folder.exists()),
            });
        }
    }
    packages
}

/// The name and install folder of a source: npm packages in `npm`, git
/// repositories in `git/<host>/<path>`, local paths where they are.
fn install_folder(source: &str, base: &Path, home: &Path) -> Option<(String, Option<PathBuf>)> {
    if let Some(spec) = source.strip_prefix("npm:") {
        let name = match spec.rfind('@') {
            Some(at) if at > 0 => &spec[..at],
            _ => spec,
        };
        return Some((
            name.to_string(),
            Some(base.join("npm/node_modules").join(name)),
        ));
    }
    let git = source
        .strip_prefix("git:")
        .or_else(|| source.strip_prefix("https://"))
        .or_else(|| source.strip_prefix("http://"));
    if let Some(location) = git {
        let location = location.split(['?', '#']).next()?;
        // Userinfo may be a token.
        let location = location.rsplit_once('@').map_or(location, |(_, rest)| rest);
        let location = location.trim_end_matches('/').trim_end_matches(".git");
        if location.is_empty() || location.split('/').any(|part| part == "..") {
            return None;
        }
        return Some((location.to_string(), Some(base.join("git").join(location))));
    }
    let path = match source.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => base.join(source),
    };
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some((name, Some(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_name_their_install_folders_without_userinfo() {
        let base = Path::new("/pi");
        let home = Path::new("/home");
        assert_eq!(
            install_folder("npm:@scope/tool@1.2.0", base, home),
            Some((
                "@scope/tool".to_string(),
                Some(PathBuf::from("/pi/npm/node_modules/@scope/tool"))
            ))
        );
        assert_eq!(
            install_folder("https://user:token@github.com/a/b.git", base, home),
            Some((
                "github.com/a/b".to_string(),
                Some(PathBuf::from("/pi/git/github.com/a/b"))
            ))
        );
        assert_eq!(
            install_folder("~/tools/ext", base, home),
            Some(("ext".to_string(), Some(PathBuf::from("/home/tools/ext"))))
        );
        assert_eq!(install_folder("git:host/../x", base, home), None);
    }
}
