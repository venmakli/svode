//! The source a restore writes for a Page whose file disappeared while it
//! held unsaved work: what a save of its body and metadata would have left,
//! from the bytes it was last read from when Git still has them.

use std::path::Path;

use crate::page::dates::GitDateExecutor;
use crate::page::frontmatter::{self, FrontmatterFields, ParseStatus};
use crate::page::store::{PageMeta, order_fields_for_write};
use crate::page::{Cover, PageError, SourceVersion, fallback_title, source_version_for};

/// The metadata of the Page as its session holds it, unsaved edits applied.
#[derive(Debug, Clone, Default)]
pub struct PageRestoreMeta {
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<Cover>,
    pub extra: FrontmatterFields,
}

pub struct PageRestoreSource<'a> {
    pub space: &'a str,
    /// Relative Markdown path the Page had.
    pub path: &'a str,
    /// The body text with the unsaved edits.
    pub body: &'a str,
    pub meta: PageRestoreMeta,
    /// Version of the source the session last read; Git's copy of the path
    /// with exactly these bytes is the source the save starts from.
    pub source_version: Option<&'a SourceVersion>,
}

/// The complete Markdown source for [`super::restore`]. The last read bytes
/// come from the index or `HEAD` of the Space when their version matches;
/// a save there keeps the frontmatter bytes when the metadata is unchanged
/// and writes the changed metadata as a field write does. Without them the
/// metadata is written by the presence rules of a save of a file without
/// frontmatter: a title only when it differs from the one the file name
/// gives, and no dates.
pub async fn restore_source<E: GitDateExecutor>(
    request: PageRestoreSource<'_>,
    git: Option<&E>,
) -> Result<String, PageError> {
    let base = match (request.source_version, git) {
        (Some(version), Some(git)) => {
            last_read_source(git, request.space, request.path, version).await
        }
        _ => None,
    };
    Ok(compose(
        request.space,
        request.path,
        base.as_deref(),
        request.meta,
        request.body,
    ))
}

/// Git's copy of `path` whose bytes have `version`: the staged one, then the
/// committed one.
async fn last_read_source<E: GitDateExecutor>(
    git: &E,
    space: &str,
    path: &str,
    version: &SourceVersion,
) -> Option<String> {
    for revision in ["", "HEAD"] {
        let object = format!("{revision}:./{path}");
        let Some(output) = git
            .exec(Path::new(space), &["cat-file", "blob", &object])
            .await
        else {
            continue;
        };
        if output.exit_code != 0 {
            continue;
        }
        if source_version_for(Path::new(space), path, output.stdout.as_bytes()).ok()
            == Some(version.clone())
        {
            return Some(output.stdout);
        }
    }
    None
}

