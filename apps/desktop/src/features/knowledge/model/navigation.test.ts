import { expect, test } from "bun:test";
import { knowledgeOpenPath } from "./navigation";
import type { KnowledgeNode, KnowledgeSearchItem } from "./types";

test("knowledge navigation opens a collection's public README source", () => {
  const collection = node("collection", ".", {
    readmePath: "README.md",
    schemaPath: "schema.yaml",
  });
  expect(knowledgeOpenPath(collection)).toBe("README.md");
});

test("knowledge navigation uses the fragment location for search results", () => {
  const result: KnowledgeSearchItem = {
    nodeId: "skill:root:.agents/skills/review/SKILL.md",
    source: {
      kind: "skill",
      spaceId: null,
      path: ".agents/skills/review/SKILL.md",
    },
    spaceName: "Root",
    title: "Review",
    snippet: "Review code",
    locationPath: ".agents/skills/review/SKILL.md",
    lineStart: 1,
    lineEnd: 5,
  };
  expect(knowledgeOpenPath(result)).toBe(".agents/skills/review/SKILL.md");
});

function node(
  kind: KnowledgeNode["source"]["kind"],
  path: string,
  provenance: Record<string, unknown>,
): KnowledgeNode {
  return {
    id: `${kind}:root:${path}`,
    source: { kind, spaceId: null, path },
    spaceName: "Root",
    title: path,
    contentHash: "hash",
    sourceUpdatedAt: "2026-08-09T00:00:00Z",
    checkedAt: "2026-08-09T00:00:00Z",
    canonicalSourcePath: path,
    provenance,
  };
}
