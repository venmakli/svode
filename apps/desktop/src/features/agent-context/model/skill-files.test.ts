import { expect, test } from "bun:test";

import { skillFileRow } from "./skill-files";
import type { AgentContextSkillFile } from "./types";

const file = (
  kind: AgentContextSkillFile["kind"],
  path: string,
): AgentContextSkillFile => ({
  availability: "available",
  canonicalPath: `/skills/review/${path}`,
  format: kind === "directory" ? "" : (path.split(".").at(-1) ?? ""),
  kind,
  modifiedAt: "2026-10-15T08:00:00Z",
  name: path.split("/").at(-1)!,
  path,
  sizeBytes: kind === "media" ? 42 : null,
});

test("a folder becomes an expandable branch keyed by its path", () => {
  const row = skillFileRow(file("directory", "references"));

  expect(row.kind).toBe("directory");
  expect(row.sourceShape).toBe("directory");
  expect(row.ownerPath).toBe("references");
  expect(row.hasChildren).toBe(true);
  expect(row.contentPath).toBe(null);
});

test("Markdown reads as a Page and media keep their type, format and size", () => {
  const markdown = skillFileRow(file("markdown", "references/guide.md"));
  const media = skillFileRow(file("media", "assets/logo.png"));

  expect(markdown.kind).toBe("page");
  expect(markdown.ownerPath).toBe(null);
  expect(markdown.sourceShape).toBe("file");
  expect(markdown.displayName).toBe("guide.md");
  expect(media.kind).toBe("media");
  expect(media.format).toBe("png");
  expect(media.sizeBytes).toBe(42);
  expect(media.key === markdown.key).toBe(false);
});
