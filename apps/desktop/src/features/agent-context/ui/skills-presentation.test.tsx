import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applySystemCollectionQuery,
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationShell,
  type SystemCollectionPresentationDescriptor,
} from "@/features/collection/system";

import type { AgentContextSkillRow } from "../model/types";
import {
  compareSkillsByDefault,
  createAgentContextSkillsPresentation,
} from "./skills-presentation";

const reviewSkill: AgentContextSkillRow = {
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
  name: "review",
  ownerPath: "/workspace",
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
        descriptor: SystemCollectionPresentationDescriptor<AgentContextSkillRow>;
      };
    }
  ).instance.descriptor;
}

test("skills render as coverless Gallery cards with bounded Reader detail", () => {
  const runtime = presentation([reviewSkill]);
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationShell
        instanceKey="agent-context:space:root"
        presentation={runtime}
        query={EMPTY_SYSTEM_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes(`data-system-collection-row="${reviewSkill.id}"`)).toBe(
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
  expect(html.includes("data-system-collection-refresh")).toBe(false);

  const request = skillDescriptor.createDetailRequest?.(reviewSkill);
  const detailHtml = renderToStaticMarkup(request?.content);
  expect(detailHtml.includes("data-agent-context-skill-detail")).toBe(true);
  expect(detailHtml.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(detailHtml.includes('href="https://example.com"')).toBe(false);
  expect(detailHtml.includes("Canonical source")).toBe(true);
  expect(detailHtml.includes("Discovery sources")).toBe(true);
  expect(detailHtml.includes(".agents")).toBe(true);
  expect(detailHtml.includes("Space")).toBe(true);
  expect(detailHtml.includes("Direct")).toBe(true);
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
    queryDescriptor.fields.map(({ key, label }) => ({ key, label })),
  ).toEqual([
    { key: "source", label: "Source" },
    { key: "location", label: "Location" },
  ]);

  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: { filters: [], search: "verified release", sort: [] },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);
  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ fieldKey: "source", operator: "=", value: "agents" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id, reviewSkill.id]);
  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ fieldKey: "source", operator: "=", value: "claude" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);
  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ fieldKey: "location", operator: "=", value: "space" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id, reviewSkill.id]);
  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ fieldKey: "location", operator: "=", value: "global" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([multiSourceGlobal.id]);

  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationShell
        instanceKey="agent-context:space:filters"
        presentation={presentation(rows)}
        query={EMPTY_SYSTEM_COLLECTION_QUERY}
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
  const result = applySystemCollectionQuery({
    descriptor: queryDescriptor,
    query: {
      filters: [{ fieldKey: "client", operator: "=", value: "codex" }],
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
      <SystemCollectionPresentationShell
        instanceKey="agent-context:space:warning"
        presentation={presentation([warning])}
        query={EMPTY_SYSTEM_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Symbolic link")).toBe(true);
  expect(html.includes("Superseded")).toBe(false);
  expect(html.includes("Claude link support is not proven")).toBe(false);
  expect(html.includes("Name does not match its directory")).toBe(true);
});

test("Detail keeps discovery location independent from canonical ownership", () => {
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

  const spaceAliasDetail = renderToStaticMarkup(
    descriptor([spaceAliasToGlobal]).createDetailRequest?.(spaceAliasToGlobal)
      .content,
  );
  expect(spaceAliasDetail.includes("/home/user/.agents/skills")).toBe(true);
  expect(spaceAliasDetail.includes("Space")).toBe(true);
  expect(spaceAliasDetail.includes("Symbolic link")).toBe(true);
  expect(
    spaceAliasDetail.includes("/workspace/.agents/skills/global-link"),
  ).toBe(true);

  const globalAliasDetail = renderToStaticMarkup(
    descriptor([globalAliasToSpace]).createDetailRequest?.(globalAliasToSpace)
      .content,
  );
  expect(globalAliasDetail.includes("/workspace")).toBe(true);
  expect(globalAliasDetail.includes("Global")).toBe(true);
  expect(globalAliasDetail.includes("Directory alias")).toBe(true);
  expect(
    globalAliasDetail.includes("/home/user/.claude/skills/space-link"),
  ).toBe(true);
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
