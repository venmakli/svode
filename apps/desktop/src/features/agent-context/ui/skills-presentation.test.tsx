import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applyCollectionQuery,
  EMPTY_COLLECTION_QUERY,
  CollectionPresentationShell,
  type CollectionPresentationDescriptor,
} from "@/features/collection";

import type { ArtifactOpenTarget } from "../api/agent-context-api";
import type { AgentContextSkillRow } from "../model/types";
import {
  compareSkillsByDefault,
  createAgentContextSkillsPresentation,
  createSkillDetailContent,
} from "./skills-presentation";

const reviewSkill: AgentContextSkillRow = {
  allowedTools: null,
  aliases: [
    {
      discoveryPath: "/workspace/.agents/skills/review",
      linkKind: "direct",
      location: "space",
      resolution: "selected",
      sourceFamily: "agents",
      support: "client_native",
    },
  ],
  body: "# Review\n\n[Blocked link](https://example.com)",
  canonicalPath: "/workspace/.agents/skills/review",
  compatibility: null,
  description: "Review changes against project conventions.",
  health: "normal",
  healthReasons: [],
  id: "skill:/workspace/.agents/skills/review",
  license: null,
  manifestPath: "/workspace/.agents/skills/review/SKILL.md",
  metadata: null,
  name: "review",
  ownerPath: "/workspace",
  truncated: false,
};

function presentation(rows: readonly AgentContextSkillRow[]) {
  return createAgentContextSkillsPresentation({
    state: { phase: "ready", rows },
  });
}

function descriptor(rows: readonly AgentContextSkillRow[]) {
  return (
    presentation(rows) as unknown as {
      instance: {
        descriptor: CollectionPresentationDescriptor<AgentContextSkillRow>;
      };
    }
  ).instance.descriptor;
}

test("skills render as coverless Gallery cards with bounded Reader detail", () => {
  const runtime = presentation([reviewSkill]);
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:root"
        presentation={runtime}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes(`data-collection-row="${reviewSkill.id}"`)).toBe(true);
  expect(html.includes("Review changes against project conventions.")).toBe(
    true,
  );
  expect(html.includes("repeat(auto-fill, minmax(240px, 1fr))")).toBe(true);
  expect(html.includes("max-width")).toBe(false);
  expect(html.includes('data-size="sm"')).toBe(true);
  expect(html.includes("group/gallery-cover")).toBe(false);
  expect(html.includes(".agents")).toBe(true);
  expect(html.includes("Codex")).toBe(false);
  expect(html.includes("Project")).toBe(false);
  expect(html.includes("Personal")).toBe(false);
  expect(html.includes("Linked sources")).toBe(false);
  const skillDescriptor = descriptor([reviewSkill]);
  expect("refresh" in skillDescriptor).toBe(false);
  expect(skillDescriptor.layout.kind).toBe("gallery");
  if (skillDescriptor.layout.kind !== "gallery") {
    throw new Error("Expected the skills presentation to use Gallery");
  }
  expect(skillDescriptor.layout.cardSize).toBe("medium");
  expect(skillDescriptor.layout.density).toBe("compact");
  expect(html.includes("data-collection-refresh")).toBe(false);

  const request = createSkillDetailContent(reviewSkill);
  const detailHtml = renderToStaticMarkup(request.content);
  expect(detailHtml.includes("data-agent-context-skill-detail")).toBe(true);
  expect(detailHtml.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(detailHtml.includes('href="https://example.com"')).toBe(false);
  // The provenance chips and both disclosures are gone.
  expect(detailHtml.includes("Source and location")).toBe(false);
  expect(detailHtml.includes("Skill parameters")).toBe(false);
  expect(detailHtml.includes("aria-expanded")).toBe(false);
  // Identity is the top bar's; the header below it reads like a page header.
  expect(request.identity?.name).toBe("review");
  expect(
    renderToStaticMarkup(request.identity?.icon).includes("lucide-sparkles"),
  ).toBe(true);
  expect(request.title).toBe("review");
  expect(request.description).toBe(
    "Review changes against project conventions.",
  );
  const headerIndex = detailHtml.indexOf("data-collection-detail-header");
  const panelIndex = detailHtml.indexOf("data-collection-property-panel");
  const readerIndex = detailHtml.indexOf("data-markdown-reader");
  expect(headerIndex >= 0).toBe(true);
  expect(panelIndex > headerIndex).toBe(true);
  expect(readerIndex > panelIndex).toBe(true);
  expect(
    (detailHtml.match(/Review changes against project conventions\./g) ?? [])
      .length,
  ).toBe(1);
  // Properties of the gallery are the rows of the panel.
  expect(detailHtml.includes('data-collection-panel-property="source"')).toBe(
    true,
  );
  expect(detailHtml.includes('data-collection-panel-property="location"')).toBe(
    true,
  );
  expect(detailHtml.includes('data-collection-panel-property="health"')).toBe(
    true,
  );
  expect(detailHtml.includes(".agents")).toBe(true);
  expect(detailHtml.includes(">Space<")).toBe(true);
  // Without optional frontmatter there is no fact group.
  expect(detailHtml.includes("data-collection-panel-fact-group")).toBe(false);
});

