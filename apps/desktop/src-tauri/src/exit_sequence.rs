//! The order and deadline of the Desktop exit (DF-365 R3). The main thread
//! never waits for the tokio runtime here: the waiting steps run on their own
//! thread, and the main thread waits for them only up to a deadline kept by
//! the std clock, which runs while every tokio worker is blocked.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How long the main thread waits for the waiting steps of the exit.
pub(crate) const WAIT_DEADLINE: Duration = Duration::from_secs(20);

/// A step of the exit that may wait for tokio, processes or locks tasks hold.
pub(crate) struct WaitingStep {
    name: &'static str,
    run: Box<dyn FnOnce() + Send>,
}

impl WaitingStep {
    pub(crate) fn new(name: &'static str, run: impl FnOnce() + Send + 'static) -> Self {
        Self {
            name,
            run: Box::new(run),
        }
    }
}

/// Runs the exit: `signal` first, before any wait; then the waiting steps in
/// their order, for at most `deadline`; then always `force_stop`, whether the
/// steps finished or not. Returns the steps that did not finish, which the
/// log file names too. A step left running goes on until the process exits.
pub(crate) fn run(
    signal: impl FnOnce(),
    steps: Vec<WaitingStep>,
    deadline: Duration,
    force_stop: impl FnOnce(),
) -> Vec<&'static str> {
    signal();
    let unfinished = wait_for(steps, deadline);
    if !unfinished.is_empty() {
        tracing::warn!(
            ?unfinished,
            "desktop exit went on after its deadline; these steps did not finish"
        );
    }
    force_stop();
    unfinished
}

fn wait_for(steps: Vec<WaitingStep>, deadline: Duration) -> Vec<&'static str> {
    let deadline = Instant::now() + deadline;
    let names: Vec<_> = steps.iter().map(|step| step.name).collect();
    let (finished_tx, finished_rx) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("desktop-exit".into())
        .spawn(move || {
            for step in steps {
                (step.run)();
                if finished_tx.send(()).is_err() {
                    return;
                }
            }
        });
    if let Err(error) = spawned {
        tracing::error!("desktop exit steps did not start: {error}");
        return names;
    }
    let mut finished = 0;
    while finished < names.len() {
        // A timeout ends the wait, and so does a step that panicked.
        match finished_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(()) => finished += 1,
            Err(_) => break,
        }
    }
    names[finished..].to_vec()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier, Mutex};

    use super::*;

    type Events = Arc<Mutex<Vec<&'static str>>>;

    fn note(events: &Events, event: &'static str) {
        events.lock().unwrap().push(event);
    }

    /// A step that waits for a short tokio timer, as the exit's own timeouts
    /// and process reaping do.
    fn timer_step(
        name: &'static str,
        runtime: &tokio::runtime::Runtime,
        events: &Events,
    ) -> WaitingStep {
        let handle = runtime.handle().clone();
        let events = events.clone();
        WaitingStep::new(name, move || {
            note(&events, name);
            handle.block_on(async { tokio::time::sleep(Duration::from_millis(20)).await });
            note(&events, "timer fired");
        })
    }

    /// Runs the sequence on its own thread and gives up on it, instead of
    /// hanging, when it does not return in `bound`.
    fn run_bounded(
        steps: Vec<WaitingStep>,
        deadline: Duration,
        events: &Events,
        bound: Duration,
    ) -> Option<(Vec<&'static str>, Duration)> {
        let (done_tx, done_rx) = mpsc::channel();
        let (signal_events, force_events) = (events.clone(), events.clone());
        thread::spawn(move || {
            let started = Instant::now();
            let unfinished = run(
                move || note(&signal_events, "signal"),
                steps,
                deadline,
                move || note(&force_events, "force stop"),
            );
            let _ = done_tx.send((unfinished, started.elapsed()));
        });
        done_rx.recv_timeout(bound).ok()
    }

    const RETURNS: &str = "the exit sequence returns instead of hanging";

    #[test]
    fn the_exit_ends_by_its_deadline_while_every_worker_waits_for_the_main_thread() {
        const WORKERS: usize = 2;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(WORKERS)
            .enable_all()
            .build()
            .unwrap();
        // Each worker stands on a std barrier, as in the reply to an IPC call.
        let blocked = Arc::new(Barrier::new(WORKERS + 1));
        let released = Arc::new(Barrier::new(WORKERS + 1));
        for _ in 0..WORKERS {
            let (blocked, released) = (blocked.clone(), released.clone());
            runtime.spawn(async move {
                blocked.wait();
                released.wait();
            });
        }
        blocked.wait();
        let events = Events::default();
        let steps = vec![
            timer_step("agent sessions", &runtime, &events),
            timer_step("automatic versions", &runtime, &events),
        ];

        let returned = run_bounded(
            steps,
            Duration::from_millis(300),
            &events,
            Duration::from_secs(10),
        );
        let by_return = events.lock().unwrap().clone();
        // Freed before any assertion, so that a failure does not hang the
        // runtime's drop on the blocked workers.
        released.wait();

        let (unfinished, elapsed) = returned.expect(RETURNS);
        assert_eq!(unfinished, ["agent sessions", "automatic versions"]);
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert_eq!(by_return, ["signal", "agent sessions", "force stop"]);
        // The step was waiting for its timer, which fires once a worker is free.
        let fired_by = Instant::now() + Duration::from_secs(5);
        while !events.lock().unwrap().contains(&"timer fired") {
            assert!(Instant::now() < fired_by, "the step waited for its timer");
            thread::sleep(Duration::from_millis(10));
        }
        runtime.shutdown_timeout(Duration::from_secs(5));
    }

    #[test]
    fn with_free_workers_the_steps_run_in_order_before_the_forced_stop() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let events = Events::default();
        let steps = vec![
            timer_step("agent sessions", &runtime, &events),
            timer_step("terminals", &runtime, &events),
            timer_step("project MCP sessions", &runtime, &events),
        ];

        let (unfinished, _) =
            run_bounded(steps, WAIT_DEADLINE, &events, Duration::from_secs(10)).expect(RETURNS);

        assert!(unfinished.is_empty(), "{unfinished:?}");
        assert_eq!(
            *events.lock().unwrap(),
            [
                "signal",
                "agent sessions",
                "timer fired",
                "terminals",
                "timer fired",
                "project MCP sessions",
                "timer fired",
                "force stop",
            ]
        );
    }

    #[test]
    fn a_step_that_panics_ends_the_wait_and_the_forced_stop_still_runs() {
        let events = Events::default();
        let steps = vec![
            WaitingStep::new("routine outcomes", || panic!("outcome store failed")),
            WaitingStep::new("terminals", || {}),
        ];

        let (unfinished, _) =
            run_bounded(steps, WAIT_DEADLINE, &events, Duration::from_secs(10)).expect(RETURNS);

        assert_eq!(unfinished, ["routine outcomes", "terminals"]);
        assert_eq!(*events.lock().unwrap(), ["signal", "force stop"]);
    }
}
