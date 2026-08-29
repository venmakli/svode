import { expect, test } from "bun:test";
import {
  countHiddenKnowledgeKinds,
  createDefaultKnowledgeFilters,
  toggleKnowledgeEdgeKind,
  toggleKnowledgeNodeKind,
} from "./filters";

test("knowledge filters start with every supported kind visible", () => {
  const filters = createDefaultKnowledgeFilters();
  expect(filters.nodeKinds).toEqual([
    "page",
    "collection",
    "agent_instruction",
    "skill",
  ]);
  expect(filters.edgeKinds).toEqual([
    "links_to",
    "relation",
    "member_of",
    "references",
  ]);
  expect(countHiddenKnowledgeKinds(filters)).toBe(0);
});

test("knowledge filters toggle kinds without duplicates", () => {
  const defaults = createDefaultKnowledgeFilters();
  const withoutPages = toggleKnowledgeNodeKind(defaults, "page", false);
  const withoutMembership = toggleKnowledgeEdgeKind(
    withoutPages,
    "member_of",
    false,
  );

  expect(withoutMembership.nodeKinds.includes("page")).toBe(false);
  expect(withoutMembership.edgeKinds.includes("member_of")).toBe(false);
  expect(countHiddenKnowledgeKinds(withoutMembership)).toBe(2);
  expect(
    toggleKnowledgeNodeKind(withoutMembership, "collection", true).nodeKinds,
  ).toEqual(withoutMembership.nodeKinds);
});
