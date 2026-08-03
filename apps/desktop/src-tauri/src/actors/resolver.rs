use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{Datelike, Local, NaiveDate, TimeZone};
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorContribution {
    Contributor,
    NoCommits,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorCatalogAlias {
    pub name: Option<String>,
    pub email: String,
    pub line: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorCatalogSourceKind {
    History,
    CurrentGitIdentity,
    Mailmap,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorCatalogSource {
    pub kind: ActorCatalogSourceKind,
    pub name: String,
    pub email: String,
    pub line: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorCatalogDiagnosticKind {
    InvalidLine,
    UnsafeFile,
    CustomSource,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorCatalogDiagnostic {
    pub kind: ActorCatalogDiagnosticKind,
    pub line: Option<usize>,
    pub message: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorCatalogRow {
    pub canonical_email: String,
    pub display_name: String,
    pub contribution: ActorContribution,
    pub commit_count: u64,
    pub last_commit_at: Option<i64>,
    pub last_activity_date: Option<String>,
    pub available_years: Vec<i32>,
    pub aliases: Vec<ActorCatalogAlias>,
    pub sources: Vec<ActorCatalogSource>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorCatalog {
    pub repository_id: String,
    pub generation: u64,
    pub rows: Vec<ActorCatalogRow>,
    pub diagnostics: Vec<ActorCatalogDiagnostic>,
    pub shallow: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorActivityDay {
    pub date: String,
    pub commit_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorActivityCommit {
    pub subject: String,
    pub authored_at: i64,
    pub local_date: String,
    pub local_time: String,
    pub short_sha: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorActivityMonth {
    pub month: String,
    pub commit_count: u64,
    pub commits: Vec<ActorActivityCommit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorActivityTimeline {
    pub day: Option<String>,
    pub months: Vec<ActorActivityMonth>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorActivity {
    pub repository_id: String,
    pub generation: u64,
    pub canonical_email: String,
    pub available_years: Vec<i32>,
    pub selected_year: i32,
    pub range_start: String,
    pub range_end_exclusive: String,
    pub commit_count: u64,
    pub days: Vec<ActorActivityDay>,
    pub timeline: ActorActivityTimeline,
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
    available_years: Vec<i32>,
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
    shallow: bool,
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

    pub fn catalog(&self) -> ActorCatalog {
        ActorCatalog {
            repository_id: self.repository_id.clone(),
            generation: self.generation,
            rows: self
                .rows
                .iter()
                .map(|row| ActorCatalogRow {
                    canonical_email: row.candidate.email.clone(),
                    display_name: row.candidate.name.clone(),
                    contribution: if row.candidate.commit_count == 0 {
                        ActorContribution::NoCommits
                    } else {
                        ActorContribution::Contributor
                    },
                    commit_count: row.candidate.commit_count,
                    last_commit_at: row.candidate.last_commit_at,
                    last_activity_date: row
                        .candidate
                        .last_commit_at
                        .and_then(local_date_for_timestamp)
                        .map(|date| date.format("%Y-%m-%d").to_string()),
                    available_years: row.available_years.clone(),
                    aliases: row
                        .aliases
                        .iter()
                        .map(|alias| ActorCatalogAlias {
                            name: alias.name.clone(),
                            email: alias.email.clone(),
                            line: alias.line,
                        })
                        .collect(),
                    sources: row
                        .sources
                        .iter()
                        .map(|source| ActorCatalogSource {
                            kind: match source.kind {
                                ActorSourceKind::History => ActorCatalogSourceKind::History,
                                ActorSourceKind::CurrentGitIdentity => {
                                    ActorCatalogSourceKind::CurrentGitIdentity
                                }
                                ActorSourceKind::Mailmap => ActorCatalogSourceKind::Mailmap,
                            },
                            name: source.name.clone(),
                            email: source.email.clone(),
                            line: source.line,
                        })
                        .collect(),
                })
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(|diagnostic| ActorCatalogDiagnostic {
                    kind: match diagnostic.kind {
                        super::mailmap::MailmapDiagnosticKind::InvalidLine => {
                            ActorCatalogDiagnosticKind::InvalidLine
                        }
                        super::mailmap::MailmapDiagnosticKind::UnsafeFile => {
                            ActorCatalogDiagnosticKind::UnsafeFile
                        }
                        super::mailmap::MailmapDiagnosticKind::CustomSource => {
                            ActorCatalogDiagnosticKind::CustomSource
                        }
                    },
                    line: diagnostic.line,
                    message: diagnostic.message.clone(),
                    blocking: diagnostic.blocking,
                })
                .collect(),
            shallow: self.shallow,
        }
    }

    pub(super) fn mutation_actor(&self, email: &str) -> Option<MutationActor> {
        let email = normalize_email(email);
        let row = self.rows.iter().find(|row| {
            row.candidate.email == email || row.aliases.iter().any(|alias| alias.email == email)
        })?;
        Some(MutationActor {
            canonical_email: row.candidate.email.clone(),
            display_name: row.candidate.name.clone(),
            aliases: row
                .aliases
                .iter()
                .map(|alias| (alias.name.clone(), alias.email.clone()))
                .collect(),
            is_current: row.is_current,
        })
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

pub(super) struct MutationActor {
    pub canonical_email: String,
    pub display_name: String,
    pub aliases: Vec<(Option<String>, String)>,
    pub is_current: bool,
}

const MAX_ACTIVITY_CACHE_ENTRIES: usize = 64;
const ACTIVITY_PAGE_SIZE: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ActivityCacheKey {
    repository: PathBuf,
    generation: u64,
    canonical_email: String,
    year: i32,
}

#[derive(Debug, Clone)]
struct ActivityCommit {
    sha: String,
    subject: String,
    authored_at: i64,
    local_date: NaiveDate,
    local_time: String,
}

#[derive(Debug)]
struct ActorActivityYear {
    range_start: NaiveDate,
    range_end_exclusive: NaiveDate,
    commits: Vec<ActivityCommit>,
    days: BTreeMap<NaiveDate, u64>,
}

#[derive(Default)]
struct ActorActivityCache {
    entries: HashMap<ActivityCacheKey, Arc<ActorActivityYear>>,
    order: VecDeque<ActivityCacheKey>,
}

impl ActorActivityCache {
    fn get(&self, key: &ActivityCacheKey) -> Option<Arc<ActorActivityYear>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: ActivityCacheKey, activity: Arc<ActorActivityYear>) {
        if self.entries.insert(key.clone(), activity).is_some() {
            self.order.retain(|existing| existing != &key);
        }
        self.order.push_back(key);
        while self.entries.len() > MAX_ACTIVITY_CACHE_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn remove_repository(&mut self, repository: &Path) {
        self.entries
            .retain(|key, _| key.repository.as_path() != repository);
        self.order
            .retain(|key| key.repository.as_path() != repository);
    }
}

#[derive(Default)]
pub struct ActorCatalogState {
    snapshots: Mutex<HashMap<PathBuf, Arc<ActorSnapshot>>>,
    repository_locks: Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>,
    activities: Mutex<ActorActivityCache>,
    activity_locks: Mutex<HashMap<ActivityCacheKey, Arc<AsyncMutex<()>>>>,
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
        self.snapshot_at_repository(cli, &repository).await
    }

    async fn snapshot_at_repository(
        &self,
        cli: &GitCli,
        repository: &Path,
    ) -> Result<Arc<ActorSnapshot>, AppError> {
        if let Some(snapshot) = self.cached(repository)? {
            return Ok(snapshot);
        }
        let repository_lock = self.repository_lock(repository)?;
        let _load_guard = repository_lock.lock().await;
        if let Some(snapshot) = self.cached(repository)? {
            return Ok(snapshot);
        }
        self.load_and_publish(cli, repository).await
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

    pub async fn activity(
        &self,
        cli: &GitCli,
        space_path: &Path,
        canonical_email: &str,
        selected_year: Option<i32>,
        selected_day: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<ActorActivity, AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        let snapshot = self.snapshot_at_repository(cli, &repository).await?;
        let canonical_email = normalize_email(canonical_email);
        let row = snapshot
            .rows
            .iter()
            .find(|row| row.candidate.email == canonical_email)
            .ok_or_else(|| {
                AppError::FileNotFound(format!(
                    "actor {canonical_email:?} is not present in repository catalog"
                ))
            })?;

        let today = Local::now().date_naive();
        let selected_year = selected_year.unwrap_or_else(|| {
            if row.available_years.contains(&today.year()) {
                today.year()
            } else {
                row.available_years.first().copied().unwrap_or(today.year())
            }
        });
        let (range_start, range_end_exclusive) = activity_year_range(selected_year, today)?;
        let selected_day = selected_day
            .map(|day| parse_activity_day(day, range_start, range_end_exclusive))
            .transpose()?;
        let key = ActivityCacheKey {
            repository: repository.clone(),
            generation: snapshot.generation,
            canonical_email: canonical_email.clone(),
            year: selected_year,
        };
        let cursor_offset = cursor
            .map(|cursor| {
                validate_activity_cursor(cursor, &snapshot.repository_id, &key, selected_day)
            })
            .transpose()?;

        let activity = if let Some(activity) = self.cached_activity(&key)? {
            activity
        } else {
            let activity_lock = self.activity_lock(&key)?;
            let _load_guard = activity_lock.lock().await;
            if let Some(activity) = self.cached_activity(&key)? {
                self.remove_activity_lock_if_idle(&key, &activity_lock)?;
                activity
            } else {
                let loaded = load_activity_year(
                    cli,
                    &repository,
                    &snapshot,
                    &canonical_email,
                    range_start,
                    range_end_exclusive,
                )
                .await;
                match loaded {
                    Ok(activity) => {
                        let activity = Arc::new(activity);
                        if self
                            .cached(&repository)?
                            .is_some_and(|current| current.generation == snapshot.generation)
                        {
                            self.activities
                                .lock()
                                .map_err(|_| {
                                    AppError::General("actor activity cache lock poisoned".into())
                                })?
                                .insert(key.clone(), activity.clone());
                        }
                        self.remove_activity_lock_if_idle(&key, &activity_lock)?;
                        activity
                    }
                    Err(error) => {
                        self.remove_activity_lock_if_idle(&key, &activity_lock)?;
                        return Err(error);
                    }
                }
            }
        };

        project_activity(&snapshot, row, &key, &activity, selected_day, cursor_offset)
    }

    fn cached(&self, repository: &Path) -> Result<Option<Arc<ActorSnapshot>>, AppError> {
        self.snapshots
            .lock()
            .map(|snapshots| snapshots.get(repository).cloned())
            .map_err(|_| AppError::General("actor snapshot cache lock poisoned".into()))
    }

    pub(super) fn repository_lock(
        &self,
        repository: &Path,
    ) -> Result<Arc<AsyncMutex<()>>, AppError> {
        let mut locks = self
            .repository_locks
            .lock()
            .map_err(|_| AppError::General("actor repository lock cache poisoned".into()))?;
        Ok(locks
            .entry(repository.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }

    fn cached_activity(
        &self,
        key: &ActivityCacheKey,
    ) -> Result<Option<Arc<ActorActivityYear>>, AppError> {
        self.activities
            .lock()
            .map(|activities| activities.get(key))
            .map_err(|_| AppError::General("actor activity cache lock poisoned".into()))
    }

    fn activity_lock(&self, key: &ActivityCacheKey) -> Result<Arc<AsyncMutex<()>>, AppError> {
        let mut locks = self
            .activity_locks
            .lock()
            .map_err(|_| AppError::General("actor activity lock cache poisoned".into()))?;
        Ok(locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }

    fn remove_activity_lock_if_idle(
        &self,
        key: &ActivityCacheKey,
        activity_lock: &Arc<AsyncMutex<()>>,
    ) -> Result<(), AppError> {
        let mut locks = self
            .activity_locks
            .lock()
            .map_err(|_| AppError::General("actor activity lock cache poisoned".into()))?;
        if locks.get(key).is_some_and(|cached_lock| {
            Arc::ptr_eq(cached_lock, activity_lock) && Arc::strong_count(cached_lock) == 2
        }) {
            locks.remove(key);
        }
        Ok(())
    }

    pub(super) async fn load_and_publish(
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
        self.activities
            .lock()
            .map_err(|_| AppError::General("actor activity cache lock poisoned".into()))?
            .remove_repository(repository);
        Ok(snapshot)
    }
}

fn activity_year_range(year: i32, today: NaiveDate) -> Result<(NaiveDate, NaiveDate), AppError> {
    if year > today.year() {
        return Err(AppError::General(
            "actor activity year cannot be in the future".into(),
        ));
    }
    let range_start = NaiveDate::from_ymd_opt(year, 1, 1)
        .ok_or_else(|| AppError::General("actor activity year is out of bounds".into()))?;
    let range_end_exclusive = if year == today.year() {
        today
            .checked_add_days(chrono::Days::new(1))
            .ok_or_else(|| {
                AppError::General("actor activity current-day boundary is out of bounds".into())
            })?
    } else {
        NaiveDate::from_ymd_opt(year.saturating_add(1), 1, 1)
            .ok_or_else(|| AppError::General("actor activity year is out of bounds".into()))?
    };
    Ok((range_start, range_end_exclusive))
}

fn local_date_for_timestamp(timestamp: i64) -> Option<NaiveDate> {
    timestamp_date_in_timezone(timestamp, &Local)
}

fn timestamp_date_in_timezone<Tz>(timestamp: i64, timezone: &Tz) -> Option<NaiveDate>
where
    Tz: TimeZone,
{
    timezone
        .timestamp_opt(timestamp, 0)
        .single()
        .map(|instant| instant.date_naive())
}

fn local_activity_instant(timestamp: i64) -> Option<(NaiveDate, String)> {
    Local
        .timestamp_opt(timestamp, 0)
        .single()
        .map(|instant| (instant.date_naive(), instant.format("%H:%M").to_string()))
}

async fn load_activity_year(
    cli: &GitCli,
    repository: &Path,
    snapshot: &ActorSnapshot,
    canonical_email: &str,
    range_start: NaiveDate,
    range_end_exclusive: NaiveDate,
) -> Result<ActorActivityYear, AppError> {
    let history = cli
        .exec(
            repository,
            &[
                "log",
                "--no-use-mailmap",
                "--all",
                "--format=%H%x00%an%x00%ae%x00%at%x00%s",
            ],
        )
        .await?;
    if history.exit_code != 0 && !is_unborn_repository(cli, repository).await? {
        return Err(AppError::GitCommandFailed(format!(
            "failed to scan actor activity in {}: {}",
            repository.display(),
            history.stderr.trim()
        )));
    }

    let commits = activity_commits_from_log(
        &history.stdout,
        &snapshot.mailmap,
        canonical_email,
        range_start,
        range_end_exclusive,
        local_activity_instant,
    );
    let mut days = BTreeMap::new();
    for commit in &commits {
        *days.entry(commit.local_date).or_insert(0) += 1;
    }
    Ok(ActorActivityYear {
        range_start,
        range_end_exclusive,
        commits,
        days,
    })
}

fn activity_commits_from_log(
    log: &str,
    mailmap: &MailmapDocument,
    canonical_email: &str,
    range_start: NaiveDate,
    range_end_exclusive: NaiveDate,
    mut local_instant: impl FnMut(i64) -> Option<(NaiveDate, String)>,
) -> Vec<ActivityCommit> {
    let mut seen_commits = HashSet::new();
    let mut commits = Vec::new();
    for record in log.lines() {
        let mut parts = record.splitn(5, '\0');
        let commit_id = parts.next().unwrap_or_default().trim();
        let raw_name = parts.next().unwrap_or_default().trim();
        let raw_email = parts.next().unwrap_or_default().trim();
        let timestamp = parts.next().unwrap_or_default().trim().parse::<i64>().ok();
        let subject = parts.next().unwrap_or_default();
        if commit_id.is_empty()
            || raw_email.is_empty()
            || !seen_commits.insert(commit_id.to_string())
        {
            continue;
        }
        if mailmap.resolve(raw_name, raw_email).email != canonical_email {
            continue;
        }
        let Some(authored_at) = timestamp else {
            continue;
        };
        let Some((local_date, local_time)) = local_instant(authored_at) else {
            continue;
        };
        if local_date < range_start || local_date >= range_end_exclusive {
            continue;
        }
        commits.push(ActivityCommit {
            sha: commit_id.to_string(),
            subject: subject.to_string(),
            authored_at,
            local_date,
            local_time,
        });
    }
    commits.sort_by(|left, right| {
        right
            .authored_at
            .cmp(&left.authored_at)
            .then_with(|| right.sha.cmp(&left.sha))
    });
    commits
}

#[cfg(test)]
fn activity_counts_from_log(
    log: &str,
    mailmap: &MailmapDocument,
    canonical_email: &str,
    range_start: NaiveDate,
    range_end_exclusive: NaiveDate,
    mut date_for_timestamp: impl FnMut(i64) -> Option<NaiveDate>,
) -> BTreeMap<NaiveDate, u64> {
    let commits = activity_commits_from_log(
        log,
        mailmap,
        canonical_email,
        range_start,
        range_end_exclusive,
        |timestamp| date_for_timestamp(timestamp).map(|date| (date, String::new())),
    );
    let mut counts = BTreeMap::new();
    for commit in commits {
        *counts.entry(commit.local_date).or_insert(0) += 1;
    }
    counts
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActivityCursorPosition {
    authored_at: i64,
    sha: String,
}

fn parse_activity_day(
    value: &str,
    range_start: NaiveDate,
    range_end_exclusive: NaiveDate,
) -> Result<NaiveDate, AppError> {
    let day = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::General("actor activity day must use YYYY-MM-DD".into()))?;
    if day < range_start || day >= range_end_exclusive {
        return Err(AppError::General(
            "actor activity day is outside the selected year range".into(),
        ));
    }
    Ok(day)
}

fn hash_activity_cursor_value(hash: &mut u64, value: &str) {
    for byte in value.as_bytes() {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
    *hash ^= 0xff;
    *hash = hash.wrapping_mul(0x100000001b3);
}

fn activity_cursor_signature(
    repository_id: &str,
    key: &ActivityCacheKey,
    selected_day: Option<NaiveDate>,
) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    hash_activity_cursor_value(&mut hash, repository_id);
    hash_activity_cursor_value(&mut hash, &key.canonical_email);
    hash_activity_cursor_value(&mut hash, &key.year.to_string());
    match selected_day {
        Some(day) => {
            hash_activity_cursor_value(&mut hash, "day");
            hash_activity_cursor_value(&mut hash, &day.format("%Y-%m-%d").to_string());
        }
        None => hash_activity_cursor_value(&mut hash, "year"),
    }
    hash
}

fn activity_cursor(
    repository_id: &str,
    key: &ActivityCacheKey,
    selected_day: Option<NaiveDate>,
    commit: &ActivityCommit,
) -> String {
    format!(
        "v1:{}:{}:{:016x}:{}:{}",
        key.generation,
        key.year,
        activity_cursor_signature(repository_id, key, selected_day),
        commit.authored_at,
        commit.sha
    )
}

fn validate_activity_cursor(
    cursor: &str,
    repository_id: &str,
    key: &ActivityCacheKey,
    selected_day: Option<NaiveDate>,
) -> Result<ActivityCursorPosition, AppError> {
    fn invalid_cursor() -> AppError {
        AppError::General("actor activity cursor is stale or does not match this request".into())
    }

    let mut parts = cursor.split(':');
    if parts.next() != Some("v1") {
        return Err(invalid_cursor());
    }
    let generation = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(invalid_cursor)?;
    let year = parts
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(invalid_cursor)?;
    let signature = parts
        .next()
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .ok_or_else(invalid_cursor)?;
    let authored_at = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(invalid_cursor)?;
    let sha = parts
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(invalid_cursor)?;
    if parts.next().is_some()
        || generation != key.generation
        || year != key.year
        || signature != activity_cursor_signature(repository_id, key, selected_day)
    {
        return Err(invalid_cursor());
    }
    Ok(ActivityCursorPosition {
        authored_at,
        sha: sha.to_string(),
    })
}

fn project_activity(
    snapshot: &ActorSnapshot,
    row: &ActorRow,
    key: &ActivityCacheKey,
    activity: &ActorActivityYear,
    selected_day: Option<NaiveDate>,
    cursor: Option<ActivityCursorPosition>,
) -> Result<ActorActivity, AppError> {
    let commits: Vec<_> = activity
        .commits
        .iter()
        .filter(|commit| selected_day.is_none_or(|day| commit.local_date == day))
        .collect();
    let start = if let Some(cursor) = cursor {
        commits
            .iter()
            .position(|commit| commit.authored_at == cursor.authored_at && commit.sha == cursor.sha)
            .map(|index| index + 1)
            .ok_or_else(|| {
                AppError::General(
                    "actor activity cursor is stale or does not match this request".into(),
                )
            })?
    } else {
        0
    };
    let end = start.saturating_add(ACTIVITY_PAGE_SIZE).min(commits.len());
    let page = &commits[start..end];

    let mut month_counts = HashMap::new();
    for commit in &commits {
        *month_counts
            .entry(commit.local_date.format("%Y-%m").to_string())
            .or_insert(0_u64) += 1;
    }
    let mut months: Vec<ActorActivityMonth> = Vec::new();
    for commit in page {
        let month = commit.local_date.format("%Y-%m").to_string();
        if months.last().is_none_or(|group| group.month != month) {
            months.push(ActorActivityMonth {
                commit_count: month_counts.get(&month).copied().unwrap_or_default(),
                month,
                commits: Vec::new(),
            });
        }
        months
            .last_mut()
            .expect("activity month was inserted")
            .commits
            .push(ActorActivityCommit {
                subject: commit.subject.clone(),
                authored_at: commit.authored_at,
                local_date: commit.local_date.format("%Y-%m-%d").to_string(),
                local_time: commit.local_time.clone(),
                short_sha: commit.sha.chars().take(7).collect(),
            });
    }
    let next_cursor = (end < commits.len()).then(|| {
        activity_cursor(
            &snapshot.repository_id,
            key,
            selected_day,
            page.last().expect("non-final activity page is not empty"),
        )
    });

    Ok(ActorActivity {
        repository_id: snapshot.repository_id.clone(),
        generation: snapshot.generation,
        canonical_email: key.canonical_email.clone(),
        available_years: row.available_years.clone(),
        selected_year: key.year,
        range_start: activity.range_start.format("%Y-%m-%d").to_string(),
        range_end_exclusive: activity.range_end_exclusive.format("%Y-%m-%d").to_string(),
        commit_count: activity.commits.len() as u64,
        days: activity
            .days
            .iter()
            .map(|(date, commit_count)| ActorActivityDay {
                date: date.format("%Y-%m-%d").to_string(),
                commit_count: *commit_count,
            })
            .collect(),
        timeline: ActorActivityTimeline {
            day: selected_day.map(|day| day.format("%Y-%m-%d").to_string()),
            months,
            next_cursor,
        },
    })
}

pub(super) async fn resolve_repository(
    cli: &GitCli,
    space_path: &Path,
) -> Result<PathBuf, AppError> {
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

pub(super) async fn load_snapshot(
    cli: &GitCli,
    repository: &Path,
    generation: u64,
) -> Result<ActorSnapshot, AppError> {
    let mut mailmap = read_mailmap(repository);
    detect_custom_mailmap_sources(cli, repository, &mut mailmap).await?;
    let shallow = is_shallow_repository(cli, repository).await?;

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
        repository_id: opaque_repository_id(repository),
        generation,
        rows,
        diagnostics: mailmap.diagnostics.clone(),
        mailmap,
        shallow,
    })
}

fn opaque_repository_id(repository: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in repository.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("actor-repo-{hash:016x}")
}

async fn is_shallow_repository(cli: &GitCli, repository: &Path) -> Result<bool, AppError> {
    let output = cli
        .exec(repository, &["rev-parse", "--is-shallow-repository"])
        .await?;
    if output.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to inspect shallow state for {}: {}",
            repository.display(),
            output.stderr.trim()
        )));
    }
    Ok(output.stdout.trim() == "true")
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
    available_years: HashSet<i32>,
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
            available_years: HashSet::new(),
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
                && alias.line == line
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
        if let Some(year) = timestamp
            .and_then(local_date_for_timestamp)
            .map(|date| date.year())
        {
            self.available_years.insert(year);
        }
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
        let mut available_years: Vec<_> = self.available_years.into_iter().collect();
        available_years.sort_unstable_by(|left, right| right.cmp(left));
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
            available_years,
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

    fn local_timestamp(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("unambiguous local timestamp")
            .timestamp()
    }

    fn commit_at(path: &Path, file: &str, contents: &str, message: &str, author_timestamp: i64) {
        fs::write(path.join(file), contents).expect("write commit file");
        git(path, &["add", file]);
        let output = Command::new("git")
            .args(["commit", "--quiet", "-m", message])
            .current_dir(path)
            .env("GIT_AUTHOR_DATE", format!("{author_timestamp} +0000"))
            .env("GIT_COMMITTER_DATE", format!("{author_timestamp} +0000"))
            .output()
            .expect("commit at timestamp");
        assert!(
            output.status.success(),
            "git commit failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
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
    async fn activity_defaults_to_current_then_latest_and_current_for_no_commits() {
        let today = Local::now().date_naive();
        let current_year = today.year();
        let past_year = current_year - 1;
        let cli = GitCli::detect().expect("git CLI");

        let current_repo = init_repo("Actor", "actor@example.test");
        commit_at(
            current_repo.path(),
            "past.txt",
            "past",
            "past",
            local_timestamp(past_year, 6, 10, 12, 0),
        );
        commit_at(
            current_repo.path(),
            "current.txt",
            "current",
            "current",
            local_timestamp(current_year, today.month(), today.day(), 0, 0),
        );
        let state = ActorCatalogState::new();
        let catalog = state
            .snapshot(&cli, current_repo.path())
            .await
            .expect("catalog")
            .catalog();
        assert_eq!(
            catalog.rows[0].available_years,
            vec![current_year, past_year]
        );
        let current = state
            .activity(
                &cli,
                current_repo.path(),
                "actor@example.test",
                None,
                None,
                None,
            )
            .await
            .expect("current activity");
        assert_eq!(current.selected_year, current_year);
        assert_eq!(current.commit_count, 1);

        let past_repo = init_repo("Actor", "actor@example.test");
        commit_at(
            past_repo.path(),
            "past.txt",
            "past",
            "past",
            local_timestamp(past_year, 5, 10, 12, 0),
        );
        let past = ActorCatalogState::new()
            .activity(
                &cli,
                past_repo.path(),
                "actor@example.test",
                None,
                None,
                None,
            )
            .await
            .expect("latest activity");
        assert_eq!(past.available_years, vec![past_year]);
        assert_eq!(past.selected_year, past_year);
        assert_eq!(past.commit_count, 1);

        let empty_repo = init_repo("Actor", "actor@example.test");
        let empty = ActorCatalogState::new()
            .activity(
                &cli,
                empty_repo.path(),
                "actor@example.test",
                None,
                None,
                None,
            )
            .await
            .expect("empty current-year activity");
        assert!(empty.available_years.is_empty());
        assert_eq!(empty.selected_year, current_year);
        assert_eq!(empty.commit_count, 0);
        assert!(empty.days.is_empty());
        assert!(empty.timeline.months.is_empty());
        assert!(empty.timeline.next_cursor.is_none());
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

    #[tokio::test]
    async fn rich_catalog_exposes_aliases_sources_diagnostics_and_local_activity_date() {
        let repo = init_repo("Alias Name", "alias@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        fs::write(
            repo.path().join(".mailmap"),
            "Canonical <canonical@example.test> <alias@example.test>\ninvalid mapping\n",
        )
        .expect("mailmap");

        let cli = GitCli::detect().expect("git CLI");
        let catalog = ActorCatalogState::new()
            .snapshot(&cli, repo.path())
            .await
            .expect("snapshot")
            .catalog();

        assert!(catalog.repository_id.starts_with("actor-repo-"));
        assert!(
            !catalog
                .repository_id
                .contains(repo.path().to_string_lossy().as_ref())
        );
        assert_eq!(catalog.generation, 1);
        assert!(!catalog.shallow);
        assert_eq!(catalog.rows.len(), 1);
        let row = &catalog.rows[0];
        assert_eq!(row.canonical_email, "canonical@example.test");
        assert_eq!(row.display_name, "Canonical");
        assert_eq!(row.contribution, ActorContribution::Contributor);
        assert_eq!(row.commit_count, 1);
        assert!(row.last_commit_at.is_some());
        assert!(row.last_activity_date.is_some());
        assert!(row.aliases.iter().any(|alias| {
            alias.name.is_none() && alias.email == "alias@example.test" && alias.line == Some(1)
        }));
        assert!(row.sources.iter().any(|source| {
            source.kind == ActorCatalogSourceKind::History
                && source.name == "Alias Name"
                && source.email == "alias@example.test"
        }));
        assert!(row.sources.iter().any(|source| {
            source.kind == ActorCatalogSourceKind::CurrentGitIdentity
                && source.email == "alias@example.test"
        }));
        assert!(row.sources.iter().any(|source| {
            source.kind == ActorCatalogSourceKind::Mailmap
                && source.email == "canonical@example.test"
                && source.line == Some(1)
        }));
        assert_eq!(catalog.diagnostics.len(), 1);
        assert_eq!(
            catalog.diagnostics[0].kind,
            ActorCatalogDiagnosticKind::InvalidLine
        );
        assert_eq!(catalog.diagnostics[0].line, Some(2));
        assert!(catalog.diagnostics[0].blocking);

        let serialized = serde_json::to_value(&catalog).expect("serialize catalog");
        let serialized_row = serialized["rows"][0].as_object().expect("serialized row");
        assert!(!serialized_row.contains_key("isCurrent"));
        assert!(!serialized_row.contains_key("isMe"));
    }

    #[test]
    fn activity_uses_canonical_author_identity_and_deduplicates_commits() {
        let mailmap = MailmapDocument::parse(
            "Canonical <canonical@example.test> Alias Name <alias@example.test>\n",
        );
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).expect("start");
        let end = NaiveDate::from_ymd_opt(2025, 2, 1).expect("end");
        let day_two = NaiveDate::from_ymd_opt(2025, 1, 2).expect("day two");
        let day_three = NaiveDate::from_ymd_opt(2025, 1, 3).expect("day three");
        let log = "a\0Alias Name\0alias@example.test\01\n\
                   a\0Alias Name\0alias@example.test\02\n\
                   b\0Alias Name\0ALIAS@EXAMPLE.TEST\02\n\
                   c\0Different Name\0alias@example.test\02\n\
                   d\0Canonical\0canonical@example.test\03\n";

        let counts = activity_counts_from_log(
            log,
            &mailmap,
            "canonical@example.test",
            start,
            end,
            |timestamp| match timestamp {
                1 => Some(day_two),
                2 => Some(day_three),
                3 => Some(day_three),
                _ => None,
            },
        );

        assert_eq!(counts.get(&day_two), Some(&1));
        assert_eq!(counts.get(&day_three), Some(&2));
        assert_eq!(counts.values().sum::<u64>(), 3);
    }

    #[test]
    fn calendar_year_range_and_timezone_boundaries_are_deterministic() {
        let leap_day = NaiveDate::from_ymd_opt(2024, 2, 29).expect("leap day");
        assert_eq!(
            activity_year_range(2024, leap_day).expect("range"),
            (
                NaiveDate::from_ymd_opt(2024, 1, 1).expect("range start"),
                NaiveDate::from_ymd_opt(2024, 3, 1).expect("range end")
            )
        );
        assert_eq!(
            activity_year_range(2023, leap_day).expect("range"),
            (
                NaiveDate::from_ymd_opt(2023, 1, 1).expect("range start"),
                NaiveDate::from_ymd_opt(2024, 1, 1).expect("range end")
            )
        );
        assert!(activity_year_range(2025, leap_day).is_err());

        let west = chrono::FixedOffset::west_opt(60 * 60).expect("west offset");
        let east = chrono::FixedOffset::east_opt(60 * 60).expect("east offset");
        assert_eq!(
            timestamp_date_in_timezone(0, &west),
            NaiveDate::from_ymd_opt(1969, 12, 31)
        );
        assert_eq!(
            timestamp_date_in_timezone(0, &east),
            NaiveDate::from_ymd_opt(1970, 1, 1)
        );
    }

    #[test]
    fn activity_range_is_start_inclusive_and_end_exclusive() {
        let mailmap = MailmapDocument::default();
        let start = NaiveDate::from_ymd_opt(2025, 1, 31).expect("start");
        let last_day = NaiveDate::from_ymd_opt(2026, 1, 31).expect("last day");
        let end = NaiveDate::from_ymd_opt(2026, 2, 1).expect("end");
        let log = "start\0Actor\0actor@example.test\01\n\
                   last\0Actor\0actor@example.test\02\n\
                   end\0Actor\0actor@example.test\03\n";

        let counts = activity_counts_from_log(
            log,
            &mailmap,
            "actor@example.test",
            start,
            end,
            |timestamp| match timestamp {
                1 => Some(start),
                2 => Some(last_day),
                3 => Some(end),
                _ => None,
            },
        );

        assert_eq!(counts.get(&start), Some(&1));
        assert_eq!(counts.get(&last_day), Some(&1));
        assert!(!counts.contains_key(&end));
    }

    #[tokio::test]
    async fn exact_day_uses_full_year_and_has_independent_bounded_continuation() {
        let year = Local::now().year() - 1;
        let repo = init_repo("Actor", "actor@example.test");
        for index in 0..4 {
            commit_at(
                repo.path(),
                &format!("newer-{index}.txt"),
                &index.to_string(),
                &format!("newer {index}"),
                local_timestamp(year, 1, 11, 16 - index, 0),
            );
        }
        let day_timestamp = local_timestamp(year, 1, 10, 12, 0);
        for index in 0..5 {
            commit_at(
                repo.path(),
                &format!("day-{index}.txt"),
                &index.to_string(),
                &format!("day {index}"),
                day_timestamp,
            );
        }

        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();
        let unfiltered = state
            .activity(
                &cli,
                repo.path(),
                "actor@example.test",
                Some(year),
                None,
                None,
            )
            .await
            .expect("unfiltered year");
        assert_eq!(unfiltered.commit_count, 9);
        assert_eq!(
            unfiltered.timeline.months[0].commits.len(),
            ACTIVITY_PAGE_SIZE
        );
        assert!(
            unfiltered.timeline.months[0]
                .commits
                .iter()
                .all(|commit| commit.local_date == format!("{year}-01-11"))
        );

        let selected_day = format!("{year}-01-10");
        let first = state
            .activity(
                &cli,
                repo.path(),
                "actor@example.test",
                Some(year),
                Some(&selected_day),
                None,
            )
            .await
            .expect("first day page");
        assert_eq!(first.commit_count, 9);
        assert_eq!(
            first
                .days
                .iter()
                .find(|day| day.date == selected_day)
                .map(|day| day.commit_count),
            Some(5)
        );
        assert_eq!(first.timeline.day.as_deref(), Some(selected_day.as_str()));
        assert_eq!(first.timeline.months[0].commit_count, 5);
        assert_eq!(first.timeline.months[0].commits.len(), ACTIVITY_PAGE_SIZE);
        let cursor = first
            .timeline
            .next_cursor
            .as_deref()
            .expect("day continuation");
        let first_shas: Vec<_> = first.timeline.months[0]
            .commits
            .iter()
            .map(|commit| commit.short_sha.as_str())
            .collect();
        assert!(first_shas.windows(2).all(|pair| pair[0] > pair[1]));

        let second = state
            .activity(
                &cli,
                repo.path(),
                "actor@example.test",
                Some(year),
                Some(&selected_day),
                Some(cursor),
            )
            .await
            .expect("second day page");
        assert_eq!(second.timeline.months[0].commits.len(), 1);
        assert!(second.timeline.next_cursor.is_none());
        assert!(first.timeline.months[0].commits.iter().all(|first_commit| {
            second.timeline.months[0]
                .commits
                .iter()
                .all(|second_commit| second_commit.short_sha != first_commit.short_sha)
        }));

        let cross_mode = state
            .activity(
                &cli,
                repo.path(),
                "actor@example.test",
                Some(year),
                None,
                Some(cursor),
            )
            .await
            .expect_err("day cursor must not continue the full-year timeline");
        assert!(matches!(cross_mode, AppError::General(_)));

        state.refresh(&cli, repo.path()).await.expect("refresh");
        let stale = state
            .activity(
                &cli,
                repo.path(),
                "actor@example.test",
                Some(year),
                Some(&selected_day),
                Some(cursor),
            )
            .await
            .expect_err("previous generation cursor must be rejected");
        assert!(matches!(stale, AppError::General(_)));
    }

    #[tokio::test]
    async fn catalog_and_activity_use_author_timestamp_not_committer_timestamp() {
        let repo = init_repo("Actor", "actor@example.test");
        fs::write(repo.path().join("one.txt"), "one").expect("write commit file");
        git(repo.path(), &["add", "one.txt"]);
        let author_timestamp = Local::now().timestamp();
        let output = Command::new("git")
            .args(["commit", "--quiet", "-m", "one"])
            .current_dir(repo.path())
            .env("GIT_AUTHOR_DATE", format!("{author_timestamp} +0000"))
            .env("GIT_COMMITTER_DATE", "946684800 +0000")
            .output()
            .expect("commit with distinct author and committer timestamps");
        assert!(
            output.status.success(),
            "git commit failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();
        let snapshot = state.snapshot(&cli, repo.path()).await.expect("snapshot");
        assert_eq!(
            snapshot.candidates()[0].last_commit_at,
            Some(author_timestamp)
        );

        let activity = state
            .activity(&cli, repo.path(), "actor@example.test", None, None, None)
            .await
            .expect("activity");
        assert_eq!(activity.days.len(), 1);
        assert_eq!(activity.days[0].commit_count, 1);
        assert_eq!(
            activity.days[0].date,
            local_date_for_timestamp(author_timestamp)
                .expect("local author date")
                .format("%Y-%m-%d")
                .to_string()
        );
        assert_eq!(
            activity.timeline.months[0].commits[0].authored_at,
            author_timestamp
        );
        assert_eq!(
            activity.timeline.months[0].commits[0].local_time,
            Local
                .timestamp_opt(author_timestamp, 0)
                .single()
                .expect("local author time")
                .format("%H:%M")
                .to_string()
        );
    }

    #[tokio::test]
    async fn root_and_inline_reuse_activity_until_snapshot_generation_changes() {
        let repo = init_repo("Current User", "current@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        let inline = repo.path().join("inline");
        fs::create_dir(&inline).expect("inline directory");
        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();

        let (root, child) = tokio::join!(
            state.activity(&cli, repo.path(), "CURRENT@EXAMPLE.TEST", None, None, None),
            state.activity(&cli, &inline, "current@example.test", None, None, None)
        );
        let root = root.expect("root activity");
        let child = child.expect("inline activity");
        assert_eq!(root, child);
        assert_eq!(root.generation, 1);
        assert_eq!(root.days.iter().map(|day| day.commit_count).sum::<u64>(), 1);
        assert!(
            state
                .activity_locks
                .lock()
                .expect("activity locks")
                .is_empty()
        );

        state
            .refresh(&cli, &inline)
            .await
            .expect("refresh snapshot");
        let refreshed = state
            .activity(&cli, repo.path(), "current@example.test", None, None, None)
            .await
            .expect("refreshed activity");
        assert_eq!(refreshed.generation, 2);

        let error = state
            .activity(&cli, repo.path(), "unknown@example.test", None, None, None)
            .await
            .expect_err("unknown actor must fail");
        assert!(matches!(error, AppError::FileNotFound(_)));
    }

    #[test]
    fn activity_lock_is_retained_until_joined_requests_finish() {
        let state = ActorCatalogState::new();
        let key = ActivityCacheKey {
            repository: PathBuf::from("/repo"),
            generation: 1,
            canonical_email: "actor@example.test".into(),
            year: 2025,
        };
        let first = state.activity_lock(&key).expect("first lock");
        let joined = state.activity_lock(&key).expect("joined lock");

        state
            .remove_activity_lock_if_idle(&key, &first)
            .expect("retain joined lock");
        assert_eq!(state.activity_locks.lock().expect("locks").len(), 1);

        drop(joined);
        state
            .remove_activity_lock_if_idle(&key, &first)
            .expect("remove idle lock");
        assert!(state.activity_locks.lock().expect("locks").is_empty());
    }

    #[tokio::test]
    async fn activity_is_isolated_between_repositories_with_the_same_actor() {
        let first_repo = init_repo("Shared Actor", "shared@example.test");
        commit(first_repo.path(), "one.txt", "one", "one");
        let second_repo = init_repo("Shared Actor", "shared@example.test");
        commit(second_repo.path(), "one.txt", "one", "one");
        commit(second_repo.path(), "two.txt", "two", "two");
        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();

        let (first, second) = tokio::join!(
            state.activity(
                &cli,
                first_repo.path(),
                "shared@example.test",
                None,
                None,
                None
            ),
            state.activity(
                &cli,
                second_repo.path(),
                "shared@example.test",
                None,
                None,
                None
            )
        );
        let first = first.expect("first activity");
        let second = second.expect("second activity");

        assert_ne!(first.repository_id, second.repository_id);
        assert_eq!(
            first.days.iter().map(|day| day.commit_count).sum::<u64>(),
            1
        );
        assert_eq!(
            second.days.iter().map(|day| day.commit_count).sum::<u64>(),
            2
        );
    }

    #[test]
    fn activity_cache_is_bounded() {
        let repository = PathBuf::from("/repo");
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).expect("start");
        let end = NaiveDate::from_ymd_opt(2026, 1, 1).expect("end");
        let mut cache = ActorActivityCache::default();

        for index in 0..=MAX_ACTIVITY_CACHE_ENTRIES {
            let canonical_email = format!("actor-{index}@example.test");
            let key = ActivityCacheKey {
                repository: repository.clone(),
                generation: 1,
                canonical_email,
                year: 2025,
            };
            cache.insert(
                key,
                Arc::new(ActorActivityYear {
                    range_start: start,
                    range_end_exclusive: end,
                    commits: Vec::new(),
                    days: BTreeMap::new(),
                }),
            );
        }

        assert_eq!(cache.entries.len(), MAX_ACTIVITY_CACHE_ENTRIES);
        assert!(cache.entries.keys().all(|key| {
            key.canonical_email != "actor-0@example.test"
                && key.repository == repository
                && key.generation == 1
        }));
    }

    #[tokio::test]
    async fn shallow_repository_is_reported_without_network_access() {
        let repo = init_repo("Shallow User", "shallow@example.test");
        commit(repo.path(), "one.txt", "one", "one");
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo.path())
            .output()
            .expect("resolve head");
        assert!(output.status.success());
        fs::write(repo.path().join(".git/shallow"), output.stdout).expect("mark shallow");

        let cli = GitCli::detect().expect("git CLI");
        let state = ActorCatalogState::new();
        let catalog = state
            .snapshot(&cli, repo.path())
            .await
            .expect("snapshot")
            .catalog();

        assert!(catalog.shallow);
        let activity = state
            .activity(&cli, repo.path(), "shallow@example.test", None, None, None)
            .await
            .expect("locally available shallow activity");
        assert_eq!(activity.commit_count, 1);
    }
}
