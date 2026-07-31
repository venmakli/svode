import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applySystemCollectionQuery,
  defineSystemCollectionPresentation,
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionFixedTabs,
  SystemCollectionPresentationShell,
  type SystemCollectionDetailController,
  type SystemCollectionFieldDescriptor,
  type SystemCollectionInstance,
  type SystemCollectionPresentationDescriptor,
  type SystemCollectionPresentationRuntime,
} from "@/features/collection/system";

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

function customTextField<Row>(
  key: string,
  label: string,
  getValue: (row: Row) => string,
): SystemCollectionFieldDescriptor<Row> {
  return {
    getValue,
    key,
    label,
    valueSemantics: {
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

const actorDescriptor: SystemCollectionPresentationDescriptor<ActorRow> = {
  createDetailRequest: (row) => ({
    content: <span>{row.repositoryAccess}</span>,
    description: "Derived repository identity",
    title: row.displayName,
  }),
  fields: [
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
  query: { getSearchText: (row) => `${row.displayName} ${row.canonicalEmail}` },
  renderer: "list",
  renderRowContent: (_row, context) => (
    <>
      {context.renderField("name")}
      {context.renderField("access")}
    </>
  ),
};
const contextDescriptor: SystemCollectionPresentationDescriptor<ContextArtifactRow> =
  {
    createDetailRequest: (row) => ({
      content: <span>{row.scopeLabel}</span>,
      description: `${row.client} native artifact`,
      title: row.title,
    }),
    fields: [
      customTextField(
        "client",
        "Client",
        (row: ContextArtifactRow) => row.client,
      ),
    ],
    getRowId: (row) => row.artifactId,
    id: "context",
    label: "Context",
    query: { getSearchText: (row) => `${row.title} ${row.client}` },
    renderer: "cards",
    renderRowContent: (row, context) => (
      <>
        <strong>{row.title}</strong>
        {context.renderField("client")}
      </>
    ),
  };
const routineDescriptor: SystemCollectionPresentationDescriptor<RoutineRow> = {
  createDetailRequest: (row) => ({
    content: <span>{row.definitionPath}</span>,
    description: `Runtime status: ${row.status}`,
    title: row.name,
  }),
  fields: [
    customTextField("status", "Status", (row: RoutineRow) => row.status),
  ],
  getRowId: (row) => row.routineId,
  id: "routines",
  label: "Routines",
  query: { getSearchText: (row) => `${row.name} ${row.status}` },
  renderer: "list",
  renderRowContent: (row, context) => (
    <>
      <strong>{row.name}</strong>
      {context.renderField("status")}
    </>
  ),
};

const actorPresentation = defineSystemCollectionPresentation({
  descriptor: actorDescriptor,
  state: {
    diagnostics: [<span key="history">One history source is unavailable</span>],
    phase: "ready",
    rows: actorRows,
  },
});
const contextPresentation = defineSystemCollectionPresentation({
  descriptor: contextDescriptor,
  state: {
    diagnostics: [<span key="client">Claude Code source is unavailable</span>],
    phase: "ready",
    rows: contextRows,
  },
});
const routinePresentation = defineSystemCollectionPresentation({
  descriptor: routineDescriptor,
  state: {
    diagnostics: [
      <span key="runtime">One runtime overlay is unavailable</span>,
    ],
    phase: "ready",
    rows: routineRows,
  },
});
const heterogeneousInstance: SystemCollectionInstance = {
  defaultPresentationId: "actors",
  instanceKey: "fixture:scope-local",
  presentations: [actorPresentation, contextPresentation, routinePresentation],
  stateScope: "lifecycle",
};
const detailController: SystemCollectionDetailController = {
  close: async () => true,
  open: async () => true,
  prepareForNavigation: async () => true,
};

function renderPresentation(presentation: SystemCollectionPresentationRuntime) {
  return renderToStaticMarkup(
    <SystemCollectionPresentationShell
      detailController={detailController}
      instanceKey={heterogeneousInstance.instanceKey}
      onQueryChange={() => undefined}
      presentation={presentation}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
    />,
  );
}

test("heterogeneous owner snapshots use one public List/cards/query/detail seam", () => {
  expect(heterogeneousInstance.presentations.length).toBe(3);
  const tabs = renderToStaticMarkup(
    <SystemCollectionFixedTabs
      onValueChange={() => undefined}
      presentations={heterogeneousInstance.presentations}
      value="actors"
    />,
  );
  const actors = renderPresentation(actorPresentation);
  const context = renderPresentation(contextPresentation);
  const routines = renderPresentation(routinePresentation);
  const actorQuery = applySystemCollectionQuery({
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
  expect(context.includes("data-system-collection-create")).toBe(false);
  expect(context.includes("Row actions")).toBe(false);
  expect(routines.includes("running")).toBe(true);
  expect(actorQuery.rows).toEqual(actorRows);
  for (const markup of [actors, context, routines]) {
    expect(markup.includes('data-system-collection-detail="true"')).toBe(true);
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
