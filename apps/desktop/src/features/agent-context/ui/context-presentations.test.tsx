import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { createAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  applyCollectionQuery,
  EMPTY_COLLECTION_QUERY,
  type CollectionPresentationDescriptor,
} from "@/features/collection";
import { CollectionPropertyValue } from "@/features/properties/display";
import type { CollectionPropertyDefinition } from "@/features/properties";

import type { AgentContextItem } from "../model/types";
import {
  AGENT_CONTEXT_PRESETS,
  createAgentContextPresentation,
} from "./context-presentations";
import {
  agentContextLocationLabel,
  createAgentContextItemProperties,
} from "./item-properties";

const agents = createAgentAdapterDictionary([
  { displayName: "Codex", id: "codex" },
  { displayName: "Claude Code", id: "claude-code" },
]);

function item(overrides: Partial<AgentContextItem>): AgentContextItem {
  return {
    body: "",
    description: null,
    health: "normal",
    healthReasons: [],
    id: "instruction:/workspace/AGENTS.md",
    kind: "instruction",
    location: { kind: "target", path: "" },
    modifiedAt: "2026-10-15T08:00:00Z",
    name: "AGENTS.md",
    ownerPath: "/workspace",
    path: "/workspace/AGENTS.md",
    providers: ["codex"],
    references: [],
    skill: null,
    sources: [],
    truncated: false,
    unapplied: null,
    ...overrides,
  };
}

const spaceAgents = item({});
const codexAgents = item({
  id: "instruction:/home/user/.codex/AGENTS.md",
  location: { kind: "home", path: ".codex" },
  path: "/home/user/.codex/AGENTS.md",
});
const shadowed = item({
  health: "degraded",
  healthReasons: ["Preview was limited"],
  id: "instruction:/workspace/docs/AGENTS.md",
  location: { kind: "target", path: "docs" },
  path: "/workspace/docs/AGENTS.md",
  providers: [],
  unapplied: { by: ["/workspace/docs/AGENTS.override.md"], kind: "superseded" },
});
const projectSkill = item({
  description: "Review project changes.",
  id: "skill:/workspace/.claude/skills/review",
  kind: "skill",
  location: { kind: "target", path: ".claude/skills" },
  name: "review",
  path: "/workspace/.claude/skills/review/SKILL.md",
  providers: [],
  unapplied: { kind: "not_found", readers: ["claude-code"] },
});
const items = [spaceAgents, codexAgents, shadowed, projectSkill];

const properties = createAgentContextItemProperties({ agents });

function presentation(id: (typeof AGENT_CONTEXT_PRESETS)[number]) {
  const runtime = createAgentContextPresentation({
    id,
    properties,
    state: { phase: "ready", rows: items },
  });
  return (
    runtime as unknown as {
      instance: {
        descriptor: CollectionPresentationDescriptor<AgentContextItem>;
      };
    }
  ).instance.descriptor;
}

