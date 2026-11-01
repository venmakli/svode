use super::*;

fn repo() -> &'static Path {
    Path::new("/projects/team")
}

fn secs(value: u64) -> Duration {
    Duration::from_secs(value)
}

fn mins(value: u64) -> Duration {
    Duration::from_secs(value * 60)
}

/// The timer the step arms.
fn wake(step: Step) -> Wake {
    match step {
        Step::Arm(wake) => wake,
        other => panic!("expected a timer, got {other:?}"),
    }
}

/// Runs the timer `wake` at its moment.
fn fire(rhythm: &mut Rhythm, wake: Wake, visible: bool) -> Step {
    rhythm.fire(repo(), wake.generation, visible, true, wake.at)
}

const SYNC: Step = Step::Run(Work::Sync);
const NO_INCOMING: Outcome = Outcome::Checked { incoming: false };

#[test]
fn opening_focus_and_start_check_incoming_at_once() {
    let start = Instant::now();
    for trigger in [Trigger::Opened, Trigger::Focused] {
        let mut rhythm = Rhythm::default();
        assert_eq!(rhythm.trigger(repo(), trigger, true, start), SYNC);
    }
}

#[test]
fn a_commit_publishes_also_after_a_manual_commit_with_content_commits_off() {
    // The rhythm does not know the commit toggles: a manual commit is the
    // same action as an automatic version.
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    let publish = wake(rhythm.trigger(repo(), Trigger::Committed, true, start));
    assert_eq!(publish.at, start + COALESCE);
    // Hidden windows still publish.
    assert_eq!(fire(&mut rhythm, publish, false), SYNC);
}

#[test]
fn without_sync_actions_do_not_sync_and_focus_fetches_for_the_counters() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Committed, false, start),
        Step::Nothing
    );
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Opened, false, start),
        Step::Nothing
    );
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Focused, false, start),
        Step::Run(Work::Fetch)
    );
    // The fetch is background network too.
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Focused, false, start + secs(10)),
        Step::Nothing
    );
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Focused, false, start + MIN_GAP),
        Step::Run(Work::Fetch)
    );
}

#[test]
fn the_safety_check_runs_only_while_a_window_is_visible() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
    let idle = wake(rhythm.finished(repo(), Outcome::Checked { incoming: true }, start + secs(1)));
    assert_eq!(idle.at, start + IDLE_FIRST);

    // The window was minimized meanwhile: no check and no next timer.
    assert_eq!(fire(&mut rhythm, idle, false), Step::Nothing);

    // Focus brings the check back, and with it the timer.
    let focus = start + mins(20);
    assert_eq!(rhythm.trigger(repo(), Trigger::Focused, true, focus), SYNC);
    let idle = wake(rhythm.finished(repo(), Outcome::Checked { incoming: true }, focus));
    assert_eq!(fire(&mut rhythm, idle, true), SYNC);
}

#[test]
fn the_interval_grows_to_15_minutes_and_incoming_and_explicit_sync_reset_it() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
    let quiet_checks = |rhythm: &mut Rhythm, mut checked: Instant, count: usize| {
        let mut intervals = Vec::new();
        let mut idle = None;
        for _ in 0..count {
            let next = wake(rhythm.finished(repo(), NO_INCOMING, checked));
            intervals.push(next.at - checked);
            assert_eq!(fire(rhythm, next, true), SYNC);
            checked = next.at;
            idle = Some(next);
        }
        (intervals, idle.unwrap())
    };
    let (intervals, last) = quiet_checks(&mut rhythm, start, 5);
    assert_eq!(intervals, [mins(5), mins(10), mins(15), mins(15), mins(15)]);

    // Incoming brings back 5 minutes.
    let idle = wake(rhythm.finished(repo(), Outcome::Checked { incoming: true }, last.at));
    assert_eq!(idle.at - last.at, IDLE_FIRST);
    assert_eq!(fire(&mut rhythm, idle, true), SYNC);
    let (intervals, last) = quiet_checks(&mut rhythm, idle.at, 2);
    assert_eq!(intervals, [mins(5), mins(10)]);

    // So does an explicit sync after quiet checks.
    let quiet = wake(rhythm.finished(repo(), NO_INCOMING, last.at));
    assert_eq!(quiet.at - last.at, mins(15));
    let explicit = last.at + mins(1);
    let idle = wake(rhythm.explicit(repo(), true, explicit));
    assert_eq!(idle.at, explicit + IDLE_FIRST);
    assert_eq!(fire(&mut rhythm, quiet, true), Step::Nothing, "replaced");
}

