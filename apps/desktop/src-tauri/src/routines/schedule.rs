use std::str::FromStr;

use chrono::{DateTime, LocalResult, NaiveDateTime, TimeDelta, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;

use super::model::{MissedRuns, RoutineTimeBasis};

const LIVE_SLOT_TOLERANCE_SECONDS: i64 = 90;
const DST_GAP_SEARCH_MINUTES: i64 = 180;
const NOMINAL_FORMAT: &str = "%Y-%m-%dT%H:%M";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduleOccurrence {
    pub due_at: DateTime<Utc>,
    pub nominal_civil_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduleEvaluation {
    pub due: Option<ScheduleOccurrence>,
    pub had_occurrence: bool,
    pub next_at: DateTime<Utc>,
}

pub(crate) fn validate_cron(value: &str) -> Result<(), String> {
    if value.split_whitespace().count() != 5 {
        return Err("schedule cron must contain exactly five fields".into());
    }
    Cron::from_str(value)
        .map(|_| ())
        .map_err(|error| format!("invalid schedule cron: {error}"))
}

pub(crate) fn canonical_timezone(value: &str) -> Result<String, String> {
    Tz::from_str(value)
        .map(|timezone| timezone.name().to_string())
        .map_err(|_| format!("invalid IANA schedule timezone: {value}"))
}

pub(crate) fn validate_timezone(value: &str) -> Result<(), String> {
    canonical_timezone(value).map(|_| ())
}

pub(crate) fn effective_timezone(time_basis: &RoutineTimeBasis) -> Result<String, String> {
    match time_basis {
        RoutineTimeBasis::Local => iana_time_zone::get_timezone()
            .map_err(|error| format!("failed to resolve the current system IANA timezone: {error}"))
            .and_then(|timezone| canonical_timezone(&timezone)),
        RoutineTimeBasis::Fixed { timezone } => canonical_timezone(timezone),
    }
}

pub(crate) fn next_after(
    cron: &str,
    time_basis: &RoutineTimeBasis,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let (cron, timezone) = parse(cron, time_basis)?;
    next_occurrence(&cron, timezone, after).map(|occurrence| occurrence.due_at)
}

pub(crate) fn evaluate(
    cron: &str,
    time_basis: &RoutineTimeBasis,
    checkpoint: DateTime<Utc>,
    now: DateTime<Utc>,
    missed_runs: MissedRuns,
) -> Result<ScheduleEvaluation, String> {
    let (cron, timezone) = parse(cron, time_basis)?;
    let mut cursor = checkpoint;
    let mut latest_due: Option<ScheduleOccurrence> = None;

    loop {
        let occurrence = next_occurrence(&cron, timezone, cursor)?;
        if occurrence.due_at > now {
            let had_occurrence = latest_due.is_some();
            let due = match (latest_due, missed_runs) {
                (Some(due), MissedRuns::RunOnce) => Some(due),
                (Some(due), MissedRuns::Skip)
                    if now.signed_duration_since(due.due_at).num_seconds()
                        <= LIVE_SLOT_TOLERANCE_SECONDS =>
                {
                    Some(due)
                }
                _ => None,
            };
            return Ok(ScheduleEvaluation {
                due,
                had_occurrence,
                next_at: occurrence.due_at,
            });
        }
        cursor = occurrence.due_at;
        latest_due = Some(occurrence);
    }
}

fn parse(cron: &str, time_basis: &RoutineTimeBasis) -> Result<(Cron, Tz), String> {
    validate_cron(cron)?;
    let timezone = effective_timezone(time_basis)?;
    let cron = Cron::from_str(cron).map_err(|error| format!("invalid schedule cron: {error}"))?;
    let timezone = Tz::from_str(&timezone)
        .map_err(|_| format!("invalid IANA schedule timezone: {timezone}"))?;
    Ok((cron, timezone))
}

fn next_occurrence(
    cron: &Cron,
    timezone: Tz,
    after: DateTime<Utc>,
) -> Result<ScheduleOccurrence, String> {
    let mut nominal_cursor = DateTime::<Utc>::from_naive_utc_and_offset(
        after.with_timezone(&timezone).naive_local(),
        Utc,
    );
    loop {
        let nominal = cron
            .find_next_occurrence(&nominal_cursor, false)
            .map_err(|error| format!("failed to find cron occurrence: {error}"))?
            .naive_utc();
        let due_at = resolve_nominal(timezone, nominal)?;
        if due_at > after {
            return Ok(ScheduleOccurrence {
                due_at,
                nominal_civil_time: nominal.format(NOMINAL_FORMAT).to_string(),
            });
        }
        nominal_cursor = DateTime::<Utc>::from_naive_utc_and_offset(nominal, Utc);
    }
}

fn resolve_nominal(timezone: Tz, nominal: NaiveDateTime) -> Result<DateTime<Utc>, String> {
    match timezone.from_local_datetime(&nominal) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second).with_timezone(&Utc)),
        LocalResult::None => {
            for minutes in 1..=DST_GAP_SEARCH_MINUTES {
                let candidate = nominal + TimeDelta::minutes(minutes);
                match timezone.from_local_datetime(&candidate) {
                    LocalResult::Single(value) => return Ok(value.with_timezone(&Utc)),
                    LocalResult::Ambiguous(first, second) => {
                        return Ok(first.min(second).with_timezone(&Utc));
                    }
                    LocalResult::None => {}
                }
            }
            Err(format!(
                "failed to resolve nominal civil time {} in {}",
                nominal.format(NOMINAL_FORMAT),
                timezone.name()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("valid UTC fixture")
    }

    fn fixed(timezone: &str) -> RoutineTimeBasis {
        RoutineTimeBasis::Fixed {
            timezone: timezone.to_string(),
        }
    }

    #[test]
    fn five_field_cron_and_iana_timezone_are_strict() {
        assert!(validate_cron("0 9 * * 1-5").is_ok());
        assert!(validate_cron("0 0 9 * * 1-5").is_err());
        assert!(validate_timezone("Asia/Novosibirsk").is_ok());
        assert!(validate_timezone("Local").is_err());
        assert!(validate_cron("61 9 * * *").is_err());
    }

    #[test]
    fn skip_ignores_old_slots_but_runs_the_current_tick() {
        let basis = fixed("UTC");
        let missed = evaluate(
            "0 9 * * *",
            &basis,
            utc(2026, 8, 5, 8, 0),
            utc(2026, 8, 7, 12, 0),
            MissedRuns::Skip,
        )
        .expect("evaluate missed schedule");
        assert_eq!(missed.due, None);
        assert_eq!(missed.next_at, utc(2026, 8, 8, 9, 0));

        let live = evaluate(
            "0 9 * * *",
            &basis,
            utc(2026, 8, 7, 8, 59),
            utc(2026, 8, 7, 9, 1),
            MissedRuns::Skip,
        )
        .expect("evaluate live schedule");
        assert_eq!(live.due.map(|due| due.due_at), Some(utc(2026, 8, 7, 9, 0)));
    }

    #[test]
    fn run_once_selects_only_the_latest_missed_slot() {
        let evaluation = evaluate(
            "0 9 * * *",
            &fixed("UTC"),
            utc(2026, 8, 1, 0, 0),
            utc(2026, 8, 7, 12, 0),
            MissedRuns::RunOnce,
        )
        .expect("evaluate run once");
        assert_eq!(
            evaluation.due.map(|due| due.due_at),
            Some(utc(2026, 8, 7, 9, 0))
        );
        assert_eq!(evaluation.next_at, utc(2026, 8, 8, 9, 0));
    }

    #[test]
    fn spring_forward_keeps_nominal_identity_and_runs_at_first_valid_minute() {
        let evaluation = evaluate(
            "30 2 * * *",
            &fixed("America/New_York"),
            utc(2026, 3, 8, 5, 0),
            utc(2026, 3, 8, 12, 0),
            MissedRuns::RunOnce,
        )
        .expect("evaluate spring DST");
        let due = evaluation.due.expect("spring occurrence");
        assert_eq!(due.due_at, utc(2026, 3, 8, 7, 0));
        assert_eq!(due.nominal_civil_time, "2026-03-08T02:30");
        assert_eq!(evaluation.next_at, utc(2026, 3, 9, 6, 30));
    }

    #[test]
    fn fall_back_has_one_logical_occurrence_for_the_overlapping_minute() {
        let evaluation = evaluate(
            "30 1 * * *",
            &fixed("America/New_York"),
            utc(2026, 11, 1, 4, 0),
            utc(2026, 11, 1, 7, 0),
            MissedRuns::RunOnce,
        )
        .expect("fall occurrence");
        let due = evaluation.due.expect("single due occurrence");
        assert_eq!(due.due_at, utc(2026, 11, 1, 5, 30));
        assert_eq!(due.nominal_civil_time, "2026-11-01T01:30");
        assert_eq!(evaluation.next_at, utc(2026, 11, 2, 6, 30));
    }

    #[test]
    fn a_timezone_change_recomputes_the_instant_without_changing_local_source_identity() {
        let cron = Cron::from_str("0 9 * * *").expect("cron");
        let after = utc(2026, 8, 26, 0, 0);
        let novosibirsk = next_occurrence(
            &cron,
            Tz::from_str("Asia/Novosibirsk").expect("timezone"),
            after,
        )
        .expect("Novosibirsk occurrence");
        let berlin = next_occurrence(
            &cron,
            Tz::from_str("Europe/Berlin").expect("timezone"),
            after,
        )
        .expect("Berlin occurrence");

        assert_eq!(novosibirsk.nominal_civil_time, "2026-08-26T09:00");
        assert_eq!(berlin.nominal_civil_time, "2026-08-26T09:00");
        assert_ne!(novosibirsk.due_at, berlin.due_at);
        assert_eq!(RoutineTimeBasis::Local.identity(), "local");
    }
}
