import type { AppSession } from "./types";

// A process App that Variables keep from starting: missing or unreadable.
export function isBlockedByVariables(session: AppSession) {
  return (
    session.status === "unavailable" &&
    session.runtimeType === "process" &&
    (session.reason === "missing_app_variables" ||
      session.reason === "unreadable_app_variables")
  );
}