#[test]
fn background_network_is_at_most_once_per_30_seconds_and_explicit_sync_is_not_held() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
    rhythm.finished(repo(), NO_INCOMING, start + secs(2));

    // Switching back and forth between Spaces does not check again.
    assert!(matches!(
        rhythm.trigger(repo(), Trigger::Opened, true, start + secs(5)),
        Step::Nothing | Step::Arm(_)
    ));
    assert!(!matches!(
        rhythm.trigger(repo(), Trigger::Focused, true, start + secs(10)),
        Step::Run(_)
    ));
    // A commit waits for the end of the gap instead of being dropped.
    let publish = wake(rhythm.trigger(repo(), Trigger::Committed, true, start + secs(12)));
    assert_eq!(publish.at, start + MIN_GAP);
    assert_eq!(fire(&mut rhythm, publish, true), SYNC);
    rhythm.finished(repo(), NO_INCOMING, start + MIN_GAP + secs(1));

    // The explicit sync runs outside the rhythm: right after a background
    // one it only starts the rhythm over.
    assert!(!matches!(
        rhythm.explicit(repo(), true, start + MIN_GAP + secs(2)),
        Step::Run(_)
    ));
    assert!(!matches!(
        rhythm.trigger(repo(), Trigger::Opened, true, start + MIN_GAP + secs(3)),
        Step::Run(_)
    ));
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Opened, true, start + MIN_GAP * 2 + secs(2)),
        SYNC
    );
}

#[test]
fn commits_in_a_row_go_out_as_one_push() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    let first = wake(rhythm.trigger(repo(), Trigger::Committed, true, start));
    // Later commits keep the planned push.
    for delay in [secs(1), secs(2)] {
        assert_eq!(
            rhythm.trigger(repo(), Trigger::Committed, true, start + delay),
            Step::Nothing
        );
    }
    assert_eq!(fire(&mut rhythm, first, true), SYNC);

    // Commits during the push wait for one more push after it.
    for delay in [secs(3), secs(4)] {
        assert_eq!(
            rhythm.trigger(repo(), Trigger::Committed, true, start + delay),
            Step::Nothing
        );
    }
    let next = wake(rhythm.finished(repo(), NO_INCOMING, start + secs(5)));
    assert_eq!(next.at, first.at + MIN_GAP);
    assert_eq!(fire(&mut rhythm, next, true), SYNC);
    // Nothing else waits: the following timer is the safety check.
    let idle = wake(rhythm.finished(repo(), NO_INCOMING, next.at + secs(1)));
    assert!(idle.at >= next.at + IDLE_FIRST);
}

#[test]
fn a_network_error_is_retried_after_a_growing_pause() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
    let mut now = start;
    let mut pauses = Vec::new();
    for _ in 0..7 {
        let retry = wake(rhythm.finished(repo(), Outcome::NetworkError, now));
        pauses.push(retry.at - now);
        // The retry runs in a hidden window too.
        assert_eq!(fire(&mut rhythm, retry, false), SYNC);
        now = retry.at;
    }
    assert_eq!(
        pauses,
        [
            secs(30),
            mins(1),
            mins(2),
            mins(4),
            mins(8),
            mins(15),
            mins(15)
        ]
    );
}

