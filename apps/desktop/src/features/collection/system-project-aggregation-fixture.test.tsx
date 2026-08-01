import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applySystemCollectionQuery,
  defineSystemCollectionPresentation,
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationCore,
  type SystemCollectionDetailController,
  type SystemCollectionDetailRequest,
  type SystemCollectionFieldDescriptor,
  type SystemCollectionInstance,
  type SystemCollectionPresentationDescriptor,
  type SystemCollectionPresentationRuntime,
  type SystemCollectionStateController,
} from "@/features/collection/system";

interface ActorRow {
  canonicalEmail: string;
  displayName: string;
  repositoryAccess: "read-only" | "writable";
}

interface TargetContext {
  projectId: string;
  repositoryKey: string;
  repositoryLabel: string;
  scopeKey: string;
  scopeLabel: string;
}

interface ActorScopeSnapshot {
  diagnostics: readonly string[];
  rows: readonly ActorRow[];
  target: TargetContext;
}

interface ProjectActorRow {
  canonicalEmail: string;
  displayName: string;
  repositories: readonly string[];
  repositoryKeys: readonly string[];
  rowId: string;
  scopes: readonly string[];
  target: TargetContext;
  targets: readonly TargetContext[];
}

interface ProjectActorRouting {
  createTarget: TargetContext;
  targetByCanonicalEmail: ReadonlyMap<string, TargetContext>;
}

type OwnerCall =
  | { kind: "create"; target: TargetContext }
  | {
      canonicalEmail: string;
      kind: "detail" | "mutate";
      target: TargetContext;
    };

interface ActorOwnerFixtureApi {
  createActor(target: TargetContext): Promise<void>;
  listScopeSnapshots(input: {
    limitPerScope: number;
    projectId: string;
  }): readonly ActorScopeSnapshot[];
  renderActorDetail(target: TargetContext, canonicalEmail: string): ReactNode;
  setPrimaryAlias(target: TargetContext, canonicalEmail: string): Promise<void>;
}

function provenanceField(
  key: "repository" | "scope",
  label: string,
  getValues: (row: ProjectActorRow) => readonly string[],
): SystemCollectionFieldDescriptor<ProjectActorRow> {
  return {
    filter: {
      kind: "custom",
      matches: (row, rule) =>
        typeof rule.value === "string" && getValues(row).includes(rule.value),
      operators: ["contains"],
      renderEditor: ({ rule }) => <span>{String(rule.value ?? "")}</span>,
      validate: (rule) =>
        rule.operator === "contains" && typeof rule.value === "string",
    },
    getValue: (row) => getValues(row),
    key,
    label,
    valueSemantics: {
      kind: "custom",
      render: (value) =>
        Array.isArray(value) ? <span>{value.join(", ")}</span> : null,
    },
  };
}

