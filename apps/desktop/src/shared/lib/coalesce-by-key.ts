/**
 * Run `task` for one key at a time. A call while the task of its key runs
 * shares one follow-up run that starts after it ends, so it always observes
 * a run started after the call; any number of such calls start one run.
 */
export function coalesceByKey<Key, Result>(
  task: (key: Key) => Promise<Result>,
): (key: Key) => Promise<Result> {
  const running = new Map<Key, Promise<Result>>();
  const following = new Map<Key, Promise<Result>>();
  const start = (key: Key) => {
    const run = task(key);
    running.set(key, run);
    const finish = () => {
      if (running.get(key) === run) running.delete(key);
    };
    run.then(finish, finish);
    return run;
  };
  return (key) => {
    const next = following.get(key);
    if (next) return next;
    const current = running.get(key);
    if (!current) return start(key);
    const follow = current
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        following.delete(key);
        return start(key);
      });
    following.set(key, follow);
    return follow;
  };
}