#[test]
fn success_explicit_sync_and_focus_reset_the_pause() {
    let start = Instant::now();
    let reset = |reset: &dyn Fn(&mut Rhythm, Instant)| {
        let mut rhythm = Rhythm::default();
        assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
        let mut now = start;
        for _ in 0..3 {
            let retry = wake(rhythm.finished(repo(), Outcome::NetworkError, now));
            fire(&mut rhythm, retry, true);
            now = retry.at;
        }
        reset(&mut rhythm, now);
        // The next error starts from the first pause again.
        let later = now + mins(30);
        rhythm.trigger(repo(), Trigger::Opened, true, later);
        let retry = wake(rhythm.finished(repo(), Outcome::NetworkError, later));
        assert_eq!(retry.at - later, RETRY_FIRST);
    };
    reset(&|rhythm, now| {
        rhythm.finished(repo(), NO_INCOMING, now);
    });
    reset(&|rhythm, now| {
        rhythm.finished(repo(), Outcome::NetworkError, now);
        rhythm.explicit(repo(), true, now + secs(1));
    });
    reset(&|rhythm, now| {
        rhythm.finished(repo(), Outcome::NetworkError, now);
        // Focus inside the pause checks at once.
        assert_eq!(
            rhythm.trigger(repo(), Trigger::Focused, true, now + MIN_GAP),
            SYNC
        );
        rhythm.finished(repo(), NO_INCOMING, now + MIN_GAP + secs(1));
    });
}

#[test]
fn turning_sync_off_drops_the_planned_work() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    let publish = wake(rhythm.trigger(repo(), Trigger::Committed, true, start));
    assert_eq!(
        rhythm.fire(repo(), publish.generation, true, false, publish.at),
        Step::Nothing
    );
}

const INTEGRATE: Step = Step::Run(Work::Integrate);

#[test]
fn the_counters_and_a_background_sync_share_one_check_in_either_order() {
    // DF-285: the counters first, then opening the Space.
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert!(rhythm.counters(repo(), start));
    // The sync integrates what the counters fetched, without a check.
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Opened, true, start + secs(1)),
        INTEGRATE
    );
    assert!(!rhythm.counters(repo(), start + secs(2)));
    assert!(!matches!(
        rhythm.trigger(repo(), Trigger::Focused, true, start + secs(3)),
        Step::Run(_)
    ));
    rhythm.finished(repo(), NO_INCOMING, start + secs(4));
    // What the counters observed is integrated: the gap holds the next one.
    assert!(!matches!(
        rhythm.trigger(repo(), Trigger::Opened, true, start + secs(5)),
        Step::Run(_)
    ));

    // Opening the Space first, then the counters.
    let mut rhythm = Rhythm::default();
    assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
    assert!(!rhythm.counters(repo(), start + secs(1)), "the sync checks");
    rhythm.finished(repo(), NO_INCOMING, start + secs(2));
    assert!(!rhythm.counters(repo(), start + secs(10)));
    assert!(rhythm.counters(repo(), start + MIN_GAP));
}

#[test]
fn the_counters_reach_the_remote_again_after_the_gap_and_explicit_sync_is_not_held() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert!(rhythm.counters(repo(), start));
    assert!(!rhythm.counters(repo(), start + secs(29)));

    // The explicit sync runs regardless and moves the gap; it also
    // integrates what the counters fetched.
    rhythm.explicit(repo(), true, start + secs(10));
    assert!(!matches!(
        rhythm.trigger(repo(), Trigger::Opened, true, start + secs(11)),
        Step::Run(_)
    ));
    assert!(!rhythm.counters(repo(), start + MIN_GAP));
    assert!(rhythm.counters(repo(), start + secs(10) + MIN_GAP));
    // After the gap a sync checks the remote itself.
    assert_eq!(
        rhythm.trigger(
            repo(),
            Trigger::Opened,
            true,
            start + secs(10) + MIN_GAP * 2
        ),
        SYNC
    );
}

#[test]
fn without_sync_the_counters_and_focus_share_the_gap() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert!(rhythm.counters(repo(), start));
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Focused, false, start + secs(5)),
        Step::Nothing
    );
    assert_eq!(
        rhythm.trigger(repo(), Trigger::Focused, false, start + MIN_GAP),
        Step::Run(Work::Fetch)
    );
    assert!(!rhythm.counters(repo(), start + MIN_GAP + secs(1)));
}

#[test]
fn the_counters_wait_out_the_pause_after_a_network_error() {
    let start = Instant::now();
    let mut rhythm = Rhythm::default();
    assert_eq!(rhythm.trigger(repo(), Trigger::Opened, true, start), SYNC);
    rhythm.finished(repo(), Outcome::NetworkError, start + secs(1));
    assert!(!rhythm.counters(repo(), start + MIN_GAP));
    assert!(rhythm.counters(repo(), start + secs(1) + RETRY_FIRST));
}
