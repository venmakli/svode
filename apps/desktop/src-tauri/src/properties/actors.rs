use std::sync::Mutex;

use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorCandidate {
    pub email: String,
    pub name: String,
    pub last_commit_at: Option<i64>,
    pub commit_count: u64,
    pub is_me: bool,
}

#[derive(Default)]
pub struct ActorCatalogState {
    cache: Mutex<HashMap<ActorCatalogKey, Vec<ActorCandidate>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ActorCatalogKey {
    space_path: PathBuf,
    all_time: bool,
}

impl ActorCatalogState {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, space_path: &Path, all_time: bool) -> Option<Vec<ActorCandidate>> {
        self.cache.lock().ok().and_then(|cache| {
            cache
                .get(&ActorCatalogKey {
                    space_path: space_path.to_path_buf(),
                    all_time,
                })
                .cloned()
        })
    }

    fn set(&self, space_path: &Path, all_time: bool, actors: Vec<ActorCandidate>) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                ActorCatalogKey {
                    space_path: space_path.to_path_buf(),
                    all_time,
                },
                actors,
            );
        }
    }
}

pub(super) fn is_actor_type(ty: PropertyType) -> bool {
    matches!(ty, PropertyType::Actor)
}

pub(super) fn actor_multiple(column: &Column) -> bool {
    column.multiple.unwrap_or(false)
}

pub(super) fn canonical_actor_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn warn_if_invalid_actor_email(raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains(char::is_whitespace)
        || !trimmed.contains('@')
        || trimmed.starts_with('@')
        || trimmed.ends_with('@')
    {
        tracing::warn!("actor value {:?} is not a valid email shape", raw);
    }
}

pub(super) fn normalize_actor_value(column: &Column, value: Value) -> Result<Value, AppError> {
    if value.is_null() {
        return Ok(Value::Null);
    }

    if actor_multiple(column) {
        let raw_values: Vec<String> = match value {
            Value::Sequence(sequence) => sequence
                .into_iter()
                .map(|item| {
                    item.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        schema_error(format!("{} must contain only strings", column.name))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            other => vec![expect_string_value(&column.name, &other)?.to_string()],
        };
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        for raw in raw_values {
            warn_if_invalid_actor_email(&raw);
            let email = canonical_actor_email(&raw);
            if !email.is_empty() && seen.insert(email.clone()) {
                normalized.push(Value::String(email));
            }
        }
        return Ok(Value::Sequence(normalized));
    }

    let raw = match &value {
        Value::Sequence(sequence) => sequence
            .iter()
            .find_map(Value::as_str)
            .ok_or_else(|| schema_error(format!("{} must contain an actor email", column.name)))?,
        _ => expect_string_value(&column.name, &value)?,
    };
    warn_if_invalid_actor_email(raw);
    Ok(Value::String(canonical_actor_email(raw)))
}

pub async fn list_actors(
    cache: &ActorCatalogState,
    cli: &GitCli,
    space_path: &Path,
    all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    if let Some(actors) = cache.get(space_path, all_time) {
        return Ok(actors);
    }
    refresh_actors(cache, cli, space_path, all_time).await
}

pub async fn refresh_actors(
    cache: &ActorCatalogState,
    cli: &GitCli,
    space_path: &Path,
    all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    let actors = load_actors(cli, space_path, all_time).await?;
    cache.set(space_path, all_time, actors.clone());
    Ok(actors)
}

async fn load_actors(
    cli: &GitCli,
    space_path: &Path,
    all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    let mut args = vec!["log", "--use-mailmap", "--all", "--format=%aN|%aE|%at"];
    if !all_time {
        args.push("--since=6 months ago");
    }

    let mut actors: HashMap<String, ActorCandidate> = HashMap::new();
    let output = cli.exec(space_path, &args).await?;
    if output.exit_code == 0 {
        for line in output.stdout.lines() {
            let mut parts = line.splitn(3, '|');
            let name = parts.next().unwrap_or("").trim();
            let email = parts.next().unwrap_or("").trim();
            let ts = parts.next().unwrap_or("").trim().parse::<i64>().ok();
            if email.is_empty() {
                continue;
            }
            let canonical = canonicalize_actor(cli, space_path, name, email).await?;
            let entry = actors
                .entry(canonical.clone())
                .or_insert_with(|| ActorCandidate {
                    email: canonical,
                    name: if name.is_empty() {
                        email.to_string()
                    } else {
                        name.to_string()
                    },
                    last_commit_at: ts,
                    commit_count: 0,
                    is_me: false,
                });
            entry.commit_count += 1;
            if ts > entry.last_commit_at {
                entry.last_commit_at = ts;
                if !name.is_empty() {
                    entry.name = name.to_string();
                }
            }
        }
    }

    let me = current_git_actor(cli, space_path).await?;
    let me_email = if let Some((name, email)) = me {
        let canonical = canonicalize_actor(cli, space_path, &name, &email).await?;
        let entry = actors
            .entry(canonical.clone())
            .or_insert_with(|| ActorCandidate {
                email: canonical.clone(),
                name: if name.is_empty() {
                    canonical.clone()
                } else {
                    name
                },
                last_commit_at: None,
                commit_count: 0,
                is_me: true,
            });
        entry.is_me = true;
        Some(canonical)
    } else {
        None
    };

    let mut actors: Vec<ActorCandidate> = actors.into_values().collect();
    if let Some(me_email) = me_email {
        for actor in &mut actors {
            actor.is_me = actor.email == me_email;
        }
    }

    actors.sort_by(|a, b| {
        b.is_me
            .cmp(&a.is_me)
            .then_with(|| b.last_commit_at.cmp(&a.last_commit_at))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.email.cmp(&b.email))
    });

    Ok(actors)
}

pub(super) async fn current_git_actor(
    cli: &GitCli,
    space_path: &Path,
) -> Result<Option<(String, String)>, AppError> {
    let name = git_config_value(cli, space_path, "user.name").await?;
    let email = git_config_value(cli, space_path, "user.email").await?;
    Ok(email.map(|email| (name.unwrap_or_default(), email)))
}

async fn git_config_value(
    cli: &GitCli,
    space_path: &Path,
    key: &str,
) -> Result<Option<String>, AppError> {
    let output = cli.exec(space_path, &["config", "--get", key]).await?;
    if output.exit_code != 0 {
        return Ok(None);
    }
    let value = output.stdout.trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

pub(super) async fn canonicalize_actor(
    cli: &GitCli,
    space_path: &Path,
    name: &str,
    email: &str,
) -> Result<String, AppError> {
    let identity = if name.trim().is_empty() {
        format!("<{}>", email.trim())
    } else {
        format!("{} <{}>", name.trim(), email.trim())
    };
    let output = cli.exec(space_path, &["check-mailmap", &identity]).await?;
    if output.exit_code == 0 {
        if let Some((_, mapped_email)) = parse_identity(output.stdout.trim()) {
            return Ok(mapped_email.to_lowercase());
        }
    }
    Ok(email.trim().to_lowercase())
}

fn parse_identity(raw: &str) -> Option<(String, String)> {
    let end = raw.rfind('>')?;
    let start = raw[..end].rfind('<')?;
    let name = raw[..start].trim().to_string();
    let email = raw[start + 1..end].trim().to_string();
    (!email.is_empty()).then_some((name, email))
}
