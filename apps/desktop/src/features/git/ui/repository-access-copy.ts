import * as m from "@/paraglide/messages.js";

import type {
  RepositoryAccessPrimaryAction,
  RepositoryAccessReason,
  RepositoryAccessSnapshot,
} from "../model/repository-access";

export interface RepositoryAccessPresentation {
  action: RepositoryAccessPrimaryAction;
  actionLabel: string | null;
  description: string;
  status: RepositoryAccessSnapshot["status"] | "loading" | "error";
  statusLabel: string;
  title: string;
}

export function repositoryAccessPresentation({
  error,
  loading,
  snapshot,
  verifying,
}: {
  error: string | null;
  loading: boolean;
  snapshot: RepositoryAccessSnapshot | null;
  verifying: boolean;
}): RepositoryAccessPresentation {
  if (verifying || snapshot?.status === "checking") {
    return {
      action: "none",
      actionLabel: m.git_access_action_checking(),
      description: m.git_access_status_checking_description(),
      status: "checking",
      statusLabel: m.git_access_status_checking_label(),
      title: m.git_access_status_checking_title(),
    };
  }
  if (error) {
    return {
      action: "verify",
      actionLabel: m.git_access_action_retry(),
      description: m.git_access_runtime_error_description({ error }),
      status: "error",
      statusLabel: m.git_access_status_error_label(),
      title: m.git_access_runtime_error_title(),
    };
  }
  if (loading || !snapshot) {
    return {
      action: "none",
      actionLabel: null,
      description: m.git_access_status_loading_description(),
      status: "loading",
      statusLabel: m.git_access_status_loading_label(),
      title: m.git_access_status_loading_title(),
    };
  }
  if (snapshot.status === "local") {
    return {
      action: "none",
      actionLabel: null,
      description: m.git_access_status_local_description(),
      status: "local",
      statusLabel: m.git_access_status_local_label(),
      title: m.git_access_status_local_title(),
    };
  }
  if (snapshot.status === "writable") {
    return {
      action: "none",
      actionLabel: null,
      description: m.git_access_status_writable_description(),
      status: "writable",
      statusLabel: m.git_access_status_writable_label(),
      title: m.git_access_status_writable_title(),
    };
  }
  if (snapshot.status === "read_only") {
    return {
      action: "authenticate",
      actionLabel: m.git_access_action_authenticate(),
      description: m.git_access_status_read_only_description(),
      status: "read_only",
      statusLabel: m.git_access_status_read_only_label(),
      title: m.git_access_status_read_only_title(),
    };
  }

  const reason = snapshot.reason ?? "not_checked";
  const reasonCopy = unknownReasonCopy(reason);
  return {
    action: reasonCopy.action,
    actionLabel: reasonCopy.actionLabel,
    description: reasonCopy.description,
    status: "unknown",
    statusLabel: m.git_access_status_unknown_label(),
    title: m.git_access_status_unknown_title(),
  };
}

function unknownReasonCopy(reason: RepositoryAccessReason): {
  action: RepositoryAccessPrimaryAction;
  actionLabel: string;
  description: string;
} {
  switch (reason) {
    case "auth_required":
      return {
        action: "authenticate",
        actionLabel: m.git_access_action_authenticate(),
        description: m.git_access_reason_auth_required(),
      };
    case "offline_or_timeout":
      return {
        action: "verify",
        actionLabel: m.git_access_action_check_again(),
        description: m.git_access_reason_offline_or_timeout(),
      };
    case "expired":
      return {
        action: "verify",
        actionLabel: m.git_access_action_check_again(),
        description: m.git_access_reason_expired(),
      };
    case "remote_changed":
      return {
        action: "verify",
        actionLabel: m.git_access_action_check_new_origin(),
        description: m.git_access_reason_remote_changed(),
      };
    case "unsupported_remote_configuration":
      return {
        action: "edit_remote",
        actionLabel: m.git_access_action_change_origin(),
        description: m.git_access_reason_unsupported_remote_configuration(),
      };
    case "unsupported_ref":
      return {
        action: "recommendations",
        actionLabel: m.git_access_action_recommendations(),
        description: m.git_access_reason_unsupported_ref(),
      };
    case "ambiguous_rejection":
      return {
        action: "verify",
        actionLabel: m.git_access_action_check_again(),
        description: m.git_access_reason_ambiguous_rejection(),
      };
    case "lease_conflict":
      return {
        action: "verify",
        actionLabel: m.git_access_action_check_again(),
        description: m.git_access_reason_lease_conflict(),
      };
    case "not_checked":
      return {
        action: "verify",
        actionLabel: m.git_access_action_check(),
        description: m.git_access_reason_not_checked(),
      };
  }
}