function render(node: ReactNode) {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

function value(key: string, row: AgentContextItem, context?: "detail") {
  const property = properties.find((candidate) => candidate.key === key);
  return render(
    <CollectionPropertyValue
      context={context}
      property={property as CollectionPropertyDefinition<unknown>}
      row={row}
    />,
  );
}

test("one set of properties in the column order of the contract", () => {
  expect(properties.map((property) => property.key)).toEqual([
    "name",
    "type",
    "providers",
    "health",
    "location",
    "modified",
  ]);
  const all = presentation("all");
  expect(all.layout.kind).toBe("table");
  expect(all.layout.visibleProperties).toEqual([
    "name",
    "type",
    "providers",
    "health",
    "location",
    "modified",
  ]);
  // Every property filters and sorts with the standard operators.
  for (const property of properties) {
    expect(property.semantics.kind).toBe("standard");
    expect(property.capabilities?.filter?.kind).toBe("standard");
  }
});

test("presets are layouts over the one set: All, Instructions and Skills", () => {
  expect(AGENT_CONTEXT_PRESETS).toEqual(["all", "instructions", "skills"]);
  const rowsOf = (id: (typeof AGENT_CONTEXT_PRESETS)[number]) =>
    applyCollectionQuery({
      descriptor: presentation(id),
      query: EMPTY_COLLECTION_QUERY,
      rows: items,
    }).rows.map((row) => row.id);

  expect(rowsOf("all").length).toBe(4);
  // Sorted by name, then by path.
  expect(rowsOf("instructions")).toEqual([
    codexAgents.id,
    spaceAgents.id,
    shadowed.id,
  ]);
  expect(rowsOf("skills")).toEqual([projectSkill.id]);
  expect(presentation("instructions").layout.kind).toBe("gallery");
  const skills = presentation("skills").layout;
  expect(skills.kind).toBe("gallery");
  expect(skills.visibleProperties).toEqual(["location", "providers"]);
});

test("filter, sort and search work on Providers, Location and Status", () => {
  const all = presentation("all");
  const filtered = (
    filters: { propertyKey: string; operator: string; value?: unknown }[],
  ) =>
    applyCollectionQuery({
      descriptor: all,
      query: { ...EMPTY_COLLECTION_QUERY, filters },
      rows: items,
    }).rows.map((row) => row.id);

  expect(
    filtered([
      { operator: "contains", propertyKey: "providers", value: "Codex" },
    ]),
  ).toEqual([codexAgents.id, spaceAgents.id]);
  expect(
    filtered([{ operator: "is_empty", propertyKey: "providers" }]),
  ).toEqual([shadowed.id, projectSkill.id]);
  expect(
    filtered([
      { operator: "eq", propertyKey: "health", value: "Has problems" },
    ]),
  ).toEqual([shadowed.id]);
  expect(
    applyCollectionQuery({
      descriptor: all,
      query: { ...EMPTY_COLLECTION_QUERY, search: "~/.codex" },
      rows: items,
    }).rows.map((row) => row.id),
  ).toEqual([codexAgents.id]);
});

test("Location is a short path: the Space root by name, home from ~", () => {
  expect(agentContextLocationLabel({ kind: "target", path: "" })).toBe("Space");
  expect(agentContextLocationLabel({ kind: "target", path: "docs" })).toBe(
    "docs",
  );
  expect(agentContextLocationLabel({ kind: "home", path: ".codex" })).toBe(
    "~/.codex",
  );
  expect(agentContextLocationLabel({ kind: "home", path: "" })).toBe("~");
  expect(agentContextLocationLabel({ kind: "absolute", path: "/opt/x" })).toBe(
    "/opt/x",
  );
});

test("Providers show agent icons, an empty value names its reason", () => {
  expect(value("providers", spaceAgents).includes('aria-label="Codex"')).toBe(
    true,
  );
  expect(
    value("providers", shadowed).includes(
      "Shadowed by /workspace/docs/AGENTS.override.md",
    ),
  ).toBe(true);
  expect(
    value("providers", projectSkill).includes("No enabled agent finds it"),
  ).toBe(true);

  const detail = value("providers", projectSkill, "detail");
  expect(detail.includes("No enabled agent finds it")).toBe(true);
  expect(detail.includes("Read by their own rules: Claude Code")).toBe(true);
  // Without an opener there is no link to follow.
  expect(detail.includes("Open Providers")).toBe(false);
  const linked = createAgentContextItemProperties({
    agents,
    onOpenProviders: () => undefined,
  }).find((property) => property.key === "providers")!;
  const linkedDetail = render(
    <CollectionPropertyValue
      context="detail"
      property={linked as CollectionPropertyDefinition<unknown>}
      row={projectSkill}
    />,
  );
  expect(linkedDetail.includes("Open Providers")).toBe(true);

  expect(value("health", spaceAgents)).toBe("");
  expect(value("health", shadowed).includes("Has problems")).toBe(true);
});
