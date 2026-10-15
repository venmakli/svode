//! The files of a skill folder besides `SKILL.md` (Stage 10 `05`, the
//! skill's «Вложения»): read within the canonical skill folder, the boundary
//! `SKILL.md` is read in, and only the files Svode supports — Markdown,
//! documents and media. A folder is a branch only when it holds such a file.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::super::AgentContextError;
use super::super::items::modified_at;
use super::super::model::MarkdownPreview;
use super::DEFAULT_PREVIEW_BYTES;
use super::io::{inspect, path_string};
use crate::attachments::format::{AttachmentAvailability, classify_binary_extension};
use crate::page::identity::ArtifactKind;

const MAX_BRANCH_ENTRIES: usize = 512;
/// Entries the search for supported files inside the folders of one branch
/// reads before it counts the remaining folders as holding one.
const MAX_SEARCH_ENTRIES: usize = 2048;
const MAX_SEARCH_DEPTH: usize = 8;
const SKILL_MANIFEST: &str = "SKILL.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillFileKind {
    Directory,
    Markdown,
    Document,
    Media,
}

/// A supported file or a folder holding one, directly inside a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    /// The path inside the skill folder, `/`-separated.
    pub path: String,
    /// The canonical file a viewer and an external open read.
    pub canonical_path: String,
    pub name: String,
    pub kind: SkillFileKind,
    /// The lowercased extension; empty for a folder.
    pub format: String,
    pub availability: AttachmentAvailability,
    pub modified_at: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFilesBranch {
    /// The listed folder inside the skill folder; empty for the skill folder.
    pub path: String,
    pub files: Vec<SkillFile>,
}

/// The supported files and folders directly inside `branch` of the skill
/// folder; `SKILL.md` itself is the skill's body, not one of its files.
pub fn list_skill_files(
    skill_directory: &Path,
    branch: &str,
) -> Result<SkillFilesBranch, AgentContextError> {
    let root = canonical_skill_directory(skill_directory)?;
    let relative = relative_path(branch)?;
    Ok(SkillFilesBranch {
        path: path_string(&relative).replace('\\', "/"),
        files: branch_files(&root, &relative, MAX_BRANCH_ENTRIES)?,
    })
}

/// Whether the skill folder holds a supported file besides `SKILL.md`.
pub fn has_skill_files(skill_directory: &Path) -> bool {
    canonical_skill_directory(skill_directory)
        .and_then(|root| branch_files(&root, Path::new(""), 1))
        .is_ok_and(|files| !files.is_empty())
}

