import { expect, test } from "bun:test";
import type { ActorCandidate } from "../model/types";
import {
  actorCandidateKey,
  resolveActorCandidate,
  resolveActorCandidates,
} from "./utils";

const canonical: ActorCandidate = {
  email: "new@example.test",
  name: "Canonical",
  aliasEmails: ["old@example.test"],
};

test("actor resolution maps stored aliases without duplicate candidates", () => {
  expect(resolveActorCandidate(" OLD@EXAMPLE.TEST ", [canonical])).toBe(
    canonical,
  );
  expect(
    resolveActorCandidates(
      ["old@example.test", "new@example.test"],
      [canonical],
    ),
  ).toEqual([canonical]);
});

test("actor resolution prefers an exact row over another row alias", () => {
  const exact: ActorCandidate = {
    email: "old@example.test",
    name: "Exact",
  };
  expect(resolveActorCandidate("old@example.test", [canonical, exact])).toBe(
    exact,
  );
});

test("actor resolution leaves an ambiguous email-only alias unresolved", () => {
  const other: ActorCandidate = {
    email: "other@example.test",
    name: "Other",
    aliasEmails: ["old@example.test"],
  };
  const resolved = resolveActorCandidate("old@example.test", [
    canonical,
    other,
  ]);

  expect({ key: actorCandidateKey(resolved), name: resolved.name }).toEqual({
    key: "old@example.test",
    name: "old@example.test",
  });
});

test("actor resolution keeps an unknown email as a local fallback", () => {
  const unknown = resolveActorCandidate("unknown@example.test", [canonical]);
  expect({ key: actorCandidateKey(unknown), name: unknown.name }).toEqual({
    key: "unknown@example.test",
    name: "unknown@example.test",
  });
});
