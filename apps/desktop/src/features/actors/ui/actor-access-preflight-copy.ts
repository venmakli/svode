import type {
  RepositoryAccessReason,
  RepositoryAccessSnapshot,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

export type ActorAccessPreflightKind =
  | "error"
  | "checking"
  | "read_only"
  | "unknown";

export function actorAccessPreflightCopy({
  error,
  reason,
  status,
}: {
  error: string | null;
  reason: RepositoryAccessReason | null;
  status: RepositoryAccessSnapshot["status"];
}): {
  description: string;
  kind: ActorAccessPreflightKind;
  title: string;
} {
  if (error) {
    return {
      description: m.actors_access_preflight_error_description({ error }),
      kind: "error",
      title: m.actors_access_preflight_error_title(),
    };
  }

  if (status === "checking") {
    return {
      description: m.actors_access_description_checking(),
      kind: "checking",
      title: m.actors_access_status_checking(),
    };
  }

  if (status === "read_only") {
    return {
      description: m.actors_access_description_read_only(),
      kind: "read_only",
      title: m.actors_access_preflight_read_only_title(),
    };
  }

  return {
    description: reasonDescription(reason),
    kind: "unknown",
    title: m.actors_access_status_unknown(),
  };
}

function reasonDescription(reason: RepositoryAccessReason | null) {
  switch (reason) {
    case "auth_required":
      return m.actors_access_reason_auth_required();
    case "offline_or_timeout":
      return m.actors_access_reason_offline_or_timeout();
    case "unsupported_ref":
      return m.actors_access_reason_unsupported_ref();
    case "unsupported_remote_configuration":
      return m.actors_access_reason_unsupported_remote_configuration();
    case "ambiguous_rejection":
      return m.actors_access_reason_ambiguous_rejection();
    case "lease_conflict":
      return m.actors_access_reason_lease_conflict();
    case "expired":
      return m.actors_access_reason_expired();
    case "remote_changed":
      return m.actors_access_reason_remote_changed();
    case "not_checked":
    case null:
      return m.actors_access_reason_not_checked();
  }
}