/// Up to `limit` supported entries of a branch; the search inside its
/// folders shares one bound.
fn branch_files(
    root: &Path,
    relative: &Path,
    limit: usize,
) -> Result<Vec<SkillFile>, AgentContextError> {
    let directory = root.join(relative);
    if directory.canonicalize().ok().as_deref() != Some(directory.as_path()) || !directory.is_dir()
    {
        return Err(AgentContextError::PathNotAccessible(format!(
            "{} is not a folder of the skill {}",
            relative.display(),
            root.display()
        )));
    }
    let entries = fs::read_dir(&directory).map_err(|error| {
        AgentContextError::PathNotAccessible(format!(
            "could not read {}: {error}",
            directory.display()
        ))
    })?;
    let mut files = Vec::new();
    let mut budget = MAX_SEARCH_ENTRIES;
    for entry in entries.flatten().take(MAX_BRANCH_ENTRIES) {
        if files.len() >= limit {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if relative.as_os_str().is_empty() && name.eq_ignore_ascii_case(SKILL_MANIFEST) {
            continue;
        }
        if let Some(file) = supported_entry(root, &entry.path(), &name, &mut budget) {
            files.push(SkillFile {
                path: path_string(&relative.join(&name)).replace('\\', "/"),
                ..file
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// The text of a Markdown file of the skill, bounded like an instruction's.
pub fn read_skill_markdown(
    skill_directory: &Path,
    path: &str,
) -> Result<MarkdownPreview, AgentContextError> {
    let root = canonical_skill_directory(skill_directory)?;
    let relative = relative_path(path)?;
    let candidate = root.join(&relative);
    let parent = candidate.parent().unwrap_or(&root);
    let is_markdown = candidate
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    if relative.as_os_str().is_empty()
        || !is_markdown
        || parent.canonicalize().ok().as_deref() != Some(parent)
    {
        return Err(AgentContextError::PathNotAccessible(format!(
            "{path} is not a Markdown file of the skill {}",
            root.display()
        )));
    }
    let inspected = inspect(&candidate, &root, DEFAULT_PREVIEW_BYTES, None).ok_or_else(|| {
        AgentContextError::PathNotAccessible(format!("{} does not exist", candidate.display()))
    })?;
    match inspected.preview {
        Some(preview) => Ok(preview),
        None => Err(AgentContextError::PathNotAccessible(
            inspected
                .diagnostic
                .map(|diagnostic| diagnostic.message)
                .unwrap_or_else(|| format!("could not read {}", candidate.display())),
        )),
    }
}

/// The canonical file of a document or media file of the skill, for a viewer
/// to read: the same boundary as the listing, refused outside the folder.
pub fn resolve_skill_file(
    skill_directory: &Path,
    path: &str,
    kind: SkillFileKind,
) -> Result<PathBuf, AgentContextError> {
    let root = canonical_skill_directory(skill_directory)?;
    let relative = relative_path(path)?;
    let candidate = root.join(&relative);
    let parent = candidate.parent().unwrap_or(&root);
    let name = relative
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let canonical = candidate.canonicalize().ok();
    let resolved = canonical.filter(|canonical| {
        parent.canonicalize().ok().as_deref() == Some(parent)
            && canonical.starts_with(&root)
            && canonical.is_file()
            && file_kind(&name).is_some_and(|(found, _, _)| found == kind)
    });
    match (kind, resolved) {
        (SkillFileKind::Document | SkillFileKind::Media, Some(resolved)) => Ok(resolved),
        _ => Err(AgentContextError::PathNotAccessible(format!(
            "{path} is not a {kind:?} file of the skill {}",
            root.display()
        ))),
    }
}

fn canonical_skill_directory(skill_directory: &Path) -> Result<PathBuf, AgentContextError> {
    let root = skill_directory.canonicalize().map_err(|error| {
        AgentContextError::PathNotAccessible(format!(
            "could not resolve skill folder {}: {error}",
            skill_directory.display()
        ))
    })?;
    if !root.is_dir() {
        return Err(AgentContextError::PathNotAccessible(format!(
            "skill folder is not a directory: {}",
            root.display()
        )));
    }
    Ok(root)
}

/// A path inside the skill folder: plain, visible names only.
fn relative_path(path: &str) -> Result<PathBuf, AgentContextError> {
    let mut relative = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(name) if !name.to_string_lossy().starts_with('.') => {
                relative.push(name);
            }
            Component::CurDir => {}
            _ => {
                return Err(AgentContextError::PathNotAccessible(format!(
                    "{path} is not a path inside a skill folder"
                )));
            }
        }
    }
    Ok(relative)
}

/// A supported file, or a folder holding one. Hidden entries, files that
/// resolve outside the skill folder and linked folders are not followed.
fn supported_entry(root: &Path, path: &Path, name: &str, budget: &mut usize) -> Option<SkillFile> {
    if name.starts_with('.') {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.is_dir() {
        if !holds_supported_file(path, 1, budget) {
            return None;
        }
        return Some(SkillFile {
            path: String::new(),
            canonical_path: path_string(path),
            name: name.to_string(),
            kind: SkillFileKind::Directory,
            format: String::new(),
            availability: AttachmentAvailability::Available,
            modified_at: modified_at(path),
            size_bytes: None,
        });
    }
    let (kind, format, availability) = file_kind(name)?;
    let canonical = path.canonicalize().ok()?;
    let file = fs::metadata(&canonical).ok()?;
    if !canonical.starts_with(root) || !file.is_file() {
        return None;
    }
    Some(SkillFile {
        path: String::new(),
        canonical_path: path_string(&canonical),
        name: name.to_string(),
        kind,
        format,
        availability,
        modified_at: modified_at(&canonical),
        size_bytes: (kind != SkillFileKind::Markdown).then_some(file.len()),
    })
}

fn file_kind(name: &str) -> Option<(SkillFileKind, String, AttachmentAvailability)> {
    let format = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    if format == "md" {
        return Some((
            SkillFileKind::Markdown,
            format,
            AttachmentAvailability::Available,
        ));
    }
    let (kind, availability) = classify_binary_extension(&format)?;
    let kind = if kind == ArtifactKind::Document {
        SkillFileKind::Document
    } else {
        SkillFileKind::Media
    };
    Some((kind, format, availability))
}

/// Whether a supported file lies somewhere below `directory`; a search past
/// its bounds counts as finding one, so the folder stays visible.
fn holds_supported_file(directory: &Path, depth: usize, budget: &mut usize) -> bool {
    if depth > MAX_SEARCH_DEPTH {
        return true;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    let mut folders = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            return true;
        }
        *budget -= 1;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.is_dir() {
            folders.push(entry.path());
        } else if file_kind(&name).is_some() {
            return true;
        }
    }
    folders
        .iter()
        .any(|folder| holds_supported_file(folder, depth + 1, budget))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn skill() -> (TempDir, PathBuf) {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap().join("review");
        for (path, text) in [
            ("SKILL.md", "---\nname: review\ndescription: d\n---\nbody"),
            ("references/guide.md", "# Guide"),
            ("references/deep/notes.md", "notes"),
            ("assets/logo.png", "png"),
            ("assets/template.docx", "docx"),
            ("scripts/run.py", "print()"),
            ("scripts/vendor/lib.js", "js"),
            ("LICENSE.txt", "license"),
            (".hidden/secret.md", "hidden"),
            (".notes.md", "hidden"),
        ] {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }
        (temp, root)
    }

    fn names(branch: &SkillFilesBranch) -> Vec<(&str, SkillFileKind)> {
        branch
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.kind))
            .collect()
    }

    #[test]
    fn only_supported_files_and_folders_holding_them_are_listed_without_the_manifest() {
        let (_temp, root) = skill();

        let listed = list_skill_files(&root, "").unwrap();

        assert_eq!(
            names(&listed),
            vec![
                ("assets", SkillFileKind::Directory),
                ("references", SkillFileKind::Directory),
            ]
        );
        assert!(has_skill_files(&root));
    }

    #[test]
    fn a_branch_lists_its_direct_files_with_sizes_of_documents_and_media() {
        let (_temp, root) = skill();

        let assets = list_skill_files(&root, "assets").unwrap();
        let references = list_skill_files(&root, "references").unwrap();

        assert_eq!(assets.path, "assets");
        assert_eq!(
            names(&assets),
            vec![
                ("assets/logo.png", SkillFileKind::Media),
                ("assets/template.docx", SkillFileKind::Document),
            ]
        );
        assert_eq!(assets.files[0].size_bytes, Some(3));
        assert_eq!(assets.files[0].format, "png");
        assert_eq!(
            assets.files[1].canonical_path,
            path_string(&root.join("assets/template.docx"))
        );
        assert_eq!(
            names(&references),
            vec![
                ("references/deep", SkillFileKind::Directory),
                ("references/guide.md", SkillFileKind::Markdown),
            ]
        );
        assert_eq!(references.files[1].size_bytes, None);
    }

    #[test]
    fn a_skill_with_only_scripts_has_no_files() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("SKILL.md"), "body").unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        fs::write(root.join("scripts/run.sh"), "echo").unwrap();

        assert!(list_skill_files(&root, "").unwrap().files.is_empty());
        assert!(!has_skill_files(&root));
    }

    #[test]
    fn paths_leaving_the_skill_folder_or_naming_hidden_or_missing_folders_are_rejected() {
        let (_temp, root) = skill();

        for branch in [
            "..",
            "references/..",
            "/etc",
            ".hidden",
            "missing",
            "scripts/run.py",
        ] {
            assert!(list_skill_files(&root, branch).is_err(), "{branch}");
        }
        for path in [
            "../review/SKILL.md",
            "assets/logo.png",
            ".notes.md",
            "missing.md",
            "",
        ] {
            assert!(read_skill_markdown(&root, path).is_err(), "{path}");
        }
    }

    #[test]
    fn a_markdown_file_is_read_bounded() {
        let (_temp, root) = skill();
        fs::write(
            root.join("references/long.md"),
            "x".repeat(DEFAULT_PREVIEW_BYTES + 10),
        )
        .unwrap();

        let guide = read_skill_markdown(&root, "references/guide.md").unwrap();
        let long = read_skill_markdown(&root, "references/long.md").unwrap();

        assert_eq!(guide.markdown, "# Guide");
        assert!(!guide.truncated);
        assert!(long.truncated);
        assert_eq!(long.markdown.len(), DEFAULT_PREVIEW_BYTES);
    }

    #[test]
    fn documents_and_media_resolve_only_inside_the_skill_folder_by_their_kind() {
        let (temp, root) = skill();
        fs::write(temp.path().join("outside.pdf"), "pdf").unwrap();

        assert_eq!(
            resolve_skill_file(&root, "assets/logo.png", SkillFileKind::Media).unwrap(),
            root.join("assets/logo.png")
        );
        assert_eq!(
            resolve_skill_file(&root, "assets/template.docx", SkillFileKind::Document).unwrap(),
            root.join("assets/template.docx")
        );
        for (path, kind) in [
            ("assets/logo.png", SkillFileKind::Document),
            ("references/guide.md", SkillFileKind::Markdown),
            ("scripts/run.py", SkillFileKind::Document),
            ("../outside.pdf", SkillFileKind::Document),
            ("/etc/hosts", SkillFileKind::Document),
            ("assets/missing.png", SkillFileKind::Media),
            ("assets", SkillFileKind::Media),
        ] {
            assert!(resolve_skill_file(&root, path, kind).is_err(), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_out_of_the_skill_folder_and_linked_folders_are_not_followed() {
        use std::os::unix::fs::symlink;

        let (temp, root) = skill();
        let outside = temp.path().canonicalize().unwrap().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(outside.join("secret.md"), root.join("references/secret.md")).unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        symlink(
            root.join("references/guide.md"),
            root.join("references/alias.md"),
        )
        .unwrap();

        let references = list_skill_files(&root, "references").unwrap();

        assert!(
            !names(&list_skill_files(&root, "").unwrap())
                .contains(&("linked", SkillFileKind::Directory))
        );
        assert!(list_skill_files(&root, "linked").is_err());
        assert!(!names(&references).contains(&("references/secret.md", SkillFileKind::Markdown)));
        assert!(read_skill_markdown(&root, "references/secret.md").is_err());
        assert!(read_skill_markdown(&root, "linked/secret.md").is_err());
        fs::write(outside.join("secret.pdf"), "pdf").unwrap();
        symlink(outside.join("secret.pdf"), root.join("assets/escape.pdf")).unwrap();
        assert!(resolve_skill_file(&root, "assets/escape.pdf", SkillFileKind::Document).is_err());
        assert!(resolve_skill_file(&root, "linked/secret.pdf", SkillFileKind::Document).is_err());
        let alias = references
            .files
            .iter()
            .find(|file| file.path == "references/alias.md")
            .unwrap();
        assert_eq!(
            alias.canonical_path,
            path_string(&root.join("references/guide.md"))
        );
        assert_eq!(
            read_skill_markdown(&root, "references/alias.md")
                .unwrap()
                .markdown,
            "# Guide"
        );
    }
}
