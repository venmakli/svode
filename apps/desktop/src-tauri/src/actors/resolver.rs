use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;

use super::mailmap::{
    Identity, MailmapDiagnostic, MailmapDocument, MailmapRule, mailmap_size_is_safe,
    normalize_email,
};
use crate::error::AppError;
use crate::git::cli::GitCli;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorCandidate {
    pub email: String,
    pub name: String,
    pub last_commit_at: Option<i64>,
    pub commit_count: u64,
    pub is_me: bool,
    pub alias_emails: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActorSourceKind {
    History,
    CurrentGitIdentity,
    Mailmap,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct ActorSource {
    kind: ActorSourceKind,
    name: String,
    email: String,
    line: Option<usize>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct ActorAlias {
    name: Option<String>,
    email: String,
    line: Option<usize>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct ActorRow {
    candidate: ActorCandidate,
    aliases: Vec<ActorAlias>,
    sources: Vec<ActorSource>,
    is_current: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ActorSnapshot {
    repository_id: String,
    generation: u64,
    rows: Vec<ActorRow>,
    mailmap: MailmapDocument,
    diagnostics: Vec<MailmapDiagnostic>,
}

impl ActorSnapshot {
    pub fn candidates(&self) -> Vec<ActorCandidate> {
        self.rows.iter().map(|row| row.candidate.clone()).collect()
    }

    pub fn current_email(&self) -> Option<&str> {
        self.rows
            .iter()
            .find(|row| row.is_current)
            .map(|row| row.candidate.email.as_str())
    }

    #[allow(dead_code)]
    pub fn canonical_email(&self, name: &str, email: &str) -> String {
        self.mailmap.resolve(name, email).email
    }

    pub fn equivalent_emails(&self, email: &str) -> Vec<String> {
        let normalized = normalize_email(email);
        let canonical = self.mailmap.resolve("", &normalized).email;
        let Some(row) = self
            .rows
            .iter()
            .find(|row| row.candidate.email == canonical)
        else {
            return (!normalized.is_empty())
                .then_some(normalized)
                .into_iter()
                .collect();
        };

        let mut equivalents = HashSet::from([row.candidate.email.clone()]);
        equivalents.extend(row.candidate.alias_emails.iter().cloned());
        let mut equivalents: Vec<_> = equivalents.into_iter().collect();
        equivalents.sort();
        equivalents
    }

    #[cfg(test)]
    fn repository_id(&self) -> &str {
        &self.repository_id
    }

    #[cfg(test)]
    fn generation(&self) -> u64 {
        self.generation
    }

    #[cfg(test)]
    fn diagnostics(&self) -> &[MailmapDiagnostic] {
        &self.diagnostics
    }
}

#[derive(Default)]
pub struct ActorCatalogState {
    snapshots: Mutex<HashMap<PathBuf, Arc<ActorSnapshot>>>,
    repository_locks: Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>,
}

impl ActorCatalogState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(
        &self,
        cli: &GitCli,
        space_path: &Path,
    ) -> Result<Arc<ActorSnapshot>, AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        if let Some(snapshot) = self.cached(&repository)? {
            return Ok(snapshot);
        }
        let repository_lock = self.repository_lock(&repository)?;
        let _load_guard = repository_lock.lock().await;
        if let Some(snapshot) = self.cached(&repository)? {
            return Ok(snapshot);
        }
        self.load_and_publish(cli, &repository).await
    }

    pub async fn refresh(
        &self,
        cli: &GitCli,
        space_path: &Path,
    ) -> Result<Arc<ActorSnapshot>, AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        let repository_lock = self.repository_lock(&repository)?;
        let _load_guard = repository_lock.lock().await;
        self.load_and_publish(cli, &repository).await
    }

    fn cached(&self, repository: &Path) -> Result<Option<Arc<ActorSnapshot>>, AppError> {
        self.snapshots
            .lock()
            .map(|snapshots| snapshots.get(repository).cloned())
            .map_err(|_| AppError::General("actor snapshot cache lock poisoned".into()))
    }

    fn repository_lock(&self, repository: &Path) -> Result<Arc<AsyncMutex<()>>, AppError> {
        let mut locks = self
            .repository_locks
            .lock()
            .map_err(|_| AppError::General("actor repository lock cache poisoned".into()))?;
        Ok(locks
            .entry(repository.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }

    async fn load_and_publish(
        &self,
        cli: &GitCli,
        repository: &Path,
    ) -> Result<Arc<ActorSnapshot>, AppError> {
        let generation = self
            .cached(repository)?
            .map_or(1, |snapshot| snapshot.generation.saturating_add(1));
        let snapshot = Arc::new(load_snapshot(cli, repository, generation).await?);
        self.snapshots
            .lock()
            .map_err(|_| AppError::General("actor snapshot cache lock poisoned".into()))?
            .insert(repository.to_path_buf(), snapshot.clone());
        Ok(snapshot)
    }
}

async fn resolve_repository(cli: &GitCli, space_path: &Path) -> Result<PathBuf, AppError> {
    let output = cli
        .exec(space_path, &["rev-parse", "--show-toplevel"])
        .await?;
    if output.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to resolve actor repository for {}: {}",
            space_path.display(),
            output.stderr.trim()
        )));
    }
    let root = PathBuf::from(output.stdout.trim());
    fs::canonicalize(&root).map_err(|error| {
        AppError::GitCommandFailed(format!(
            "failed to canonicalize actor repository {}: {error}",
            root.display()
        ))
    })
}

