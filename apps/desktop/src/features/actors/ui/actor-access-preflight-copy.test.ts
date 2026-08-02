import { expect, test } from "bun:test";

import { actorAccessPreflightCopy } from "./actor-access-preflight-copy";

test("access preflight preserves typed unknown, read-only, checking, and failure copy", () => {
  const authRequired = actorAccessPreflightCopy({
    error: null,
    reason: "auth_required",
    status: "unknown",
  });
  expect(authRequired.kind).toBe("unknown");
  expect(
    authRequired.description.includes("Git authentication is required"),
  ).toBe(true);
  expect(
    actorAccessPreflightCopy({
      error: null,
      reason: "expired",
      status: "unknown",
    }).description.includes("previous access check expired"),
  ).toBe(true);
  const readOnly = actorAccessPreflightCopy({
    error: null,
    reason: null,
    status: "read_only",
  });
  expect(readOnly.kind).toBe("read_only");
  expect(readOnly.description.includes("rejected the access check")).toBe(true);
  expect(
    actorAccessPreflightCopy({
      error: null,
      reason: null,
      status: "checking",
    }).kind,
  ).toBe("checking");
  const error = actorAccessPreflightCopy({
    error: "credential helper failed",
    reason: null,
    status: "unknown",
  });
  expect(error.kind).toBe("error");
  expect(error.description.includes("credential helper failed")).toBe(true);
});
