import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyCollectionQuery,
  defineCollectionPresentation,
  EMPTY_COLLECTION_QUERY,
  CollectionFixedTabs,
  CollectionPresentationShell,
  type CollectionInstance,
  type CollectionPresentationDescriptor,
  type CollectionPresentationRuntime,
} from "@/features/collection";
import type { CollectionPropertyDefinition } from "@/features/properties";

interface ActorItem {
  canonicalEmail: string;
  displayName: string;
  repositoryAccess: "read-only" | "writable";
}

interface ContextArtifactItem {
  artifactId: string;
  client: string;
  scopeLabel: string;
  title: string;
}

interface RoutineDefinition {
  definitionPath: string;
  name: string;
  routineId: string;
}

interface RoutineRuntime {
  lastRunAt: string;
  status: "failed" | "idle" | "running";
}

interface RoutineItem {
  definitionPath: string;
  lastRunAt: string | null;
  name: string;
  routineId: string;
  status: RoutineRuntime["status"] | "unavailable";
}

type CreateActorDecision =
  | { status: "cancelled" }
  | { message: string; status: "invalid" }
  | { canonicalEmail: string; displayName: string; status: "confirmed" };

function customTextField<Item>(
  key: string,
  label: string,
  getValue: (item: Item) => string,
): CollectionPropertyDefinition<Item> {
  return {
    getValue,
    key,
    label,
    origin: "domain_specific",
    owner: { featureId: "fixture", kind: "feature" },
    semantics: {
      kind: "custom",
      render: (value) => <span>{String(value)}</span>,
    },
  };
}

function mergeRoutineSnapshot(
  definitions: readonly RoutineDefinition[],
  runtimeById: ReadonlyMap<string, RoutineRuntime>,
  limit: number,
): readonly RoutineItem[] {
  return Object.freeze(
    definitions.slice(0, limit).map((definition) => {
      const runtime = runtimeById.get(definition.routineId);
      return Object.freeze({
        definitionPath: definition.definitionPath,
        lastRunAt: runtime?.lastRunAt ?? null,
        name: definition.name,
        routineId: definition.routineId,
        status: runtime?.status ?? "unavailable",
      });
    }),
  );
}

const actorItems = Object.freeze<readonly ActorItem[]>([
  Object.freeze({
    canonicalEmail: "ilya@example.com",
    displayName: "Ilya",
    repositoryAccess: "writable",
  }),
]);
const contextItems = Object.freeze<readonly ContextArtifactItem[]>([
  Object.freeze({
    artifactId: "codex:project-agents",
    client: "codex",
    scopeLabel: "Project",
    title: "AGENTS.md",
  }),
]);
const routineDefinitions = Object.freeze<readonly RoutineDefinition[]>([
  Object.freeze({
    definitionPath: ".routines/review.md",
    name: "Review changes",
    routineId: "review-changes",
  }),
  Object.freeze({
    definitionPath: ".routines/triage.md",
    name: "Triage failures",
    routineId: "triage-failures",
  }),
  Object.freeze({
    definitionPath: ".routines/archive.md",
    name: "Archive completed work",
    routineId: "archive-completed",
  }),
]);
const routineItems = mergeRoutineSnapshot(
  routineDefinitions,
  new Map([
    [
      "review-changes",
      {
        lastRunAt: "2026-07-31T07:00:00Z",
        status: "running",
      } satisfies RoutineRuntime,
    ],
  ]),
  2,
);

const actorDescriptor: CollectionPresentationDescriptor<ActorItem> = {
  onActivate: () => undefined,
  properties: [
    customTextField("name", "Name", (item: ActorItem) => item.displayName),
    customTextField(
      "access",
      "Access",
      (item: ActorItem) => item.repositoryAccess,
    ),
  ],
  getItemId: (item) => item.canonicalEmail,
  id: "actors",
  label: "Actors",
  layout: {
    getDescription: (item) => item.canonicalEmail,
    getTitle: (item) => item.displayName,
    kind: "list",
    visibleProperties: ["access"],
  },
  query: {
    getSearchText: (item) => `${item.displayName} ${item.canonicalEmail}`,
  },
};
const contextDescriptor: CollectionPresentationDescriptor<ContextArtifactItem> =
  {
    onActivate: () => undefined,
    properties: [
      customTextField(
        "client",
        "Client",
        (item: ContextArtifactItem) => item.client,
      ),
    ],
    getItemId: (item) => item.artifactId,
    id: "context",
    label: "Context",
    layout: {
      cardSize: "large",
      density: "comfortable",
      getTitle: (item) => item.title,
      kind: "gallery",
      visibleProperties: ["client"],
    },
    query: { getSearchText: (item) => `${item.title} ${item.client}` },
  };
const routineDescriptor: CollectionPresentationDescriptor<RoutineItem> = {
  onActivate: () => undefined,
  properties: [
    customTextField("status", "Status", (item: RoutineItem) => item.status),
  ],
  getItemId: (item) => item.routineId,
  id: "routines",
  label: "Routines",
  layout: {
    getTitle: (item) => item.name,
    kind: "list",
    visibleProperties: ["status"],
  },
  query: { getSearchText: (item) => `${item.name} ${item.status}` },
};