test("skill Detail shows SKILL.md frontmatter as facts after the properties", () => {
  const withFrontmatter: AgentContextSkillRow = {
    ...reviewSkill,
    allowedTools: "Read Bash(git log:*)",
    compatibility: "Requires git",
    license: null,
    metadata: { zeta: "last", alpha: "first" },
  };
  const detailHtml = renderToStaticMarkup(
    createSkillDetailContent(withFrontmatter).content,
  );
  const healthIndex = detailHtml.indexOf(
    'data-collection-panel-property="health"',
  );
  const groupIndex = detailHtml.indexOf(
    'data-collection-panel-fact-group="skill-md"',
  );
  expect(groupIndex > healthIndex).toBe(true);
  expect(detailHtml.includes(">From SKILL.md<")).toBe(true);
  expect(detailHtml.includes('data-collection-panel-fact="license"')).toBe(
    false,
  );
  expect(detailHtml.includes("Requires git")).toBe(true);
  expect(detailHtml.includes(">Read<")).toBe(true);
  expect(detailHtml.includes(">Bash(git log:*)<")).toBe(true);
  expect(
    detailHtml.indexOf('data-collection-panel-fact="metadata:alpha"') <
      detailHtml.indexOf('data-collection-panel-fact="metadata:zeta"'),
  ).toBe(true);
  expect(detailHtml.indexOf("data-markdown-reader") > groupIndex).toBe(true);
});

test("search and multivalue Source/Location filters use factual alias unions", () => {
  const multiSourceGlobal: AgentContextSkillRow = {
    ...reviewSkill,
    aliases: [
      reviewSkill.aliases[0]!,
      {
        ...reviewSkill.aliases[0]!,
        discoveryPath: "/home/user/.claude/skills/release",
        location: "global",
        sourceFamily: "claude",
      },
    ],
    canonicalPath: "/home/user/.claude/skills/release",
    description: "Prepare a verified release snapshot.",
    id: "skill:/home/user/.claude/skills/release",
    manifestPath: "/home/user/.claude/skills/release/SKILL.md",
    name: "release",
  };
  const rows = [reviewSkill, multiSourceGlobal];
  const queryDescriptor = descriptor(rows);
  expect(
    queryDescriptor.properties.map(({ key, label }) => ({ key, label })),
  ).toEqual([
    { key: "source", label: "Source" },
    { key: "location", label: "Location" },
    { key: "health", label: "Status" },
  ]);

  expect(
    applyCollectionQuery({
      descriptor: queryDescriptor,
      query: { filters: [], search: "verified release", sort: [] },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);
  expect(
    applyCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ propertyKey: "source", operator: "=", value: "agents" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id, reviewSkill.id]);
  expect(
    applyCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ propertyKey: "source", operator: "=", value: "claude" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);
  expect(
    applyCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ propertyKey: "location", operator: "=", value: "space" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id, reviewSkill.id]);
  expect(
    applyCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ propertyKey: "location", operator: "=", value: "global" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);

  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:filters"
        presentation={presentation(rows)}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );
  expect(html.includes(".agents")).toBe(true);
  expect(html.includes(".claude")).toBe(true);
  expect(html.includes("Global")).toBe(true);
  expect(html.includes(">Space<")).toBe(false);
});

