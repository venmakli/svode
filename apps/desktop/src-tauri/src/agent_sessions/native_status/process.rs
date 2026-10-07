//! The liveness signal of a session's process (Stage 10 `07` N4): only the
//! store's record of the process on this device, checked by pid and guarded
//! against a reused pid by the process start time. There is no process scan.

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

/// The store's record of the process that holds a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessRecord {
    pub pid: u32,
    /// The host the store records with the process, when it records one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The process started by this moment: the store's time of the record
    /// plus the tolerance of the agent's reader (N7). A process with this pid
    /// started later reuses the pid of one that exited.
    pub started_by: DateTime<Utc>,
}

/// What the record tells of the process now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessSignal {
    Alive,
    /// The recorded process exited, or its pid now belongs to a later one.
    Dead,
    /// No record, a record of another host, or a process whose start time
    /// cannot be read.
    None,
}

static THIS_HOST: LazyLock<Option<String>> = LazyLock::new(System::host_name);

/// The signal of each record, in order.
pub(crate) fn process_signals(records: &[Option<&ProcessRecord>]) -> Vec<ProcessSignal> {
    let pids = records
        .iter()
        .flatten()
        .map(|record| Pid::from_u32(record.pid))
        .collect::<Vec<_>>();
    if pids.is_empty() {
        return vec![ProcessSignal::None; records.len()];
    }
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing(),
    );
    records
        .iter()
        .map(|record| {
            signal_of(*record, THIS_HOST.as_deref(), |pid| {
                system.process(Pid::from_u32(pid)).map(|process| {
                    (process.status() != ProcessStatus::Zombie).then(|| process.start_time())
                })
            })
        })
        .collect()
}

/// `start_time` gives the start in seconds since the epoch of a running
/// process, `Some(None)` for an exited one not reaped yet and `None` when no
/// process has the pid.
fn signal_of(
    record: Option<&ProcessRecord>,
    this_host: Option<&str>,
    start_time: impl Fn(u32) -> Option<Option<u64>>,
) -> ProcessSignal {
    let Some(record) = record else {
        return ProcessSignal::None;
    };
    if let Some(host) = &record.host
        && this_host.is_none_or(|this_host| !host.eq_ignore_ascii_case(this_host))
    {
        return ProcessSignal::None;
    }
    match start_time(record.pid) {
        None | Some(None) => ProcessSignal::Dead,
        // An unreadable start time cannot tell the recorded process from a
        // later one with its pid.
        Some(Some(0)) => ProcessSignal::None,
        Some(Some(started)) if started as i64 <= record.started_by.timestamp() => {
            ProcessSignal::Alive
        }
        Some(Some(_)) => ProcessSignal::Dead,
    }
}

#[cfg(test)]
mod tests {
    use std::process::{Child, Command, Stdio};

    use chrono::Duration;

    use super::*;

    fn record(pid: u32, host: Option<&str>, started_by: DateTime<Utc>) -> ProcessRecord {
        ProcessRecord {
            pid,
            host: host.map(str::to_string),
            started_by,
        }
    }

    fn sleeping_child() -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", "60", "127.0.0.1"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("60");
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a child process")
    }

    fn signal(record: &ProcessRecord) -> ProcessSignal {
        process_signals(&[Some(record)])[0]
    }

    #[test]
    fn a_live_child_process_is_alive() {
        let mut child = sleeping_child();
        let alive = signal(&record(
            child.id(),
            THIS_HOST.as_deref(),
            Utc::now() + Duration::seconds(1),
        ));
        child.kill().ok();
        child.wait().ok();
        assert_eq!(alive, ProcessSignal::Alive);
    }

    #[test]
    fn an_exited_child_process_is_dead() {
        let mut child = sleeping_child();
        let pid = child.id();
        child.kill().expect("kill the child");
        child.wait().expect("reap the child");
        assert_eq!(
            signal(&record(pid, None, Utc::now() + Duration::seconds(1))),
            ProcessSignal::Dead
        );
    }

    #[test]
    fn a_process_started_after_the_record_reuses_the_pid_of_a_dead_one() {
        let mut child = sleeping_child();
        let reused = signal(&record(
            child.id(),
            None,
            Utc::now() - Duration::minutes(10),
        ));
        child.kill().ok();
        child.wait().ok();
        assert_eq!(reused, ProcessSignal::Dead);
    }

    #[test]
    fn a_record_of_another_host_gives_no_signal() {
        let mut child = sleeping_child();
        let elsewhere = signal(&record(
            child.id(),
            Some("another-host.invalid"),
            Utc::now() + Duration::seconds(1),
        ));
        child.kill().ok();
        child.wait().ok();
        assert_eq!(elsewhere, ProcessSignal::None);
    }

    #[test]
    fn the_signal_follows_the_record_and_the_start_time() {
        let at = Utc::now();
        let started = at.timestamp() as u64;
        let running = |pid: u32| (pid == 7).then_some(Some(started));
        assert_eq!(signal_of(None, Some("here"), running), ProcessSignal::None);
        assert_eq!(
            signal_of(Some(&record(7, Some("HERE"), at)), Some("here"), running),
            ProcessSignal::Alive,
            "hosts compare without case"
        );
        assert_eq!(
            signal_of(Some(&record(7, Some("here"), at)), None, running),
            ProcessSignal::None,
            "an unknown host of this device confirms nothing"
        );
        assert_eq!(
            signal_of(Some(&record(8, None, at)), None, running),
            ProcessSignal::Dead
        );
        assert_eq!(
            signal_of(Some(&record(7, None, at)), None, |_| Some(None)),
            ProcessSignal::Dead,
            "an exited process not reaped yet"
        );
        assert_eq!(
            signal_of(Some(&record(7, None, at)), None, |_| Some(Some(0))),
            ProcessSignal::None
        );
        assert_eq!(
            signal_of(
                Some(&record(7, None, at - Duration::seconds(2))),
                None,
                running
            ),
            ProcessSignal::Dead
        );
    }
}