function createOwnerFixture(): {
  api: ActorOwnerFixtureApi;
  calls: OwnerCall[];
  getRequestedLimit(): number | null;
  targets: { child: TargetContext; root: TargetContext };
} {
  const calls: OwnerCall[] = [];
  let requestedLimit: number | null = null;
  const root: TargetContext = {
    projectId: "project-one",
    repositoryKey: "repo-root",
    repositoryLabel: "Root repository",
    scopeKey: "root",
    scopeLabel: "Project",
  };
  const rootAlias: TargetContext = {
    ...root,
    scopeKey: "root-alias",
    scopeLabel: "Project alias",
  };
  const child: TargetContext = {
    projectId: "project-one",
    repositoryKey: "repo-child",
    repositoryLabel: "Child repository",
    scopeKey: "space-design",
    scopeLabel: "Design",
  };
  const ilya = Object.freeze({
    canonicalEmail: "ilya@example.com",
    displayName: "Ilya",
    repositoryAccess: "writable" as const,
  });
  const snapshots: readonly ActorScopeSnapshot[] = Object.freeze([
    Object.freeze({
      diagnostics: Object.freeze(["Root mailmap is partially unreadable"]),
      rows: Object.freeze([
        ilya,
        Object.freeze({
          canonicalEmail: "ada@example.com",
          displayName: "Ada",
          repositoryAccess: "read-only" as const,
        }),
        Object.freeze({
          canonicalEmail: "grace@example.com",
          displayName: "Grace",
          repositoryAccess: "read-only" as const,
        }),
      ]),
      target: root,
    }),
    Object.freeze({
      diagnostics: Object.freeze([]),
      rows: Object.freeze([ilya]),
      target: rootAlias,
    }),
    Object.freeze({
      diagnostics: Object.freeze(["Child activity snapshot is stale"]),
      rows: Object.freeze([ilya]),
      target: child,
    }),
  ]);

  return {
    api: {
      createActor: async (target) => {
        calls.push({ kind: "create", target });
      },
      listScopeSnapshots: ({ limitPerScope, projectId }) => {
        requestedLimit = limitPerScope;
        return Object.freeze(
          snapshots
            .filter((snapshot) => snapshot.target.projectId === projectId)
            .map((snapshot) =>
              Object.freeze({
                ...snapshot,
                rows: Object.freeze(snapshot.rows.slice(0, limitPerScope)),
              }),
            ),
        );
      },
      renderActorDetail: (target, canonicalEmail) => {
        calls.push({ canonicalEmail, kind: "detail", target });
        return <span>{`${target.scopeLabel}: ${canonicalEmail}`}</span>;
      },
      setPrimaryAlias: async (target, canonicalEmail) => {
        calls.push({ canonicalEmail, kind: "mutate", target });
      },
    },
    calls,
    getRequestedLimit: () => requestedLimit,
    targets: { child, root },
  };
}

function createProjectAggregateFixture(
  api: ActorOwnerFixtureApi,
  routing: ProjectActorRouting,
): {
  descriptor: SystemCollectionPresentationDescriptor<ProjectActorRow>;
  instance: SystemCollectionInstance;
  presentation: SystemCollectionPresentationRuntime;
  rows: readonly ProjectActorRow[];
} {
  const snapshots = api.listScopeSnapshots({
    limitPerScope: 2,
    projectId: routing.createTarget.projectId,
  });
  const byRepository = new Map<string, ActorScopeSnapshot>();
  for (const snapshot of snapshots) {
    if (!byRepository.has(snapshot.target.repositoryKey)) {
      byRepository.set(snapshot.target.repositoryKey, snapshot);
    }
  }

  const grouped = new Map<string, Omit<ProjectActorRow, "rowId" | "target">>();
  for (const snapshot of byRepository.values()) {
    for (const actor of snapshot.rows) {
      const current = grouped.get(actor.canonicalEmail);
      grouped.set(actor.canonicalEmail, {
        canonicalEmail: actor.canonicalEmail,
        displayName: actor.displayName,
        repositories: Object.freeze([
          ...(current?.repositories ?? []),
          snapshot.target.repositoryLabel,
        ]),
        repositoryKeys: Object.freeze([
          ...(current?.repositoryKeys ?? []),
          snapshot.target.repositoryKey,
        ]),
        scopes: Object.freeze([
          ...(current?.scopes ?? []),
          snapshot.target.scopeLabel,
        ]),
        targets: Object.freeze([...(current?.targets ?? []), snapshot.target]),
      });
    }
  }

  const rows = Object.freeze(
    [...grouped.values()].map((row) => {
      const target = routing.targetByCanonicalEmail.get(row.canonicalEmail);
      if (
        !target ||
        !row.targets.some(
          (candidate) =>
            candidate.projectId === target.projectId &&
            candidate.repositoryKey === target.repositoryKey &&
            candidate.scopeKey === target.scopeKey,
        )
      ) {
        throw new Error(
          `Missing explicit target for aggregate actor "${row.canonicalEmail}".`,
        );
      }
      return Object.freeze({
        ...row,
        rowId: JSON.stringify([
          routing.createTarget.projectId,
          row.canonicalEmail,
        ]),
        target,
      });
    }),
  );
  const descriptor: SystemCollectionPresentationDescriptor<ProjectActorRow> = {
    create: {
      getState: () => ({ status: "idle" }),
      id: "create-actor",
      label: "Add actor",
      run: () => api.createActor(routing.createTarget),
    },
    createDetailRequest: (row) => ({
      content: api.renderActorDetail(row.target, row.canonicalEmail),
      description: row.repositories.join(", "),
      title: row.displayName,
    }),
    fields: [
      provenanceField("scope", "Scope", (row) => row.scopes),
      provenanceField("repository", "Repository", (row) => row.repositoryKeys),
    ],
    getRowId: (row) => row.rowId,
    id: "project-actors",
    label: "Project actors",
    layout: {
      getDescription: (row) => row.canonicalEmail,
      getTitle: (row) => row.displayName,
      kind: "list",
      visibleFields: ["scope", "repository"],
    },
    query: {
      getSearchText: (row) =>
        `${row.displayName} ${row.canonicalEmail} ${row.scopes.join(" ")}`,
    },
    rowActions: [
      {
        getState: () => ({ status: "idle" }),
        id: "set-primary-alias",
        label: "Set primary alias",
        run: (row) => api.setPrimaryAlias(row.target, row.canonicalEmail),
      },
    ],
  };
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics);
  const presentation = defineSystemCollectionPresentation({
    descriptor,
    state: {
      diagnostics: diagnostics.map((message) => (
        <span key={message}>{message}</span>
      )),
      phase: "ready",
      rows,
    },
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: descriptor.id,
    instanceKey: "fixture:project-wide",
    presentations: [presentation],
    stateScope: "session",
  };
  return { descriptor, instance, presentation, rows };
}