test("default order keeps same-name canonical sources and invalid query resets", () => {
  const sameName = {
    ...reviewSkill,
    canonicalPath: "/home/user/.agents/skills/review",
    id: "skill:/home/user/.agents/skills/review",
    manifestPath: "/home/user/.agents/skills/review/SKILL.md",
  };
  const later = {
    ...reviewSkill,
    canonicalPath: "/workspace/.agents/skills/write",
    id: "skill:/workspace/.agents/skills/write",
    manifestPath: "/workspace/.agents/skills/write/SKILL.md",
    name: "write",
  };
  const rows = [later, reviewSkill, sameName];
  const queryDescriptor = descriptor(rows);
  const result = applyCollectionQuery({
    descriptor: queryDescriptor,
    query: {
      filters: [{ propertyKey: "client", operator: "=", value: "codex" }],
      search: "",
      sort: [],
    },
    rows,
  });

  expect([...rows].sort(compareSkillsByDefault).map((row) => row.id)).toEqual([
    sameName.id,
    reviewSkill.id,
    later.id,
  ]);
  expect(result.reset).toBe(true);
  expect(result.query.filters).toEqual([]);
  expect(result.rows.map((row) => row.id)).toEqual([
    sameName.id,
    reviewSkill.id,
    later.id,
  ]);
});

test("safe aliases stay neutral while degraded manifest health warns", () => {
  const warning: AgentContextSkillRow = {
    ...reviewSkill,
    aliases: [
      {
        ...reviewSkill.aliases[0]!,
        linkKind: "symbolic_link",
        resolution: "superseded",
      },
    ],
    health: "degraded",
    healthReasons: ["Name does not match its directory"],
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:warning"
        presentation={presentation([warning])}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Symbolic link")).toBe(true);
  expect(html.includes("Superseded")).toBe(false);
  expect(html.includes("Claude link support is not proven")).toBe(false);
  expect(html.includes("Name does not match its directory")).toBe(true);

  const degradedDetail = renderToStaticMarkup(
    createSkillDetailContent(warning).content,
  );
  expect(degradedDetail.includes("data-agent-context-content-health")).toBe(
    false,
  );
  expect(degradedDetail.includes("data-agent-context-health")).toBe(true);
  expect(degradedDetail.includes("Has problems")).toBe(true);
  expect(degradedDetail.includes("Name does not match its directory")).toBe(
    true,
  );
  const normalDetail = renderToStaticMarkup(
    createSkillDetailContent(reviewSkill).content,
  );
  expect(normalDetail.includes("Has problems")).toBe(false);

  const truncatedDetail = renderToStaticMarkup(
    createSkillDetailContent({ ...warning, truncated: true }).content,
  );
  expect(truncatedDetail.includes("data-agent-context-content-health")).toBe(
    true,
  );
  expect(
    truncatedDetail.includes(
      "Preview is bounded and was truncated by the scanner.",
    ),
  ).toBe(true);
});

test("skills open their manifest from the detail top bar, not from collection menus", () => {
  const presentation = createAgentContextSkillsPresentation({
    state: { phase: "ready", rows: [reviewSkill] },
  });
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:skill-menus"
        presentation={presentation}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );
  const descriptor = (
    presentation as unknown as {
      instance: { descriptor: { rowActions?: readonly unknown[] } };
    }
  ).instance.descriptor;

  expect(descriptor.rowActions).toBe(undefined);
  expect(html.includes("Row actions")).toBe(false);
  expect(html.includes("data-collection-action")).toBe(false);

  const request = createSkillDetailContent(reviewSkill);
  // The identity is the top bar's; the page-like header follows it.
  expect(request.identity?.name).toBe(reviewSkill.name);
  expect(request.headerActions).toBe(undefined);
  expect((request.openWith as ReactElement<ArtifactOpenTarget>).props).toEqual({
    canonicalArtifactPath: "/workspace/.agents/skills/review/SKILL.md",
    ownerRoot: "/workspace",
  });
});

test("skill Open with uses the canonical owner instead of the discovery alias owner", () => {
  const linkedPersonalSkill: AgentContextSkillRow = {
    ...reviewSkill,
    aliases: [
      {
        ...reviewSkill.aliases[0]!,
        discoveryPath: "/workspace/.agents/skills/personal-link",
        linkKind: "symbolic_link",
        location: "space",
      },
    ],
    canonicalPath: "/home/user/.agents/skills/personal",
    id: "skill:/home/user/.agents/skills/personal",
    manifestPath: "/home/user/.agents/skills/personal/SKILL.md",
    ownerPath: "/home/user/.agents/skills",
  };

  expect(
    (
      createSkillDetailContent(linkedPersonalSkill)
        .openWith as ReactElement<ArtifactOpenTarget>
    ).props,
  ).toEqual({
    canonicalArtifactPath: "/home/user/.agents/skills/personal/SKILL.md",
    ownerRoot: "/home/user/.agents/skills",
  });
});