fn compose(
    space: &str,
    path: &str,
    base: Option<&str>,
    request: PageRestoreMeta,
    body: &str,
) -> String {
    let (previous, frontmatter_source) =
        match base.map(|base| (base, frontmatter::parse_status(base))) {
            Some((base, ParseStatus::Valid { meta, .. })) => (meta, Some(base)),
            _ => (PageMeta::synthesized(fallback_title(path), "", ""), None),
        };
    let mut next = previous.clone();
    let mut changed = false;
    if next.title != request.title {
        next.title = request.title;
        next.mark_title_present();
        changed = true;
    }
    if next.icon != request.icon {
        next.icon = request.icon;
        next.mark_icon_present();
        changed = true;
    }
    if next.description != request.description {
        next.description = request.description;
        next.mark_description_present();
        changed = true;
    }
    if next.cover != request.cover {
        next.cover = request.cover;
        next.mark_cover_present();
        changed = true;
    }
    if next.extra != request.extra {
        next.extra = order_fields_for_write(space, path, &previous.extra, request.extra);
        changed = true;
    }
    if changed {
        return frontmatter::serialize(&next, body);
    }
    match frontmatter_source {
        Some(base) => frontmatter::replace_body_preserving_frontmatter(base, body)
            .unwrap_or_else(|_| frontmatter::serialize(&next, body)),
        None => body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use super::*;
    use crate::index::state::IndexRuntimeState;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::page::nonce::WriteNonceRegistry;
    use crate::page::test_support::{runtime, scaffold_space};
    use crate::page::write::{PageWrite, write};
    use crate::page::{current_source_version, store};

    /// Frontmatter a save keeps byte for byte: quoting, a comment, CRLF and
    /// a key order no serializer would choose.
    const SOURCE: &str =
        "---\r\nstatus: 'draft'   # kept\r\ntitle: \"Plan\"\r\nicon: 🚀\r\n---\r\n\r\nOld body\r\n";

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", root)
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?}: {status:?}");
    }

    /// A Space repository with `docs/plan.md` committed as `source`.
    fn repository(source: &str) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        scaffold_space(root, "Space");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/plan.md"), source).unwrap();
        git(root, &["init", "-q"]);
        git(root, &["config", "core.autocrlf", "false"]);
        git(root, &["add", "-A"]);
        git(
            root,
            &[
                "-c",
                "user.name=Svode",
                "-c",
                "user.email=svode@example.com",
                "commit",
                "-qm",
                "init",
            ],
        );
        temp
    }

    fn meta_of(page: &store::Page) -> PageRestoreMeta {
        PageRestoreMeta {
            title: page.meta.title.clone(),
            icon: page.meta.icon.clone(),
            description: page.meta.description.clone(),
            cover: page.meta.cover.clone(),
            extra: page.meta.extra.clone(),
        }
    }

    async fn restored(
        root: &Path,
        meta: PageRestoreMeta,
        body: &str,
        version: &SourceVersion,
    ) -> String {
        restore_source(
            PageRestoreSource {
                space: root.to_str().unwrap(),
                path: "docs/plan.md",
                body,
                meta,
                source_version: Some(version),
            },
            Some(&SystemGitDateExecutor),
        )
        .await
        .unwrap()
    }

    /// What a save of `body` with `extra` writes over the last read source.
    async fn saved(root: &Path, body: &str, extra: Option<FrontmatterFields>) -> String {
        let state = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::new();
        write(
            PageWrite {
                space: root.to_str().unwrap(),
                path: "docs/plan.md",
                content: body,
                title: None,
                icon: None,
                extra,
                metadata: None,
                field_batch: None,
                skip_rename: true,
                project: Some(root.to_str().unwrap()),
                source_version: None,
            },
            runtime(&state, &nonces),
            |mut paths| async move {
                paths.push(root.to_path_buf());
                Ok::<_, PageError>(paths)
            },
        )
        .await
        .unwrap();
        fs::read_to_string(root.join("docs/plan.md")).unwrap()
    }

    #[tokio::test]
    async fn the_committed_last_read_source_keeps_its_frontmatter_bytes_as_a_save_does() {
        let temp = repository(SOURCE);
        let root = temp.path().canonicalize().unwrap();
        let page = store::read(root.to_str().unwrap(), "docs/plan.md").unwrap();
        let version = current_source_version(&root, "docs/plan.md").unwrap();
        let expected = saved(&root, "\r\nNew body\r\n", None).await;
        fs::remove_file(root.join("docs/plan.md")).unwrap();

        let source = restored(&root, meta_of(&page), "\r\nNew body\r\n", &version).await;

        assert_eq!(source, expected);
        assert!(source.starts_with("---\r\nstatus: 'draft'   # kept\r\n"));
    }

    #[tokio::test]
    async fn a_staged_last_read_source_is_found_in_the_index() {
        let temp = repository("---\ntitle: First\n---\nBody\n");
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("docs/plan.md"), SOURCE).unwrap();
        git(&root, &["add", "docs/plan.md"]);
        let page = store::read(root.to_str().unwrap(), "docs/plan.md").unwrap();
        let version = current_source_version(&root, "docs/plan.md").unwrap();
        fs::remove_file(root.join("docs/plan.md")).unwrap();

        let source = restored(&root, meta_of(&page), "Edited\r\n", &version).await;

        assert_eq!(
            source,
            frontmatter::replace_body_preserving_frontmatter(SOURCE, "Edited\r\n").unwrap()
        );
    }

    #[tokio::test]
    async fn changed_metadata_over_the_last_read_source_is_written_as_a_field_save_writes_it() {
        let temp = repository(SOURCE);
        let root = temp.path().canonicalize().unwrap();
        let page = store::read(root.to_str().unwrap(), "docs/plan.md").unwrap();
        let version = current_source_version(&root, "docs/plan.md").unwrap();
        let mut meta = meta_of(&page);
        meta.extra
            .insert("status".into(), serde_norway::Value::String("done".into()));
        meta.extra
            .insert("owner".into(), serde_norway::Value::String("Ann".into()));
        let expected = saved(&root, "Body\n", Some(meta.extra.clone())).await;
        fs::remove_file(root.join("docs/plan.md")).unwrap();

        let source = restored(&root, meta, "Body\n", &version).await;

        assert_eq!(source, expected);
    }

    #[tokio::test]
    async fn without_the_last_read_bytes_the_metadata_follows_the_presence_rules_of_a_save() {
        let temp = repository(SOURCE);
        let root = temp.path().canonicalize().unwrap();
        // The session read a later version Git does not have.
        let version = SourceVersion::from_token("not-in-git");
        let mut extra = FrontmatterFields::new();
        extra.insert("status".into(), serde_norway::Value::String("draft".into()));
        let meta = |title: &str| PageRestoreMeta {
            title: title.into(),
            icon: Some("🚀".into()),
            extra: extra.clone(),
            ..PageRestoreMeta::default()
        };
        fs::remove_file(root.join("docs/plan.md")).unwrap();

        // The title the file name gives is not written; dates never are.
        assert_eq!(
            restored(&root, meta("Plan"), "Body\n", &version).await,
            "---\nicon: 🚀\nstatus: draft\n---\nBody\n"
        );
        assert_eq!(
            restored(&root, meta("Roadmap"), "Body\n", &version).await,
            "---\ntitle: Roadmap\nicon: 🚀\nstatus: draft\n---\nBody\n"
        );
        // Nothing beyond what the file name gives: a file without frontmatter.
        assert_eq!(
            restored(
                &root,
                PageRestoreMeta {
                    title: "Plan".into(),
                    ..PageRestoreMeta::default()
                },
                "Body\n",
                &version,
            )
            .await,
            "Body\n"
        );
    }

    #[tokio::test]
    async fn without_git_or_a_version_the_source_is_composed_from_the_metadata() {
        let temp = repository(SOURCE);
        let root = temp.path().canonicalize().unwrap();
        let page = store::read(root.to_str().unwrap(), "docs/plan.md").unwrap();
        fs::remove_file(root.join("docs/plan.md")).unwrap();

        let source = restore_source::<SystemGitDateExecutor>(
            PageRestoreSource {
                space: root.to_str().unwrap(),
                path: "docs/plan.md",
                body: "Body\n",
                meta: meta_of(&page),
                source_version: None,
            },
            None,
        )
        .await
        .unwrap();

        // The title the file name gives stays implicit, as in the file read.
        assert_eq!(source, "---\nicon: 🚀\nstatus: draft\n---\nBody\n");
    }
}