const actorPresentation = defineCollectionPresentation({
  descriptor: actorDescriptor,
  state: {
    diagnostics: [<span key="history">One history source is unavailable</span>],
    phase: "ready",
    items: actorItems,
  },
});
const contextPresentation = defineCollectionPresentation({
  descriptor: contextDescriptor,
  state: {
    diagnostics: [<span key="client">Claude Code source is unavailable</span>],
    phase: "ready",
    items: contextItems,
  },
});
const routinePresentation = defineCollectionPresentation({
  descriptor: routineDescriptor,
  state: {
    diagnostics: [
      <span key="runtime">One runtime overlay is unavailable</span>,
    ],
    phase: "ready",
    items: routineItems,
  },
});
const heterogeneousInstance: CollectionInstance = {
  defaultPresentationId: "actors",
  instanceKey: "fixture:scope-local",
  presentations: [actorPresentation, contextPresentation, routinePresentation],
  stateScope: "lifecycle",
};
function renderPresentation(presentation: CollectionPresentationRuntime) {
  return renderToStaticMarkup(
    <CollectionPresentationShell
      instanceKey={heterogeneousInstance.instanceKey}
      onQueryChange={() => undefined}
      presentation={presentation}
      query={EMPTY_COLLECTION_QUERY}
    />,
  );
}

test("heterogeneous owner snapshots use one public List/Gallery/query/detail seam", () => {
  expect(heterogeneousInstance.presentations.length).toBe(3);
  const tabs = renderToStaticMarkup(
    <CollectionFixedTabs
      onValueChange={() => undefined}
      presentations={heterogeneousInstance.presentations}
      value="actors"
    />,
  );
  const actors = renderPresentation(actorPresentation);
  const context = renderPresentation(contextPresentation);
  const routines = renderPresentation(routinePresentation);
  const actorQuery = applyCollectionQuery({
    descriptor: actorDescriptor,
    query: { filters: [], search: " ILYA@EXAMPLE.COM ", sort: [] },
    items: actorItems,
  });

  expect(tabs.includes("Actors")).toBe(true);
  expect(tabs.includes("Context")).toBe(true);
  expect(tabs.includes("Routines")).toBe(true);
  expect(actors.includes('role="list"')).toBe(true);
  expect(actors.includes("One history source is unavailable")).toBe(true);
  expect(context.includes('data-slot="card"')).toBe(true);
  expect(context.includes("Claude Code source is unavailable")).toBe(true);
  expect(context.includes("data-collection-create")).toBe(false);
  expect(context.includes("Row actions")).toBe(false);
  expect(routines.includes("running")).toBe(true);
  expect(actorQuery.items).toEqual(actorItems);
  for (const markup of [actors, context, routines]) {
    expect(markup.includes('data-collection-activatable="true"')).toBe(true);
  }
});

test("routine snapshot is bounded, immutable, and normalized before composition", () => {
  expect(Object.isFrozen(routineItems)).toBe(true);
  expect(routineDefinitions.length).toBe(3);
  expect(routineItems.length).toBe(2);
  expect(routineItems).toEqual([
    {
      definitionPath: ".routines/review.md",
      lastRunAt: "2026-07-31T07:00:00Z",
      name: "Review changes",
      routineId: "review-changes",
      status: "running",
    },
    {
      definitionPath: ".routines/triage.md",
      lastRunAt: null,
      name: "Triage failures",
      routineId: "triage-failures",
      status: "unavailable",
    },
  ]);
  expect("body" in routineItems[0]!).toBe(false);
  expect("entry" in routineItems[0]!).toBe(false);
  expect("body" in actorItems[0]!).toBe(false);
  expect("entry" in contextItems[0]!).toBe(false);
});

test("feature-owned create flow leaves no artifact before confirmation", async () => {
  const artifacts: ActorItem[] = [];
  const commandCalls: ActorItem[] = [];
  const decisions: CreateActorDecision[] = [
    { status: "cancelled" },
    { message: "Email is required", status: "invalid" },
    {
      canonicalEmail: "ada@example.com",
      displayName: "Ada",
      status: "confirmed",
    },
  ];
  const requestCreateDecision = async () => {
    const decision = decisions.shift();
    if (!decision) {
      throw new Error("Missing fixture decision");
    }
    return decision;
  };
  const createActor = async (actor: ActorItem) => {
    commandCalls.push(actor);
    artifacts.push(actor);
  };
  const createDescriptor: CollectionPresentationDescriptor<ActorItem> = {
    ...actorDescriptor,
    create: {
      label: "Add contributor",
      intents: [
        {
          getState: () => ({ status: "idle" }),
          id: "add-contributor",
          label: "Add contributor",
          run: async () => {
            const decision = await requestCreateDecision();
            if (decision.status === "cancelled") return;
            if (decision.status === "invalid") {
              throw new Error(decision.message);
            }
            await createActor({
              canonicalEmail: decision.canonicalEmail,
              displayName: decision.displayName,
              repositoryAccess: "writable",
            });
          },
        },
      ],
    },
  };
  const runCreateFlow = async () => {
    await createDescriptor.create?.intents[0]?.run();
  };

  await runCreateFlow();
  expect(commandCalls).toEqual([]);
  expect(artifacts).toEqual([]);

  let validationError: string | null = null;
  try {
    await runCreateFlow();
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }
  expect(validationError).toBe("Email is required");
  expect(commandCalls).toEqual([]);
  expect(artifacts).toEqual([]);

  await runCreateFlow();
  expect(commandCalls).toEqual([
    {
      canonicalEmail: "ada@example.com",
      displayName: "Ada",
      repositoryAccess: "writable",
    },
  ]);
  expect(artifacts).toEqual(commandCalls);
  expect(decisions).toEqual([]);
});