function createProjectFixture() {
  const owner = createOwnerFixture();
  const aggregate = createProjectAggregateFixture(owner.api, {
    createTarget: owner.targets.child,
    targetByCanonicalEmail: new Map([
      ["ada@example.com", owner.targets.root],
      ["ilya@example.com", owner.targets.child],
    ]),
  });
  return { aggregate, owner };
}

function createLocalFixture(): {
  descriptor: SystemCollectionPresentationDescriptor<ActorRow>;
  instance: SystemCollectionInstance;
  presentation: SystemCollectionPresentationRuntime;
  row: ActorRow;
} {
  const row: ActorRow = {
    canonicalEmail: "ilya@example.com",
    displayName: "Ilya",
    repositoryAccess: "writable",
  };
  const descriptor: SystemCollectionPresentationDescriptor<ActorRow> = {
    createDetailRequest: (actor) => ({
      content: actor.repositoryAccess,
      description: "Derived repository identity",
      title: actor.displayName,
    }),
    fields: [],
    getRowId: (actor) => actor.canonicalEmail,
    id: "actors",
    label: "Actors",
    layout: {
      getTitle: (actor) => actor.displayName,
      kind: "list",
      visibleFields: [],
    },
    query: { getSearchText: (actor) => actor.displayName },
  };
  const presentation = defineSystemCollectionPresentation({
    descriptor,
    state: {
      diagnostics: [<span key="history">One source is unavailable</span>],
      phase: "ready",
      rows: [row],
    },
  });
  return {
    descriptor,
    instance: {
      defaultPresentationId: descriptor.id,
      instanceKey: "fixture:scope-local",
      presentations: [presentation],
      stateScope: "lifecycle",
    },
    presentation,
    row,
  };
}

const noopDetailController: SystemCollectionDetailController = {
  close: async () => true,
  open: async () => true,
  prepareForNavigation: async () => true,
};

function createRecordingDetailController() {
  const requests: SystemCollectionDetailRequest[] = [];
  const controller: SystemCollectionDetailController = {
    close: async () => true,
    open: async (request) => {
      requests.push(request);
      return true;
    },
    prepareForNavigation: async () => true,
  };
  return { controller, requests };
}

function createFixtureDetailRequest<Row>(
  instance: SystemCollectionInstance,
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  row: Row,
): SystemCollectionDetailRequest {
  const detail = descriptor.createDetailRequest?.(row);
  if (!detail) {
    throw new Error(
      `Presentation "${descriptor.id}" does not provide fixture detail.`,
    );
  }
  return {
    ...detail,
    selection: {
      instanceKey: instance.instanceKey,
      presentationId: descriptor.id,
      rowId: descriptor.getRowId(row),
    },
  };
}

