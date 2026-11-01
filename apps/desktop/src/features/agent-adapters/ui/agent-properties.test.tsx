import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  resolveStandardPropertyColumn,
  standardPropertyFilterOperators,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import { CollectionPropertyValue } from "@/features/properties/display";
import { setLocale } from "@/paraglide/runtime";

import { createAgentAdapterDictionary } from "../model/dictionary";
import {
  defineAgentCollectionProperty,
  defineAgentsCollectionProperty,
  type AgentPropertyValue,
} from "./agent-properties";

setLocale("en", { reload: false });

const agents = createAgentAdapterDictionary([
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
]);

interface Session {
  source: string;
}

interface Binding {
  value: AgentPropertyValue;
}

function render<Item>(
  property: CollectionPropertyDefinition<Item>,
  item: Item,
  context?: "detail",
) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPropertyValue
        context={context}
        property={property as CollectionPropertyDefinition<unknown>}
        item={item}
      />
    </TooltipProvider>,
  );
}

test("Agent is one declaration in every Collection: label, type, options, operators and display", () => {
  const sessions = defineAgentCollectionProperty<Session>({
    agents,
    getAgent: (item) => ({ agent: item.source, kind: "agent" }),
    items: [{ source: "codex" }],
  });
  const bindings = defineAgentCollectionProperty<Binding>({
    agents,
    getAgent: (item) => item.value,
    items: [{ value: { agent: "claude-code", kind: "agent" } }],
  });
  const shape = <Item,>(property: CollectionPropertyDefinition<Item>) => ({
    common: property.common,
    key: property.key,
    label: property.label,
    operators: standardPropertyFilterOperators(property),
    owner: property.owner,
    standard: resolveStandardPropertyColumn(property),
  });
  expect(shape(sessions)).toEqual(shape(bindings));
  expect(shape(sessions)).toEqual({
    common: "agent",
    key: "agent",
    label: "Agent",
    operators: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
    owner: { featureId: "agent-adapters", kind: "feature" },
    standard: {
      name: "agent",
      options: [
        { color: "blue", name: "Codex" },
        { color: "orange", name: "Claude Code" },
      ],
      type: "select",
    },
  });
  expect(render(sessions, { source: "codex" })).toBe(
    render(bindings, { value: { agent: "codex", kind: "agent" } }),
  );
});

test("Agent draws the agent's icon and name, a detail after it, and the participant's agent", () => {
  const property = defineAgentCollectionProperty<Binding>({
    agents,
    getAgent: (item) => item.value,
    items: [
      { value: { agent: "unknown-agent", kind: "agent" } },
      { value: { kind: "participant" } },
    ],
  });
  const codex = render(property, {
    value: { agent: "codex", detail: "GPT-5.4", kind: "agent" },
  });
  expect(codex.includes('data-agent-property="codex"')).toBe(true);
  expect(codex.includes(">Codex<")).toBe(true);
  expect(codex.includes(">GPT-5.4<")).toBe(true);
  expect(
    property.getValue({
      value: { agent: "codex", detail: "GPT-5.4", kind: "agent" },
    }),
  ).toBe("Codex");
  const participant = render(property, { value: { kind: "participant" } });
  expect(participant.includes('data-agent-property="participant"')).toBe(true);
  expect(participant.includes("Participant&#x27;s agent")).toBe(true);
  // An unknown agent and the participant's agent are options where an item
  // has them.
  expect(
    resolveStandardPropertyColumn(property)?.options?.map(
      (option) => option.name,
    ),
  ).toEqual(["Codex", "Claude Code", "Agent", "Participant's agent"]);
});

test("Agents draw icons in a cell and names in the panel, with idle agents and the reason of an empty value", () => {
  interface Item {
    agents: string[];
    idle: { agent: string; reason: string }[];
  }
  const property = defineAgentsCollectionProperty<Item>({
    agents,
    getAgents: (item) => item.agents,
    getNotes: (item) => ({
      emptyReason: "No enabled agent finds it",
      idle: item.idle,
    }),
  });
  expect([
    property.common,
    property.key,
    property.label,
    resolveStandardPropertyColumn(property)?.type,
  ]).toEqual(["agents", "agents", "Agents", "multi_select"]);
  const item: Item = {
    agents: ["codex"],
    idle: [{ agent: "claude-code", reason: "Claude Code · off in Svode" }],
  };
  expect(property.getValue(item)).toEqual(["Codex"]);
  const cell = render(property, item);
  expect(cell.includes('aria-label="Codex; Claude Code · off in Svode"')).toBe(
    true,
  );
  expect(cell.includes("data-agent-icon-muted")).toBe(true);
  const detail = render(property, item, "detail");
  expect(detail.includes('data-agent-property-idle="claude-code"')).toBe(true);
  expect(detail.includes(">Codex<")).toBe(true);
  const empty = render(property, { agents: [], idle: [] });
  expect(empty.includes("data-agent-property-empty")).toBe(true);
  expect(empty.includes("No enabled agent finds it")).toBe(true);
});
