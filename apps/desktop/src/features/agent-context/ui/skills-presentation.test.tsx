import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applyCollectionCoreQuery,
  EMPTY_COLLECTION_CORE_QUERY,
  CollectionCorePresentationShell,
  type CollectionCorePresentationDescriptor,
} from "@/features/collection/core";

import { skillDetailProvenance } from "../model/detail-provenance";
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
        descriptor: CollectionCorePresentationDescriptor<AgentContextSkillRow>;
      };
    }
  ).instance.descriptor;
}

test("skills render as coverless Gallery cards with bounded Reader detail", () => {
  const runtime = presentation([reviewSkill]);
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionCorePresentationShell
        instanceKey="agent-context:space:root"
        presentation={runtime}
        query={EMPTY_COLLECTION_CORE_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes(`data-collection-core-row="${reviewSkill.id}"`)).toBe(
    true,
  );
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
  expect(html.includes("data-collection-core-refresh")).toBe(false);

  const request = createSkillDetailContent(reviewSkill);
  const detailHtml = renderToStaticMarkup(request.content);
  const detailTitleHtml = renderToStaticMarkup(request.title);
  const detailDescriptionHtml = renderToStaticMarkup(request.description);
  expect(detailHtml.includes("data-agent-context-skill-detail")).toBe(true);
  expect(detailHtml.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(detailHtml.includes('href="https://example.com"')).toBe(false);
  expect(detailHtml.includes("Source and location")).toBe(true);
  expect(detailHtml.includes('aria-expanded="false"')).toBe(true);
  expect(detailHtml.includes("Canonical source")).toBe(false);
  expect(detailHtml.includes("Discovery sources")).toBe(false);
  expect(detailHtml.includes(".agents")).toBe(true);
  expect(detailHtml.includes("Space")).toBe(true);
  expect(detailHtml.includes("Sources: 1")).toBe(true);
  expect(detailHtml.includes("Direct")).toBe(false);
  expect(detailTitleHtml.includes("lucide-sparkles")).toBe(true);
  expect(detailTitleHtml.includes(">review<")).toBe(true);
  expect(
    (
      detailTitleHtml.match(/Review changes against project conventions\./g) ??
      []
    ).length,
  ).toBe(1);
  expect(detailTitleHtml.includes(">Skill<")).toBe(false);
  expect(detailDescriptionHtml.includes("sr-only")).toBe(true);
  expect(detailDescriptionHtml.includes("Read-only skill source")).toBe(true);
  expect(
    (detailHtml.match(/Review changes against project conventions\./g) ?? [])
      .length,
  ).toBe(0);
});

test("skill Detail keeps source and optional parameters collapsed before the Reader", () => {
  const withFrontmatter: AgentContextSkillRow = {
    ...reviewSkill,
    allowedTools: "Read",
    compatibility: "Requires git",
    license: "MIT",
    metadata: { author: "Svode" },
  };
  const request = createSkillDetailContent(withFrontmatter);
  const detailHtml = renderToStaticMarkup(request.content);
  const sourceIndex = detailHtml.indexOf(
    "data-agent-context-source-disclosure",
  );
  const parametersIndex = detailHtml.indexOf(
    "data-agent-context-skill-frontmatter",
  );
  const readerIndex = detailHtml.indexOf("data-markdown-reader");

  expect(sourceIndex >= 0).toBe(true);
  expect(parametersIndex > sourceIndex).toBe(true);
  expect(readerIndex > parametersIndex).toBe(true);
  expect((detailHtml.match(/aria-expanded="false"/g) ?? []).length).toBe(2);
  expect(detailHtml.includes("Requires git")).toBe(false);
  expect(detailHtml.includes("# Review")).toBe(false);
  expect(detailHtml.includes(">Review<")).toBe(true);
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
  ]);

  expect(
    applyCollectionCoreQuery({
      descriptor: queryDescriptor,
      query: { filters: [], search: "verified release", sort: [] },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);
  expect(
    applyCollectionCoreQuery({
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
    applyCollectionCoreQuery({
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
    applyCollectionCoreQuery({
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
    applyCollectionCoreQuery({
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
      <CollectionCorePresentationShell
        instanceKey="agent-context:space:filters"
        presentation={presentation(rows)}
        query={EMPTY_COLLECTION_CORE_QUERY}
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
  const result = applyCollectionCoreQuery({
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
      <CollectionCorePresentationShell
        instanceKey="agent-context:space:warning"
        presentation={presentation([warning])}
        query={EMPTY_COLLECTION_CORE_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Symbolic link")).toBe(true);
  expect(html.includes("Superseded")).toBe(false);
  expect(html.includes("Claude link support is not proven")).toBe(false);
  expect(html.includes("Name does not match its directory")).toBe(true);

  const provenanceOnlyDetail = renderToStaticMarkup(
    createSkillDetailContent(warning).content,
  );
  expect(
    provenanceOnlyDetail.includes("data-agent-context-content-health"),
  ).toBe(false);
  expect(
    provenanceOnlyDetail.includes("Name does not match its directory"),
  ).toBe(false);

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

test("Detail projection keeps discovery location independent from canonical ownership", () => {
  const spaceAliasToGlobal: AgentContextSkillRow = {
    ...reviewSkill,
    aliases: [
      {
        ...reviewSkill.aliases[0]!,
        discoveryPath: "/workspace/.agents/skills/global-link",
        linkKind: "symbolic_link",
        location: "space",
      },
    ],
    canonicalPath: "/home/user/.agents/skills/global-source",
    id: "skill:/home/user/.agents/skills/global-source",
    manifestPath: "/home/user/.agents/skills/global-source/SKILL.md",
    ownerPath: "/home/user/.agents/skills",
  };
  const globalAliasToSpace: AgentContextSkillRow = {
    ...reviewSkill,
    aliases: [
      {
        ...reviewSkill.aliases[0]!,
        discoveryPath: "/home/user/.claude/skills/space-link",
        linkKind: "directory_alias",
        location: "global",
        sourceFamily: "claude",
      },
    ],
  };

  const spaceAliasDetail = skillDetailProvenance(spaceAliasToGlobal);
  expect(spaceAliasDetail.canonicalOwnerPath).toBe("/home/user/.agents/skills");
  expect(spaceAliasDetail.sources[0]?.linkKind).toBe("symbolic_link");
  expect(spaceAliasDetail.sources[0]?.location).toBe("space");
  expect(spaceAliasDetail.sources[0]?.path).toBe(
    "/workspace/.agents/skills/global-link",
  );

  const globalAliasDetail = skillDetailProvenance(globalAliasToSpace);
  expect(globalAliasDetail.canonicalOwnerPath).toBe("/workspace");
  expect(globalAliasDetail.sources[0]?.linkKind).toBe("directory_alias");
  expect(globalAliasDetail.sources[0]?.location).toBe("global");
  expect(globalAliasDetail.sources[0]?.path).toBe(
    "/home/user/.claude/skills/space-link",
  );
});

test("skill external action opens its canonical manifest in the owning root", async () => {
  const opened: unknown[] = [];
  const runtime = createAgentContextSkillsPresentation({
    artifactOpeners: [
      {
        capabilities: ["reveal_file"],
        id: "file_manager",
        kind: "file_manager",
        label: "Finder",
      },
    ],
    onOpenArtifact: (input) => {
      opened.push(input);
    },
    state: { phase: "ready", rows: [reviewSkill] },
  }) as unknown as {
    instance: {
      descriptor: {
        rowActions: Array<{ id: string; run(row: AgentContextSkillRow): void }>;
      };
    };
  };

  const action = runtime.instance.descriptor.rowActions[0]!;
  await action.run(reviewSkill);
  expect(action.id).toBe("open-in-file_manager");
  expect(opened).toEqual([
    {
      canonicalArtifactPath: "/workspace/.agents/skills/review/SKILL.md",
      ownerRoot: "/workspace",
      tool: "file_manager",
    },
  ]);
});

test("skill external action uses canonical owner instead of discovery alias owner", async () => {
  const opened: unknown[] = [];
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
  const runtime = createAgentContextSkillsPresentation({
    artifactOpeners: [
      {
        capabilities: ["reveal_file"],
        id: "file_manager",
        kind: "file_manager",
        label: "Finder",
      },
    ],
    onOpenArtifact: (input) => {
      opened.push(input);
    },
    state: { phase: "ready", rows: [linkedPersonalSkill] },
  }) as unknown as {
    instance: {
      descriptor: {
        rowActions: Array<{ run(row: AgentContextSkillRow): void }>;
      };
    };
  };

  await runtime.instance.descriptor.rowActions[0]!.run(linkedPersonalSkill);
  expect(opened).toEqual([
    {
      canonicalArtifactPath: "/home/user/.agents/skills/personal/SKILL.md",
      ownerRoot: "/home/user/.agents/skills",
      tool: "file_manager",
    },
  ]);
});
