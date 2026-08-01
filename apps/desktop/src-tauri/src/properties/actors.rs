use super::*;
pub use crate::actors::{ActorCandidate, ActorCatalogState};

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
    _all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    Ok(cache.snapshot(cli, space_path).await?.candidates())
}

pub async fn refresh_actors(
    cache: &ActorCatalogState,
    cli: &GitCli,
    space_path: &Path,
    _all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    Ok(cache.refresh(cli, space_path).await?.candidates())
}
