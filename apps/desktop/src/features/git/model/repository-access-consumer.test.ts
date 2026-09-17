import { expect, test } from "bun:test";

import {
  repositoryAccessIsEditable,
  allowsRepositoryMutation,
  blockingRepositoryAccessTargets,
} from "./repository-access-consumer";
import type { RepositoryAccessView } from "./repository-access-owner";

test("repository work mode is editable only for settled positive snapshots", () => {
  expect(repositoryAccessIsEditable(view("local"))).toBe(true);
  expect(repositoryAccessIsEditable(view("writable"))).toBe(true);

  for (const status of ["checking", "read_only", "unknown"] as const) {
    expect(repositoryAccessIsEditable(view(status))).toBe(false);
  }
  expect(
    repositoryAccessIsEditable({ ...view("writable"), verifying: true }),
  ).toBe(false);
  expect(
    repositoryAccessIsEditable({
      ...view("writable"),
      error: "snapshot load failed",
    }),
  ).toBe(false);
  expect(
    repositoryAccessIsEditable({ ...view("writable"), loading: true }),
  ).toBe(false);
  expect(
    repositoryAccessIsEditable({ ...view("unknown"), snapshot: null }),
  ).toBe(false);
});

test("contextual preflight never authorizes historical writable while checking or failed", () => {
  for (const access of [
    { ...view("writable"), verifying: true },
    { ...view("writable"), loading: true },
    { ...view("writable"), error: "read failed" },
  ]) {
    expect(allowsRepositoryMutation(access)).toBe(false);
    expect(
      blockingRepositoryAccessTargets([
        {
          access,
          target: {
            displayName: "Target",
            displayPath: "/repo",
            repositoryPath: "/repo",
          },
        },
      ]).length,
    ).toBe(1);
  }
});

function view(
  status: NonNullable<RepositoryAccessView["snapshot"]>["status"],
): RepositoryAccessView {
  return {
    error: null,
    loading: false,
    snapshot: {
      checkedAt: null,
      expiresAt: null,
      generation: 1,
      lastKnownStatus: null,
      reason: status === "unknown" ? "not_checked" : null,
      repositoryId: "repo-work-mode",
      status,
    },
    spacePath: "/repo",
    verifying: false,
  };
}