function renderPresentation(
  instance: SystemCollectionInstance,
  presentation: SystemCollectionPresentationRuntime,
) {
  const state: Extract<SystemCollectionStateController, { phase: "ready" }> = {
    activePresentationId: instance.defaultPresentationId,
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_SYSTEM_COLLECTION_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };

  return renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationCore
        detailController={noopDetailController}
        instance={{ ...instance, presentations: [presentation] }}
        state={state}
      />
    </TooltipProvider>,
  );
}

function expectListContract(markup: string) {
  expect(markup.includes('role="list"')).toBe(true);
  expect(markup.includes("data-system-collection-diagnostics")).toBe(true);
  expect(markup.includes('data-system-collection-detail="true"')).toBe(true);
}

test("project aggregate owns dedupe, grouping, provenance, and target routing", async () => {
  const { aggregate, owner } = createProjectFixture();
  const detail = createRecordingDetailController();

  expect(owner.getRequestedLimit()).toBe(2);
  expect(Object.isFrozen(aggregate.rows)).toBe(true);
  expect(aggregate.rows.length).toBe(2);
  expect(aggregate.rows[0]?.rowId).toBe('["project-one","ilya@example.com"]');
  expect(aggregate.rows[0]?.targets).toEqual([
    owner.targets.root,
    owner.targets.child,
  ]);
  expect(aggregate.rows[0]?.target).toBe(owner.targets.child);
  expect(
    aggregate.rows.some((row) => row.canonicalEmail === "grace@example.com"),
  ).toBe(false);

  const filtered = applySystemCollectionQuery({
    descriptor: aggregate.descriptor,
    query: {
      filters: [
        {
          fieldKey: "repository",
          operator: "contains",
          value: "repo-child",
        },
      ],
      search: "",
      sort: [],
    },
    rows: aggregate.rows,
  });
  expect(filtered.rows.map((row) => row.canonicalEmail)).toEqual([
    "ilya@example.com",
  ]);

  await aggregate.descriptor.create?.run();
  await detail.controller.open(
    createFixtureDetailRequest(
      aggregate.instance,
      aggregate.descriptor,
      aggregate.rows[0]!,
    ),
  );
  await aggregate.descriptor.rowActions?.[0]?.run(aggregate.rows[0]!);
  expect(owner.calls).toEqual([
    { kind: "create", target: owner.targets.child },
    {
      canonicalEmail: "ilya@example.com",
      kind: "detail",
      target: owner.targets.child,
    },
    {
      canonicalEmail: "ilya@example.com",
      kind: "mutate",
      target: owner.targets.child,
    },
  ]);
  expect(detail.requests.map((request) => request.selection)).toEqual([
    {
      instanceKey: aggregate.instance.instanceKey,
      presentationId: aggregate.descriptor.id,
      rowId: aggregate.rows[0]!.rowId,
    },
  ]);
});

test("scope-local and project instances retain the same shell and Drawer seam", async () => {
  const { aggregate } = createProjectFixture();
  const local = createLocalFixture();
  const detail = createRecordingDetailController();
  const localMarkup = renderPresentation(local.instance, local.presentation);
  const projectMarkup = renderPresentation(
    aggregate.instance,
    aggregate.presentation,
  );

  expectListContract(localMarkup);
  expectListContract(projectMarkup);
  await detail.controller.open(
    createFixtureDetailRequest(local.instance, local.descriptor, local.row),
  );
  await detail.controller.open(
    createFixtureDetailRequest(
      aggregate.instance,
      aggregate.descriptor,
      aggregate.rows[0]!,
    ),
  );
  expect(
    detail.requests.map((request) => request.selection.instanceKey),
  ).toEqual([local.instance.instanceKey, aggregate.instance.instanceKey]);
  expect(projectMarkup.includes("Root mailmap is partially unreadable")).toBe(
    true,
  );
  expect(projectMarkup.includes("Child activity snapshot is stale")).toBe(true);
  expect(projectMarkup.includes("Add actor")).toBe(true);
});
