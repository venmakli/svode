import { expect, test } from "bun:test";
import type {
  FanoutPreviewEntry,
  RepoIdentityResult,
} from "@/features/identity";
import {
  fanoutEntryHasOverride,
  fanoutEntrySummarySource,
  identityDraftFromRepoIdentity,
  identitySummary,
} from "./git-identity";

test("identitySummary shows global effective identity without local draft values", () => {
  const result: RepoIdentityResult = {
    local: null,
    effective: { name: "venmak.li", email: "kamnevin@gmail.com" },
    source: "global",
  };

  const summary = identitySummary(result, true);
  expect(summary.source).toBe("global");
  expect(summary.hasRepoOverride).toBe(false);
  expect(summary.text).toBe("venmak.li <kamnevin@gmail.com>");
  expect(summary.initials).toBe("V");
  expect(identityDraftFromRepoIdentity(result)).toEqual({
    name: "",
    email: "",
  });
});

test("identitySummary maps repo-local overrides by project or repository scope", () => {
  const result: RepoIdentityResult = {
    local: { name: "Project Bot", email: "bot@example.test" },
    effective: { name: "Project Bot", email: "bot@example.test" },
    source: "local",
  };

  expect(identitySummary(result, true).source).toBe("project");
  expect(identitySummary(result, false).source).toBe("repository");
  expect(identityDraftFromRepoIdentity(result)).toEqual({
    name: "Project Bot",
    email: "bot@example.test",
  });
});

test("identitySummary exposes partial overrides and missing identities", () => {
  const partial: RepoIdentityResult = {
    local: null,
    localName: "Local Name",
    localEmail: null,
    effective: { name: "Local Name", email: "global@example.test" },
    source: "partial",
  };
  const missing: RepoIdentityResult = {
    local: null,
    effective: null,
    source: "missing",
  };

  expect(identitySummary(partial, false).source).toBe("partial");
  expect(identitySummary(partial, false).hasRepoOverride).toBe(true);
  expect(identityDraftFromRepoIdentity(partial)).toEqual({
    name: "Local Name",
    email: "",
  });
  const missingSummary = identitySummary(missing, false);
  expect(missingSummary.source).toBe("missing");
  expect(missingSummary.text).toBe(null);
  expect(missingSummary.initials).toBe("?");
});

test("fanout helpers label only nested repository overrides as replace targets", () => {
  const inherited: FanoutPreviewEntry = {
    spacePath: "/repo/marketing",
    spaceName: "marketing",
    currentLocal: null,
    currentEffective: { name: "Global", email: "global@example.test" },
    source: "global",
    willReplace: false,
  };
  const partial: FanoutPreviewEntry = {
    ...inherited,
    source: "partial",
    willReplace: true,
  };

  expect(fanoutEntrySummarySource(inherited)).toBe("global");
  expect(fanoutEntryHasOverride(inherited)).toBe(false);
  expect(fanoutEntrySummarySource(partial)).toBe("partial");
  expect(fanoutEntryHasOverride(partial)).toBe(true);
});
