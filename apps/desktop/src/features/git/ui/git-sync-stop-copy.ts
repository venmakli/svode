import * as m from "@/paraglide/messages.js";
import type { GitSyncStop } from "../model";

export function gitSyncStopTitle(stop: GitSyncStop): string {
  if (stop.kind !== "operation") return m.git_sync_stop_conflict_title();
  // Git names its operations; only the sequencer has no command of its own.
  const operation = {
    rebase: "rebase",
    cherry_pick: "cherry-pick",
    revert: "revert",
    sequencer: m.git_sync_stop_operation_sequencer(),
  }[stop.operation];
  return m.git_sync_stop_operation_title({ operation });
}
