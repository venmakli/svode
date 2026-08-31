import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyCollectionCoreQuery,
  defineCollectionCorePresentation,
  EMPTY_COLLECTION_CORE_QUERY,
  CollectionCoreFixedTabs,
  CollectionCorePresentationShell,
  type CollectionCoreInstance,
  type CollectionCorePresentationDescriptor,
  type CollectionCorePresentationRuntime,
} from "@/features/collection/core";
import type { CollectionPropertyDefinition } from "@/features/properties";

interface ActorRow {
  canonicalEmail: string;
  displayName: string;
  repositoryAccess: "read-only" | "writable";
}

interface ContextArtifactRow {
  artifactId: string;
  client: "claude-code" | "codex";
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

interface RoutineRow {
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

function customTextField<Row>(
  key: string,
  label: string,
  getValue: (row: Row) => string,
): CollectionPropertyDefinition<Row> {
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
): readonly RoutineRow[] {
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

const actorRows = Object.freeze<readonly ActorRow[]>([
  Object.freeze({
    canonicalEmail: "ilya@example.com",
    displayName: "Ilya",
    repositoryAccess: "writable",
  }),
]);
const contextRows = Object.freeze<readonly ContextArtifactRow[]>([
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
const routineRows = mergeRoutineSnapshot(
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

const actorDescriptor: CollectionCorePresentationDescriptor<ActorRow> = {
  onActivate: () => undefined,
  properties: [
    customTextField("name", "Name", (row: ActorRow) => row.displayName),
    customTextField(
      "access",
      "Access",
      (row: ActorRow) => row.repositoryAccess,
    ),
  ],
  getRowId: (row) => row.canonicalEmail,
  id: "actors",
  label: "Actors",
  layout: {
    getDescription: (row) => row.canonicalEmail,
    getTitle: (row) => row.displayName,
    kind: "list",
    visibleProperties: ["access"],
  },
  query: { getSearchText: (row) => `${row.displayName} ${row.canonicalEmail}` },
};
const contextDescriptor: CollectionCorePresentationDescriptor<ContextArtifactRow> =
  {
    onActivate: () => undefined,
    properties: [
      customTextField(
        "client",
        "Client",
        (row: ContextArtifactRow) => row.client,
      ),
    ],
    getRowId: (row) => row.artifactId,
    id: "context",
    label: "Context",
    layout: {
      cardSize: "large",
      density: "comfortable",
      getTitle: (row) => row.title,
      kind: "gallery",
      visibleProperties: ["client"],
    },
    query: { getSearchText: (row) => `${row.title} ${row.client}` },
  };
const routineDescriptor: CollectionCorePresentationDescriptor<RoutineRow> = {
  onActivate: () => undefined,
  properties: [
    customTextField("status", "Status", (row: RoutineRow) => row.status),
  ],
  getRowId: (row) => row.routineId,
  id: "routines",
  label: "Routines",
  layout: {
    getTitle: (row) => row.name,
    kind: "list",
    visibleProperties: ["status"],
  },
  query: { getSearchText: (row) => `${row.name} ${row.status}` },
};

const actorPresentation = defineCollectionCorePresentation({
  descriptor: actorDescriptor,
  state: {
    diagnostics: [<span key="history">One history source is unavailable</span>],
    phase: "ready",
    rows: actorRows,
  },
});
const contextPresentation = defineCollectionCorePresentation({
  descriptor: contextDescriptor,
  state: {
    diagnostics: [<span key="client">Claude Code source is unavailable</span>],
    phase: "ready",
    rows: contextRows,
  },
});
const routinePresentation = defineCollectionCorePresentation({
  descriptor: routineDescriptor,
  state: {
    diagnostics: [
      <span key="runtime">One runtime overlay is unavailable</span>,
    ],
    phase: "ready",
    rows: routineRows,
  },
});
const heterogeneousInstance: CollectionCoreInstance = {
  defaultPresentationId: "actors",
  instanceKey: "fixture:scope-local",
  presentations: [actorPresentation, contextPresentation, routinePresentation],
  stateScope: "lifecycle",
};
function renderPresentation(presentation: CollectionCorePresentationRuntime) {
  return renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey={heterogeneousInstance.instanceKey}
      onQueryChange={() => undefined}
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
    />,
  );
}

test("heterogeneous owner snapshots use one public List/Gallery/query/detail seam", () => {
  expect(heterogeneousInstance.presentations.length).toBe(3);
  const tabs = renderToStaticMarkup(
    <CollectionCoreFixedTabs
      onValueChange={() => undefined}
      presentations={heterogeneousInstance.presentations}
      value="actors"
    />,
  );
  const actors = renderPresentation(actorPresentation);
  const context = renderPresentation(contextPresentation);
  const routines = renderPresentation(routinePresentation);
  const actorQuery = applyCollectionCoreQuery({
    descriptor: actorDescriptor,
    query: { filters: [], search: " ILYA@EXAMPLE.COM ", sort: [] },
    rows: actorRows,
  });

  expect(tabs.includes("Actors")).toBe(true);
  expect(tabs.includes("Context")).toBe(true);
  expect(tabs.includes("Routines")).toBe(true);
  expect(actors.includes('role="list"')).toBe(true);
  expect(actors.includes("One history source is unavailable")).toBe(true);
  expect(context.includes('data-slot="card"')).toBe(true);
  expect(context.includes("Claude Code source is unavailable")).toBe(true);
  expect(context.includes("data-collection-core-create")).toBe(false);
  expect(context.includes("Row actions")).toBe(false);
  expect(routines.includes("running")).toBe(true);
  expect(actorQuery.rows).toEqual(actorRows);
  for (const markup of [actors, context, routines]) {
    expect(markup.includes('data-collection-activatable="true"')).toBe(true);
  }
});

test("routine snapshot is bounded, immutable, and normalized before composition", () => {
  expect(Object.isFrozen(routineRows)).toBe(true);
  expect(routineDefinitions.length).toBe(3);
  expect(routineRows.length).toBe(2);
  expect(routineRows).toEqual([
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
  expect("body" in routineRows[0]!).toBe(false);
  expect("entry" in routineRows[0]!).toBe(false);
  expect("body" in actorRows[0]!).toBe(false);
  expect("entry" in contextRows[0]!).toBe(false);
});

test("feature-owned create flow leaves no artifact before confirmation", async () => {
  const artifacts: ActorRow[] = [];
  const commandCalls: ActorRow[] = [];
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
  const createActor = async (actor: ActorRow) => {
    commandCalls.push(actor);
    artifacts.push(actor);
  };
  const createDescriptor: CollectionCorePresentationDescriptor<ActorRow> = {
    ...actorDescriptor,
    create: {
      getState: () => ({ status: "idle" }),
      id: "add-contributor",
      label: "Add contributor",
      run: async () => {
        const decision = await requestCreateDecision();
        if (decision.status === "cancelled") {
          return;
        }
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
  };
  const runCreateFlow = async () => {
    await createDescriptor.create?.run();
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
