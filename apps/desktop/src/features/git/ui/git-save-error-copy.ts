import * as m from "@/paraglide/messages.js";
import type { GitSaveError } from "../api/git-save-error";

export function gitSaveErrorDescription(error: GitSaveError): string {
  if (error.branchMessage) return error.branchMessage;
  const cause = error.cause;
  if (!cause) return m.git_save_cause_unknown();
  const stage = {
    prepare: m.git_save_stage_prepare,
    verify: m.git_save_stage_verify,
    commit: m.git_save_stage_commit,
  }[cause.stage]();
  const reason = {
    command_failed: () => "",
    command_unavailable: m.git_save_cause_command_unavailable,
    inventory_failed: m.git_save_cause_inventory_failed,
    invalid_path: m.git_save_cause_invalid_path,
    local_file_excluded: m.git_save_cause_local_file_excluded,
    target_unavailable: m.git_save_cause_target_unavailable,
    paths_not_prepared: m.git_save_cause_paths_not_prepared,
    verification_failed: m.git_save_cause_verification_failed,
    target_cleanup_failed: m.git_save_cause_target_cleanup_failed,
  }[cause.reason]();
  return [
    stage,
    reason,
    cause.pathCount > 0
      ? m.git_save_cause_count({ count: String(cause.pathCount) })
      : "",
    cause.pathSample,
    cause.exitCode !== null
      ? m.git_save_cause_exit_code({ code: String(cause.exitCode) })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