async fn load_snapshot(
    cli: &GitCli,
    repository: &Path,
    generation: u64,
) -> Result<ActorSnapshot, AppError> {
    let mut mailmap = read_mailmap(repository);
    detect_custom_mailmap_sources(cli, repository, &mut mailmap).await?;

    let mut rows: HashMap<String, ActorRowBuilder> = HashMap::new();
    for rule in &mailmap.rules {
        materialize_declaration(&mut rows, rule);
    }

    let history = cli
        .exec(
            repository,
            &[
                "log",
                "--no-use-mailmap",
                "--all",
                "--format=%H%x00%an%x00%ae%x00%at",
            ],
        )
        .await?;
    if history.exit_code != 0 && !is_unborn_repository(cli, repository).await? {
        return Err(AppError::GitCommandFailed(format!(
            "failed to scan actor history in {}: {}",
            repository.display(),
            history.stderr.trim()
        )));
    }
    let mut seen_commits = HashSet::new();
    for record in history.stdout.lines() {
        let mut parts = record.splitn(4, '\0');
        let commit_id = parts.next().unwrap_or_default().trim();
        let raw_name = parts.next().unwrap_or_default().trim();
        let raw_email = parts.next().unwrap_or_default().trim();
        let timestamp = parts.next().unwrap_or_default().trim().parse::<i64>().ok();
        if commit_id.is_empty()
            || raw_email.is_empty()
            || !seen_commits.insert(commit_id.to_string())
        {
            continue;
        }
        let identity = mailmap.resolve(raw_name, raw_email);
        if identity.email.is_empty() {
            continue;
        }
        rows.entry(identity.email.clone())
            .or_insert_with(|| ActorRowBuilder::new(&identity))
            .add_history(&identity, raw_name, raw_email, timestamp);
    }

    if let Some(current) = current_git_identity(cli, repository).await? {
        let resolved = mailmap.resolve(&current.name, &current.email);
        if !resolved.email.is_empty() {
            rows.entry(resolved.email.clone())
                .or_insert_with(|| ActorRowBuilder::new(&resolved))
                .add_current(&resolved, &current);
        }
    }

    let current_email = rows.iter().find_map(|(email, row)| {
        row.is_current
            .then_some(email.as_str())
            .map(ToOwned::to_owned)
    });
    let mut rows: Vec<_> = rows
        .into_values()
        .map(|row| row.finish(current_email.as_deref(), &mailmap))
        .collect();
    rows.sort_by(|left, right| {
        right
            .candidate
            .last_commit_at
            .cmp(&left.candidate.last_commit_at)
            .then_with(|| {
                left.candidate
                    .name
                    .to_lowercase()
                    .cmp(&right.candidate.name.to_lowercase())
            })
            .then_with(|| left.candidate.email.cmp(&right.candidate.email))
    });

    Ok(ActorSnapshot {
        repository_id: repository.to_string_lossy().into_owned(),
        generation,
        rows,
        diagnostics: mailmap.diagnostics.clone(),
        mailmap,
    })
}

async fn is_unborn_repository(cli: &GitCli, repository: &Path) -> Result<bool, AppError> {
    let output = cli
        .exec(repository, &["rev-parse", "--verify", "HEAD"])
        .await?;
    Ok(output.exit_code != 0)
}

