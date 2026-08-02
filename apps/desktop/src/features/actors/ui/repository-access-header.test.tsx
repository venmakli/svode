import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RepositoryAccessSnapshot } from "@/features/git";
import { RepositoryAccessHeader } from "./repository-access-header";

function snapshot(
  status: RepositoryAccessSnapshot["status"],
  reason: RepositoryAccessSnapshot["reason"] = null,
): RepositoryAccessSnapshot {
  return {
    checkedAt: null,
    expiresAt: null,
    generation: 1,
    lastKnownStatus: null,
    reason,
    repositoryId: "access-repo-test",
    status,
  };
}

test("repository access header uses repo-level status without actor roles", () => {
  const writable = renderToStaticMarkup(
    <RepositoryAccessHeader
      snapshot={snapshot("writable")}
      onVerify={() => undefined}
    />,
  );
  const readOnly = renderToStaticMarkup(
    <RepositoryAccessHeader
      snapshot={snapshot("read_only")}
      onVerify={() => undefined}
    />,
  );

  expect(writable.includes("Editing")).toBe(true);
  expect(writable.includes("Write access to origin")).toBe(true);
  expect(writable.includes("Check access")).toBe(true);
  expect(writable.includes("role")).toBe(false);
  expect(readOnly.includes("Read only")).toBe(true);
  expect(readOnly.includes("rejected the access check")).toBe(true);
});

test("repository access header renders typed unknown and checking states", () => {
  const expired = renderToStaticMarkup(
    <RepositoryAccessHeader
      snapshot={snapshot("unknown", "expired")}
      onVerify={() => undefined}
    />,
  );
  const checking = renderToStaticMarkup(
    <RepositoryAccessHeader
      snapshot={snapshot("writable")}
      verifying
      onVerify={() => undefined}
    />,
  );

  expect(expired.includes("Access not checked")).toBe(true);
  expect(expired.includes("previous access check expired")).toBe(true);
  expect(checking.includes("Checking access")).toBe(true);
  expect(checking.includes('disabled=""')).toBe(true);
  expect(checking.includes("animate-spin")).toBe(true);
});
