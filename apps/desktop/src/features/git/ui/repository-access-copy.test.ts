import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type {
  RepositoryAccessReason,
  RepositoryAccessSnapshot,
} from "../model/repository-access";
import { repositoryAccessPresentation } from "./repository-access-copy";

test("all unknown reasons project one localized next action", async () => {
  const originalLocale = getLocale();
  try {
    for (const locale of ["en", "ru"] as const) {
      await setLocale(locale, { reload: false });
      for (const reason of reasons) {
        const presentation = repositoryAccessPresentation({
          error: null,
          loading: false,
          snapshot: snapshot(reason),
          verifying: false,
        });
        expect(presentation.action === "none").toBe(false);
        expect((presentation.actionLabel?.length ?? 0) > 2).toBe(true);
        expect(presentation.description.length > 10).toBe(true);
        expect(/unknown|read_only|writable/i.test(presentation.title)).toBe(
          false,
        );
      }
    }
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("local state is normal and has no verification action", () => {
  const presentation = repositoryAccessPresentation({
    error: null,
    loading: false,
    snapshot: { ...snapshot(null), status: "local" },
    verifying: false,
  });
  expect(presentation.action).toBe("none");
  expect(presentation.status).toBe("local");
});

test("normal, checking, read-only, and runtime failure states keep one action", () => {
  const cases: Array<{
    expected: ReturnType<typeof repositoryAccessPresentation>["action"];
    input: Parameters<typeof repositoryAccessPresentation>[0];
  }> = [
    {
      expected: "none",
      input: { error: null, loading: true, snapshot: null, verifying: false },
    },
    {
      expected: "none",
      input: {
        error: null,
        loading: false,
        snapshot: { ...snapshot(null), status: "writable" as const },
        verifying: false,
      },
    },
    {
      expected: "none",
      input: {
        error: null,
        loading: false,
        snapshot: { ...snapshot(null), status: "checking" as const },
        verifying: true,
      },
    },
    {
      expected: "authenticate",
      input: {
        error: null,
        loading: false,
        snapshot: { ...snapshot(null), status: "read_only" as const },
        verifying: false,
      },
    },
    {
      expected: "verify",
      input: {
        error: "git executable unavailable",
        loading: false,
        snapshot: null,
        verifying: false,
      },
    },
  ];

  for (const { expected, input } of cases) {
    expect(repositoryAccessPresentation(input).action).toBe(expected);
  }
});

const reasons: RepositoryAccessReason[] = [
  "not_checked",
  "auth_required",
  "offline_or_timeout",
  "unsupported_ref",
  "unsupported_remote_configuration",
  "ambiguous_rejection",
  "lease_conflict",
  "expired",
  "remote_changed",
];

function snapshot(
  reason: RepositoryAccessReason | null,
): RepositoryAccessSnapshot {
  return {
    checkedAt: null,
    expiresAt: null,
    generation: 1,
    lastKnownStatus: null,
    reason,
    repositoryId: "repo-test",
    status: "unknown",
  };
}