fn read_mailmap(repository: &Path) -> MailmapDocument {
    let path = repository.join(".mailmap");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return MailmapDocument::default(),
        Err(error) => {
            return MailmapDocument::unsafe_file(format!(
                "cannot inspect {}: {error}",
                path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() {
        return MailmapDocument::unsafe_file(format!(
            "{} is a symlink; Svode does not follow .mailmap symlinks",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return MailmapDocument::unsafe_file(format!("{} is not a regular file", path.display()));
    }
    if !mailmap_size_is_safe(metadata.len()) {
        return MailmapDocument::unsafe_file(format!(
            "{} exceeds the supported size limit",
            path.display()
        ));
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return MailmapDocument::unsafe_file(format!(
                "cannot read {}: {error}",
                path.display()
            ));
        }
    };
    match String::from_utf8(bytes) {
        Ok(raw) => MailmapDocument::parse(&raw),
        Err(_) => MailmapDocument::unsafe_file(format!("{} is not UTF-8", path.display())),
    }
}

async fn detect_custom_mailmap_sources(
    cli: &GitCli,
    repository: &Path,
    mailmap: &mut MailmapDocument,
) -> Result<(), AppError> {
    for key in ["mailmap.file", "mailmap.blob"] {
        let output = cli.exec(repository, &["config", "--get", key]).await?;
        if output.exit_code == 0 && !output.stdout.trim().is_empty() {
            mailmap.add_diagnostic(MailmapDocument::custom_source(key, output.stdout.trim()));
        }
    }
    Ok(())
}

async fn current_git_identity(
    cli: &GitCli,
    repository: &Path,
) -> Result<Option<Identity>, AppError> {
    let name = git_config_value(cli, repository, "user.name").await?;
    let email = git_config_value(cli, repository, "user.email").await?;
    Ok(email.map(|email| Identity {
        name: name.unwrap_or_default(),
        email: normalize_email(&email),
    }))
}

async fn git_config_value(
    cli: &GitCli,
    repository: &Path,
    key: &str,
) -> Result<Option<String>, AppError> {
    let output = cli.exec(repository, &["config", "--get", key]).await?;
    if output.exit_code != 0 {
        return Ok(None);
    }
    let value = output.stdout.trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn materialize_declaration(rows: &mut HashMap<String, ActorRowBuilder>, rule: &MailmapRule) {
    let row = rows
        .entry(rule.canonical.email.clone())
        .or_insert_with(|| ActorRowBuilder::new(&rule.canonical));
    row.prefer_name(&rule.canonical.name);
    row.add_alias(
        rule.alias_name.as_deref(),
        &rule.alias_email,
        Some(rule.line),
    );
    row.add_source(
        ActorSourceKind::Mailmap,
        &rule.canonical.name,
        &rule.canonical.email,
        Some(rule.line),
    );
}

struct ActorRowBuilder {
    email: String,
    name: String,
    last_commit_at: Option<i64>,
    commit_count: u64,
    aliases: Vec<ActorAlias>,
    sources: Vec<ActorSource>,
    is_current: bool,
}

impl ActorRowBuilder {
    fn new(identity: &Identity) -> Self {
        Self {
            email: identity.email.clone(),
            name: display_name(identity),
            last_commit_at: None,
            commit_count: 0,
            aliases: vec![ActorAlias {
                name: (!identity.name.is_empty()).then(|| identity.name.clone()),
                email: identity.email.clone(),
                line: None,
            }],
            sources: Vec::new(),
            is_current: false,
        }
    }

    fn prefer_name(&mut self, name: &str) {
        if !name.trim().is_empty() {
            self.name = name.trim().to_string();
        }
    }

    fn add_alias(&mut self, name: Option<&str>, email: &str, line: Option<usize>) {
        let email = normalize_email(email);
        let name = name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned);
        if self.aliases.iter().any(|alias| {
            alias.email == email
                && alias.name.as_deref().map(str::to_lowercase)
                    == name.as_deref().map(str::to_lowercase)
        }) {
            return;
        }
        self.aliases.push(ActorAlias { name, email, line });
    }

    fn add_history(
        &mut self,
        resolved: &Identity,
        raw_name: &str,
        raw_email: &str,
        timestamp: Option<i64>,
    ) {
        self.commit_count += 1;
        let is_latest = timestamp > self.last_commit_at;
        if is_latest {
            self.last_commit_at = timestamp;
            self.prefer_name(&resolved.name);
        }
        self.add_alias(Some(raw_name), raw_email, None);
        self.add_source(ActorSourceKind::History, raw_name, raw_email, None);
    }

    fn add_current(&mut self, resolved: &Identity, raw: &Identity) {
        self.is_current = true;
        if self.commit_count == 0 {
            self.prefer_name(&resolved.name);
        }
        self.add_alias(Some(&raw.name), &raw.email, None);
        self.add_source(
            ActorSourceKind::CurrentGitIdentity,
            &raw.name,
            &raw.email,
            None,
        );
    }

    fn add_source(&mut self, kind: ActorSourceKind, name: &str, email: &str, line: Option<usize>) {
        let name = name.trim();
        let email = normalize_email(email);
        if self.sources.iter().any(|source| {
            source.kind == kind
                && source.name.eq_ignore_ascii_case(name)
                && source.email == email
                && source.line == line
        }) {
            return;
        }
        self.sources.push(ActorSource {
            kind,
            name: name.to_string(),
            email,
            line,
        });
    }

    fn finish(self, current_email: Option<&str>, mailmap: &MailmapDocument) -> ActorRow {
        let mut alias_emails: Vec<_> = self
            .aliases
            .iter()
            .filter(|alias| alias.name.is_none())
            .map(|alias| alias.email.clone())
            .filter(|email| email != &self.email)
            .filter(|email| mailmap.resolve("", email).email == self.email)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        alias_emails.sort();
        ActorRow {
            candidate: ActorCandidate {
                is_me: current_email == Some(self.email.as_str()),
                email: self.email,
                name: self.name,
                last_commit_at: self.last_commit_at,
                commit_count: self.commit_count,
                alias_emails,
            },
            aliases: self.aliases,
            sources: self.sources,
            is_current: self.is_current,
        }
    }
}

fn display_name(identity: &Identity) -> String {
    if identity.name.trim().is_empty() {
        identity.email.clone()
    } else {
        identity.name.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;
    use crate::actors::mailmap::MailmapDiagnosticKind;

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .env("LC_ALL", "C")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(name: &str, email: &str) -> TempDir {
        let temp = tempfile::tempdir().expect("temp repository");
        git(temp.path(), &["init", "--quiet"]);
        git(temp.path(), &["config", "user.name", name]);
        git(temp.path(), &["config", "user.email", email]);
        temp
    }

    fn commit(path: &Path, file: &str, contents: &str, message: &str) {
        fs::write(path.join(file), contents).expect("write commit file");
        git(path, &["add", file]);
        git(path, &["commit", "--quiet", "-m", message]);
    }

    #[tokio::test]
    async fn current_identity_materializes_without_commits_and_unknown_value_does_not() {
        let repo = init_repo("Current User", "CURRENT@EXAMPLE.TEST");
        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();

        let snapshot = state.snapshot(&cli, repo.path()).await.expect("snapshot");
        assert_eq!(snapshot.current_email(), Some("current@example.test"));
        assert_eq!(snapshot.candidates().len(), 1);
        assert_eq!(snapshot.candidates()[0].commit_count, 0);
        assert_eq!(
            snapshot.equivalent_emails(" UNKNOWN@EXAMPLE.TEST "),
            vec!["unknown@example.test"]
        );
        assert_eq!(snapshot.candidates().len(), 1);
    }

    #[tokio::test]
    async fn root_and_inline_share_generation_and_refresh_replaces_snapshot() {
        let repo = init_repo("Root", "root@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        let inline = repo.path().join("inline");
        fs::create_dir(&inline).expect("inline directory");
        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();

        let (root, child) = tokio::join!(
            state.snapshot(&cli, repo.path()),
            state.snapshot(&cli, &inline)
        );
        let root = root.expect("root snapshot");
        let child = child.expect("inline snapshot");
        assert!(Arc::ptr_eq(&root, &child));
        assert_eq!(root.repository_id(), child.repository_id());
        assert_eq!(root.generation(), 1);

        let refreshed = state
            .refresh(&cli, &inline)
            .await
            .expect("refresh snapshot");
        assert_eq!(refreshed.generation(), 2);
        assert!(!Arc::ptr_eq(&root, &refreshed));
    }

    #[tokio::test]
    async fn nested_independent_repository_is_isolated_from_root_history_and_mailmap() {
        let root = init_repo("Root", "root@example.test");
        commit(root.path(), "root.txt", "root", "root");
        fs::write(
            root.path().join(".mailmap"),
            "Mapped Root <mapped@example.test> <root@example.test>\n",
        )
        .expect("root mailmap");

        let child_path = root.path().join("child");
        fs::create_dir(&child_path).expect("child directory");
        git(&child_path, &["init", "--quiet"]);
        git(&child_path, &["config", "user.name", "Child"]);
        git(&child_path, &["config", "user.email", "child@example.test"]);
        commit(&child_path, "child.txt", "child", "child");

        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();
        let root_snapshot = state.snapshot(&cli, root.path()).await.expect("root");
        let child_snapshot = state.snapshot(&cli, &child_path).await.expect("child");

        assert_ne!(
            root_snapshot.repository_id(),
            child_snapshot.repository_id()
        );
        assert!(
            root_snapshot
                .candidates()
                .iter()
                .any(|actor| actor.email == "mapped@example.test")
        );
        assert_eq!(
            child_snapshot
                .candidates()
                .iter()
                .map(|actor| actor.email.as_str())
                .collect::<Vec<_>>(),
            vec!["child@example.test"]
        );
    }

    #[tokio::test]
    async fn custom_mailmap_source_is_diagnostic_and_never_changes_portable_catalog() {
        let repo = init_repo("Alias", "alias@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        let custom = repo.path().join("custom.mailmap");
        fs::write(
            &custom,
            "Custom <custom@example.test> <alias@example.test>\n",
        )
        .expect("custom mailmap");
        git(
            repo.path(),
            &[
                "config",
                "mailmap.file",
                custom.to_str().expect("utf8 path"),
            ],
        );

        let cli = GitCli::detect().expect("git CLI");
        let snapshot = ActorCatalogState::new()
            .snapshot(&cli, repo.path())
            .await
            .expect("snapshot");

        assert!(snapshot.diagnostics().iter().any(|diagnostic| {
            diagnostic.kind == MailmapDiagnosticKind::CustomSource && !diagnostic.blocking
        }));
        assert!(
            snapshot
                .candidates()
                .iter()
                .any(|actor| actor.email == "alias@example.test")
        );
        assert!(
            snapshot
                .candidates()
                .iter()
                .all(|actor| actor.email != "custom@example.test")
        );
    }

    #[tokio::test]
    async fn canonical_declarations_and_aliases_share_one_row() {
        let repo = init_repo("Commit Name", "old@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        commit(repo.path(), "two.txt", "two", "two");
        fs::write(
            repo.path().join(".mailmap"),
            "Canonical <new@example.test> <old@example.test>\n",
        )
        .expect("mailmap");

        let cli = GitCli::detect().expect("git CLI");
        let snapshot = ActorCatalogState::new()
            .snapshot(&cli, repo.path())
            .await
            .expect("snapshot");
        let actors = snapshot.candidates();

        assert_eq!(actors.len(), 1);
        assert_eq!(actors[0].email, "new@example.test");
        assert_eq!(actors[0].alias_emails, vec!["old@example.test"]);
        assert_eq!(actors[0].commit_count, 2);
        assert_eq!(snapshot.current_email(), Some("new@example.test"));
        assert_eq!(
            snapshot.equivalent_emails("new@example.test"),
            vec!["new@example.test", "old@example.test"]
        );
        assert_eq!(
            snapshot.canonical_email("commit name", "old@example.test"),
            "new@example.test"
        );
        assert_eq!(
            snapshot.rows[0]
                .sources
                .iter()
                .filter(|source| source.kind == ActorSourceKind::History)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn name_qualified_aliases_are_not_email_only_property_aliases() {
        let repo = init_repo("Commit Name", "old@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        fs::write(
            repo.path().join(".mailmap"),
            "Canonical <new@example.test> Commit Name <old@example.test>\n",
        )
        .expect("mailmap");

        let cli = GitCli::detect().expect("git CLI");
        let snapshot = ActorCatalogState::new()
            .snapshot(&cli, repo.path())
            .await
            .expect("snapshot");
        let actors = snapshot.candidates();

        assert_eq!(actors.len(), 1);
        assert_eq!(actors[0].email, "new@example.test");
        assert!(actors[0].alias_emails.is_empty());
        assert_eq!(
            snapshot.equivalent_emails("old@example.test"),
            vec!["old@example.test"]
        );
        assert_eq!(
            snapshot.canonical_email("Commit Name", "old@example.test"),
            "new@example.test"
        );
        assert_eq!(
            snapshot.canonical_email("", "old@example.test"),
            "old@example.test"
        );
    }
}
