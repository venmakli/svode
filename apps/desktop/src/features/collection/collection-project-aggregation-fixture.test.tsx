import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applyCollectionQuery,
  defineCollectionPresentation,
  EMPTY_COLLECTION_QUERY,
  CollectionHost,
  type CollectionInstance,
  type CollectionPresentationDescriptor,
  type CollectionPresentationRuntime,
  type CollectionStateController,
} from "@/features/collection";
import type { CollectionPropertyDefinition } from "@/features/properties";

/** What an owner shows for an activated item of its presentation. */
interface ItemContent {
  content: ReactNode;
  description: string;
  title: string;
}

interface ItemRequest extends ItemContent {
  selection: { instanceKey: string; presentationId: string; itemId: string };
}

interface ActorItem {
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
  items: readonly ActorItem[];
  target: TargetContext;
}

interface ProjectActorItem {
  canonicalEmail: string;
  displayName: string;
  repositories: readonly string[];
  repositoryKeys: readonly string[];
  itemId: string;
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
  getValues: (item: ProjectActorItem) => readonly string[],
): CollectionPropertyDefinition<ProjectActorItem> {
  return {
    capabilities: {
      filter: {
        kind: "custom",
        matches: (item, rule) =>
          typeof rule.value === "string" &&
          getValues(item).includes(rule.value),
        operators: ["contains"],
        renderEditor: ({ rule }) => <span>{String(rule.value ?? "")}</span>,
        validate: (rule) =>
          rule.operator === "contains" && typeof rule.value === "string",
      },
    },
    getValue: (item) => getValues(item),
    key,
    label,
    origin: "domain_specific",
    owner: { featureId: "project-aggregate-fixture", kind: "feature" },
    semantics: {
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
      items: Object.freeze([
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
      items: Object.freeze([ilya]),
      target: rootAlias,
    }),
    Object.freeze({
      diagnostics: Object.freeze(["Child activity snapshot is stale"]),
      items: Object.freeze([ilya]),
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
                items: Object.freeze(snapshot.items.slice(0, limitPerScope)),
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
  itemRequests: ItemRequest[];
  descriptor: CollectionPresentationDescriptor<ProjectActorItem>;
  instance: CollectionInstance;
  presentation: CollectionPresentationRuntime;
  items: readonly ProjectActorItem[];
} {
  const detail = createRecordingItemOpener();
  const instanceKey = "fixture:project-wide";
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

  const grouped = new Map<
    string,
    Omit<ProjectActorItem, "itemId" | "target">
  >();
  for (const snapshot of byRepository.values()) {
    for (const actor of snapshot.items) {
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

  const items = Object.freeze(
    [...grouped.values()].map((item) => {
      const target = routing.targetByCanonicalEmail.get(item.canonicalEmail);
      if (
        !target ||
        !item.targets.some(
          (candidate) =>
            candidate.projectId === target.projectId &&
            candidate.repositoryKey === target.repositoryKey &&
            candidate.scopeKey === target.scopeKey,
        )
      ) {
        throw new Error(
          `Missing explicit target for aggregate actor "${item.canonicalEmail}".`,
        );
      }
      return Object.freeze({
        ...item,
        itemId: JSON.stringify([
          routing.createTarget.projectId,
          item.canonicalEmail,
        ]),
        target,
      });
    }),
  );
  const descriptor: CollectionPresentationDescriptor<ProjectActorItem> = {
    create: {
      label: "Add actor",
      intents: [
        {
          getState: () => ({ status: "idle" }),
          id: "create-actor",
          label: "Add actor",
          run: () => api.createActor(routing.createTarget),
        },
      ],
    },
    onActivate: detail.activation(
      (item: ProjectActorItem) => ({
        content: api.renderActorDetail(item.target, item.canonicalEmail),
        description: item.repositories.join(", "),
        title: item.displayName,
      }),
      instanceKey,
      "project-actors",
    ),
    properties: [
      provenanceField("scope", "Scope", (item) => item.scopes),
      provenanceField(
        "repository",
        "Repository",
        (item) => item.repositoryKeys,
      ),
    ],
    getItemId: (item) => item.itemId,
    id: "project-actors",
    label: "Project actors",
    layout: {
      getDescription: (item) => item.canonicalEmail,
      getTitle: (item) => item.displayName,
      kind: "list",
      visibleProperties: ["scope", "repository"],
    },
    query: {
      getSearchText: (item) =>
        `${item.displayName} ${item.canonicalEmail} ${item.scopes.join(" ")}`,
    },
    itemActions: [
      {
        getState: () => ({ status: "idle" }),
        id: "set-primary-alias",
        label: "Set primary alias",
        run: (item) => api.setPrimaryAlias(item.target, item.canonicalEmail),
      },
    ],
  };
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics);
  const presentation = defineCollectionPresentation({
    descriptor,
    state: {
      diagnostics: diagnostics.map((message) => (
        <span key={message}>{message}</span>
      )),
      phase: "ready",
      items,
    },
  });
  const instance: CollectionInstance = {
    defaultPresentationId: descriptor.id,
    instanceKey,
    presentations: [presentation],
    stateScope: "session",
  };
  return {
    descriptor,
    itemRequests: detail.requests,
    instance,
    presentation,
    items,
  };
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
  itemRequests: ItemRequest[];
  descriptor: CollectionPresentationDescriptor<ActorItem>;
  instance: CollectionInstance;
  presentation: CollectionPresentationRuntime;
  item: ActorItem;
} {
  const detail = createRecordingItemOpener();
  const instanceKey = "fixture:scope-local";
  const item: ActorItem = {
    canonicalEmail: "ilya@example.com",
    displayName: "Ilya",
    repositoryAccess: "writable",
  };
  const descriptor: CollectionPresentationDescriptor<ActorItem> = {
    onActivate: detail.activation(
      (actor: ActorItem) => ({
        content: actor.repositoryAccess,
        description: "Derived repository identity",
        title: actor.displayName,
      }),
      instanceKey,
      "actors",
    ),
    properties: [],
    getItemId: (actor) => actor.canonicalEmail,
    id: "actors",
    label: "Actors",
    layout: {
      getTitle: (actor) => actor.displayName,
      kind: "list",
      visibleProperties: [],
    },
    query: { getSearchText: (actor) => actor.displayName },
  };
  const presentation = defineCollectionPresentation({
    descriptor,
    state: {
      diagnostics: [<span key="history">One source is unavailable</span>],
      phase: "ready",
      items: [item],
    },
  });
  return {
    descriptor,
    itemRequests: detail.requests,
    instance: {
      defaultPresentationId: descriptor.id,
      instanceKey,
      presentations: [presentation],
      stateScope: "lifecycle",
    },
    presentation,
    item,
  };
}

/** Records what an owner opens for an item of its presentation. */
function createRecordingItemOpener() {
  const requests: ItemRequest[] = [];
  return {
    activation:
      <Item,>(
        createContent: (item: Item) => ItemContent,
        instanceKey: string,
        presentationId: string,
      ) =>
      async (item: Item, context: { itemId: string }) => {
        requests.push({
          ...createContent(item),
          selection: { instanceKey, presentationId, itemId: context.itemId },
        });
      },
    requests,
  };
}

function renderPresentation(
  instance: CollectionInstance,
  presentation: CollectionPresentationRuntime,
) {
  const state: Extract<CollectionStateController, { phase: "ready" }> = {
    activePresentationId: instance.defaultPresentationId,
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_COLLECTION_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };

  return renderToStaticMarkup(
    <TooltipProvider>
      <CollectionHost
        instance={{ ...instance, presentations: [presentation] }}
        state={state}
      />
    </TooltipProvider>,
  );
}

function expectListContract(markup: string) {
  expect(markup.includes('role="list"')).toBe(true);
  expect(markup.includes("data-collection-diagnostics")).toBe(true);
  expect(markup.includes('data-collection-activatable="true"')).toBe(true);
}

test("project aggregate owns dedupe, grouping, provenance, and target routing", async () => {
  const { aggregate, owner } = createProjectFixture();

  expect(owner.getRequestedLimit()).toBe(2);
  expect(Object.isFrozen(aggregate.items)).toBe(true);
  expect(aggregate.items.length).toBe(2);
  expect(aggregate.items[0]?.itemId).toBe('["project-one","ilya@example.com"]');
  expect(aggregate.items[0]?.targets).toEqual([
    owner.targets.root,
    owner.targets.child,
  ]);
  expect(aggregate.items[0]?.target).toBe(owner.targets.child);
  expect(
    aggregate.items.some((item) => item.canonicalEmail === "grace@example.com"),
  ).toBe(false);

  const filtered = applyCollectionQuery({
    descriptor: aggregate.descriptor,
    query: {
      filters: [
        {
          propertyKey: "repository",
          operator: "contains",
          value: "repo-child",
        },
      ],
      search: "",
      sort: [],
    },
    items: aggregate.items,
  });
  expect(filtered.items.map((item) => item.canonicalEmail)).toEqual([
    "ilya@example.com",
  ]);

  await aggregate.descriptor.create?.intents[0]?.run();
  await aggregate.descriptor.onActivate?.(aggregate.items[0]!, {
    itemId: aggregate.items[0]!.itemId,
  });
  await aggregate.descriptor.itemActions?.[0]?.run(aggregate.items[0]!);
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
  expect(aggregate.itemRequests.map((request) => request.selection)).toEqual([
    {
      instanceKey: aggregate.instance.instanceKey,
      presentationId: aggregate.descriptor.id,
      itemId: aggregate.items[0]!.itemId,
    },
  ]);
});

test("scope-local and project instances retain the same shell and detail seam", async () => {
  const { aggregate } = createProjectFixture();
  const local = createLocalFixture();
  const localMarkup = renderPresentation(local.instance, local.presentation);
  const projectMarkup = renderPresentation(
    aggregate.instance,
    aggregate.presentation,
  );

  expectListContract(localMarkup);
  expectListContract(projectMarkup);
  await local.descriptor.onActivate?.(local.item, {
    itemId: local.descriptor.getItemId(local.item),
  });
  await aggregate.descriptor.onActivate?.(aggregate.items[0]!, {
    itemId: aggregate.items[0]!.itemId,
  });
  expect(
    [...local.itemRequests, ...aggregate.itemRequests].map(
      (request) => request.selection.instanceKey,
    ),
  ).toEqual([local.instance.instanceKey, aggregate.instance.instanceKey]);
  expect(projectMarkup.includes("Root mailmap is partially unreadable")).toBe(
    true,
  );
  expect(projectMarkup.includes("Child activity snapshot is stale")).toBe(true);
  expect(projectMarkup.includes("Add actor")).toBe(true);
});
