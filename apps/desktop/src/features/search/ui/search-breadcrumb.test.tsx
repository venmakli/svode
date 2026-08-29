import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeNode } from "@/features/knowledge";
import {
  buildSearchBreadcrumbModel,
  SearchBreadcrumb,
} from "./search-breadcrumb";

const spaces = [
  { id: null, name: "Project" },
  { id: "docs", name: "Docs" },
];

test("projects neutral scope without creating browsing state", () => {
  const model = buildSearchBreadcrumbModel(
    null,
    { kind: "space", spaceId: "docs" },
    spaces,
  );

  expect(model.segments.map((segment) => segment.label)).toEqual([
    "Docs",
    "Graph",
  ]);
  expect(model.accessibleLabel).toBe("Docs / Graph");
});

test("collapses the visible middle while preserving the full canonical path", () => {
  const node: KnowledgeNode = {
    id: "node-1",
    source: {
      kind: "page",
      path: "guides/product/search/design.md",
      spaceId: "docs",
    },
    spaceName: "Docs",
    title: "Search design",
    canonicalSourcePath: "guides/product/search/design.md",
    contentHash: "hash",
    sourceUpdatedAt: "2026-08-21T00:00:00Z",
    checkedAt: "2026-08-21T00:00:00Z",
    provenance: {},
  };
  const model = buildSearchBreadcrumbModel(node, { kind: "project" }, spaces);
  const html = renderToStaticMarkup(
    <SearchBreadcrumb
      node={node}
      scope={{ kind: "project" }}
      spaces={spaces}
    />,
  );

  expect(model.segments.map((segment) => segment.label)).toEqual([
    "Docs",
    null,
    "design.md",
  ]);
  expect(model.accessibleLabel).toBe(
    "Docs / guides / product / search / design.md",
  );
  expect(html.includes('data-search-breadcrumb="true"')).toBe(true);
  expect(
    html.includes('aria-label="Docs / guides / product / search / design.md"'),
  ).toBe(true);
  expect(html.includes("design.md")).toBe(true);
  expect(html.includes(">product<")).toBe(false);
});
