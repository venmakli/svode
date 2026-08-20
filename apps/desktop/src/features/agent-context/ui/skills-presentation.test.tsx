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
      adapterId: "codex",
      discoveryKind: "codex_project",
      discoveryPath: "/workspace/.agents/skills/review",
      linkKind: "direct",
      ownerPath: "/workspace",
      resolution: "selected",
      rootPath: "/workspace/.agents/skills",
      scope: "project",
      support: "client_native",
    },
  ],
  body: "# Review\n\n[Blocked link](https://example.com)",
  canonicalPath: "/workspace/.agents/skills/review",
  clients: ["codex"],
  compatibility: null,
  description: "Review changes against project conventions.",
  health: "normal",
  healthReasons: [],
  id: "skill:/workspace/.agents/skills/review",
  license: null,
  manifestPath: "/workspace/.agents/skills/review/SKILL.md",
  name: "review",
  ownerPath: "/workspace",
  scopes: ["project"],
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
});

test("search and multivalue Client/Scope filters use feature-owned semantics", () => {
  const claudePersonal: AgentContextSkillRow = {
    ...reviewSkill,
    aliases: [
      {
        ...reviewSkill.aliases[0]!,
        adapterId: "claude-code",
        discoveryKind: "claude_personal",
        discoveryPath: "/home/user/.claude/skills/release",
        ownerPath: "/home/user/.claude/skills",
        rootPath: "/home/user/.claude/skills",
        scope: "personal",
      },
    ],
    canonicalPath: "/home/user/.claude/skills/release",
    clients: ["claude-code"],
    description: "Prepare a verified release snapshot.",
    id: "skill:/home/user/.claude/skills/release",
    manifestPath: "/home/user/.claude/skills/release/SKILL.md",
    name: "release",
    scopes: ["personal"],
  };
  const rows = [reviewSkill, claudePersonal];
  const queryDescriptor = descriptor(rows);

  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: { filters: [], search: "verified release", sort: [] },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([claudePersonal.id]);
  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ fieldKey: "client", operator: "=", value: "codex" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([reviewSkill.id]);
  expect(
    applySystemCollectionQuery({
      descriptor: queryDescriptor,
      query: {
        filters: [{ fieldKey: "scope", operator: "=", value: "personal" }],
        search: "",
        sort: [],
      },
      rows,
    }).rows.map((row) => row.id),
  ).toEqual([claudePersonal.id]);
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
      filters: [{ fieldKey: "client", operator: "=", value: "unknown" }],
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

  expect(html.includes("Filesystem alias")).toBe(true);
  expect(html.includes("Superseded")).toBe(true);
  expect(html.includes("Claude link support is not proven")).toBe(false);
  expect(html.includes("Name does not match its directory")).toBe(true);
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
        ownerPath: "/workspace",
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
