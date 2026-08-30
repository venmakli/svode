import { expect, test } from "bun:test";
import {
  createPageSurfaceContributions,
  pageDefaultMode,
} from "./page-surface";

test("defaults local and writable repositories to edit without hiding view", () => {
  expect(pageDefaultMode("local")).toBe("edit");
  expect(pageDefaultMode("writable")).toBe("edit");

  const contributions = createPageSurfaceContributions({
    editLabel: "Edit",
    mode: null,
    status: "local",
    viewLabel: "View",
  });
  expect(contributions[0]?.id).toBe("edit");
  expect(contributions[0]?.availability).toBe("available");
  expect(contributions[0]?.isDefault).toBe(true);
  expect(contributions[1]?.id).toBe("view");
  expect(contributions[1]?.availability).toBe("available");
  expect(contributions[1]?.isDefault).toBe(false);
});

test("keeps edit reachable as recovery when repository access is blocked", () => {
  for (const status of ["checking", "read_only", "unknown"] as const) {
    const contributions = createPageSurfaceContributions({
      editLabel: "Edit",
      mode: null,
      status,
      viewLabel: "View",
    });
    expect(contributions[0]?.id).toBe("edit");
    expect(contributions[0]?.availability).toBe("recoverable");
    expect(contributions[0]?.isDefault).toBe(false);
    expect(contributions[1]?.id).toBe("view");
    expect(contributions[1]?.isDefault).toBe(true);
  }
});

test("session-only selection remains the single default after access invalidation", () => {
  const contributions = createPageSurfaceContributions({
    editLabel: "Edit",
    mode: "view",
    status: "writable",
    viewLabel: "View",
  });
  expect(contributions.find(({ isDefault }) => isDefault)?.id).toBe("view");
});
