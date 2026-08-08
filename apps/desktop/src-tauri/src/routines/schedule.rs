use std::str::FromStr;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use croner::Cron;

use super::model::MissedRuns;

const LIVE_SLOT_TOLERANCE_SECONDS: i64 = 90;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduleEvaluation {
    pub due_at: Option<DateTime<Utc>>,
    pub had_occurrence: bool,
    pub next_at: DateTime<Utc>,
}

#[cfg(test)]
fn validate(cron: &str, timezone: &str) -> Result<(), String> {
    parse(cron, timezone).map(|_| ())
}

pub(crate) fn validate_cron(value: &str) -> Result<(), String> {
    if value.split_whitespace().count() != 5 {
        return Err("schedule cron must contain exactly five fields".into());
    }
    Cron::from_str(value)
        .map(|_| ())
        .map_err(|error| format!("invalid schedule cron: {error}"))
}

pub(crate) fn validate_timezone(value: &str) -> Result<(), String> {
    Tz::from_str(value)
        .map(|_| ())
        .map_err(|_| format!("invalid IANA schedule timezone: {value}"))
}

pub(crate) fn next_after(
    cron: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let (cron, timezone) = parse(cron, timezone)?;
    cron.find_next_occurrence(&after.with_timezone(&timezone), false)
        .map(|instant| instant.with_timezone(&Utc))
        .map_err(|error| format!("failed to find next cron occurrence: {error}"))
}

pub(crate) fn evaluate(
    cron: &str,
    timezone: &str,
    checkpoint: DateTime<Utc>,
    now: DateTime<Utc>,
    missed_runs: MissedRuns,
) -> Result<ScheduleEvaluation, String> {
    let (cron, timezone) = parse(cron, timezone)?;
    let mut cursor = checkpoint.with_timezone(&timezone);
    let mut latest_due = None;

    loop {
        let occurrence = cron
            .find_next_occurrence(&cursor, false)
            .map_err(|error| format!("failed to find cron occurrence: {error}"))?;
        let occurrence_utc = occurrence.with_timezone(&Utc);
        if occurrence_utc > now {
            let had_occurrence = latest_due.is_some();
            let due_at = match (latest_due, missed_runs) {
                (Some(due), MissedRuns::RunOnce) => Some(due),
                (Some(due), MissedRuns::Skip)
                    if now.signed_duration_since(due).num_seconds()
                        <= LIVE_SLOT_TOLERANCE_SECONDS =>
                {
                    Some(due)
                }
                _ => None,
            };
            return Ok(ScheduleEvaluation {
                due_at,
                had_occurrence,
                next_at: occurrence_utc,
            });
        }
        latest_due = Some(occurrence_utc);
        cursor = occurrence;
    }
}

fn parse(cron: &str, timezone: &str) -> Result<(Cron, Tz), String> {
    validate_cron(cron)?;
    validate_timezone(timezone)?;
    let cron = Cron::from_str(cron).map_err(|error| format!("invalid schedule cron: {error}"))?;
    let timezone = Tz::from_str(timezone)
        .map_err(|_| format!("invalid IANA schedule timezone: {timezone}"))?;
    Ok((cron, timezone))
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

    #[test]
    fn five_field_cron_and_iana_timezone_are_strict() {
        assert!(validate("0 9 * * 1-5", "Asia/Novosibirsk").is_ok());
        assert!(validate("0 0 9 * * 1-5", "Asia/Novosibirsk").is_err());
        assert!(validate("0 9 * * 1-5", "Local").is_err());
        assert!(validate("61 9 * * *", "UTC").is_err());
    }

    #[test]
    fn skip_ignores_old_slots_but_runs_the_current_tick() {
        let missed = evaluate(
            "0 9 * * *",
            "UTC",
            utc(2026, 8, 5, 8, 0),
            utc(2026, 8, 7, 12, 0),
            MissedRuns::Skip,
        )
        .expect("evaluate missed schedule");
        assert_eq!(missed.due_at, None);
        assert_eq!(missed.next_at, utc(2026, 8, 8, 9, 0));

        let live = evaluate(
            "0 9 * * *",
            "UTC",
            utc(2026, 8, 7, 8, 59),
            utc(2026, 8, 7, 9, 1),
            MissedRuns::Skip,
        )
        .expect("evaluate live schedule");
        assert_eq!(live.due_at, Some(utc(2026, 8, 7, 9, 0)));
    }

    #[test]
    fn run_once_selects_only_the_latest_missed_slot() {
        let evaluation = evaluate(
            "0 9 * * *",
            "UTC",
            utc(2026, 8, 1, 0, 0),
            utc(2026, 8, 7, 12, 0),
            MissedRuns::RunOnce,
        )
        .expect("evaluate run once");
        assert_eq!(evaluation.due_at, Some(utc(2026, 8, 7, 9, 0)));
        assert_eq!(evaluation.next_at, utc(2026, 8, 8, 9, 0));
    }

    #[test]
    fn spring_forward_runs_fixed_time_at_the_first_valid_minute() {
        let evaluation = evaluate(
            "30 2 * * *",
            "America/New_York",
            utc(2026, 3, 8, 5, 0),
            utc(2026, 3, 8, 12, 0),
            MissedRuns::RunOnce,
        )
        .expect("evaluate spring DST");
        assert_eq!(evaluation.due_at, Some(utc(2026, 3, 8, 7, 0)));
        assert_eq!(evaluation.next_at, utc(2026, 3, 9, 6, 30));
    }

    #[test]
    fn fall_back_uses_distinct_utc_instants_without_batching() {
        let first = next_after("30 1 * * *", "America/New_York", utc(2026, 11, 1, 4, 0))
            .expect("first fall occurrence");
        let second =
            next_after("30 1 * * *", "America/New_York", first).expect("second fall occurrence");
        assert_eq!(first, utc(2026, 11, 1, 5, 30));
        assert!(second > first);
    }
}
