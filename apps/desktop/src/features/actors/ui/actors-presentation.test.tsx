import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applyCollectionCoreQuery,
  EMPTY_COLLECTION_CORE_QUERY,
  CollectionCorePresentationCore,
  CollectionCorePresentationShell,
  type CollectionCoreInstance,
  type CollectionCoreStateController,
} from "@/features/collection/core";

import type { ActorCatalogRow } from "../model/types";
import {
  actorCatalogBlockingError,
  createActorDetailRequest,
  createActorsPresentation,
  createActorsPresentationDescriptor,
} from "./actors-presentation";

const actors: readonly ActorCatalogRow[] = Object.freeze([
  {
    aliases: [{ email: "ada@old.test", line: 2, name: "A. Lovelace" }],
    availableYears: [2026, 2025],
    canonicalEmail: "ada@example.test",
    commitCount: 4,
    contribution: "contributor",
    displayName: "Ada Lovelace",
    lastActivityDate: "2026-07-31",
    lastCommitAt: 20,
    sources: [
      {
        email: "ada@old.test",
        kind: "history",
        line: null,
        name: "A. Lovelace",
      },
      {
        email: "ada@example.test",
        kind: "mailmap",
        line: 2,
        name: "Ada Lovelace",
      },
    ],
  },
  {
    aliases: [],
    availableYears: [],
    canonicalEmail: "current@example.test",
    commitCount: 0,
    contribution: "no_commits",
    displayName: "Current Identity",
    lastActivityDate: null,
    lastCommitAt: null,
    sources: [
      {
        email: "current@example.test",
        kind: "current_git_identity",
        line: null,
        name: "Current Identity",
      },
    ],
  },
]);

test("actors descriptor exposes the fixed query fields and exact action placement", () => {
  const descriptor = createActorsPresentationDescriptor();

  expect(descriptor.id).toBe("humans");
  expect(descriptor.properties.map((property) => property.key)).toEqual([
    "contribution",
    "commits",
    "activity",
  ]);
  expect(descriptor.properties.map((property) => property.origin)).toEqual([
    "owner_defined",
    "computed",
    "computed",
  ]);
  expect(descriptor.create?.id).toBe("add-actor");
  expect(descriptor.create?.getState().status).toBe("disabled");
  expect(descriptor.rowActions?.map((action) => action.id)).toEqual([
    "merge-actor",
    "edit-actor",
  ]);
  expect(
    descriptor.rowActions?.every(
      (action) => action.getState(actors[0]!).status === "disabled",
    ),
  ).toBe(true);
});

test("actors descriptor delegates enabled add, merge, and edit mutations", async () => {
  const calls: string[] = [];
  const descriptor = createActorsPresentationDescriptor({
    mutations: {
      createState: { status: "idle" },
      getEditState: () => ({ status: "idle" }),
      getMergeState: () => ({ status: "idle" }),
      onAdd: () => calls.push("add"),
      onEdit: (row) => calls.push(`edit:${row.canonicalEmail}`),
      onMerge: (row) => calls.push(`merge:${row.canonicalEmail}`),
    },
  });

  expect(descriptor.create?.getState()).toEqual({ status: "idle" });
  await descriptor.create?.run();
  for (const action of descriptor.rowActions ?? []) {
    expect(action.getState(actors[0]!)).toEqual({ status: "idle" });
    await action.run(actors[0]!);
  }
  expect(calls).toEqual([
    "add",
    "merge:ada@example.test",
    "edit:ada@example.test",
  ]);
});

test("actors query searches name and email with activity-first default ordering", () => {
  const descriptor = createActorsPresentationDescriptor();
  const ordered = applyCollectionCoreQuery({
    descriptor,
    query: EMPTY_COLLECTION_CORE_QUERY,
    rows: [...actors].reverse(),
  });
  const searched = applyCollectionCoreQuery({
    descriptor,
    query: { filters: [], search: " ADA@EXAMPLE.TEST ", sort: [] },
    rows: actors,
  });

  expect(ordered.rows.map((row) => row.canonicalEmail)).toEqual([
    "ada@example.test",
    "current@example.test",
  ]);
  expect(searched.rows.map((row) => row.canonicalEmail)).toEqual([
    "ada@example.test",
  ]);
});

test("singleton and query-empty actors reuse list keyboard, menu, and detail seams", () => {
  const descriptor = createActorsPresentationDescriptor();
  const presentation = createActorsPresentation({
    state: { phase: "ready", rows: [actors[1]!] },
  });
  const instance: CollectionCoreInstance = {
    defaultPresentationId: descriptor.id,
    instanceKey: "actors:space:root",
    presentations: [presentation],
    stateScope: "session",
  };
  const state: Extract<CollectionCoreStateController, { phase: "ready" }> = {
    activePresentationId: descriptor.id,
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_COLLECTION_CORE_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const singleton = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionCorePresentationCore instance={instance} state={state} />
    </TooltipProvider>,
  );
  const queryEmpty = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="actors:space:root"
      presentation={presentation}
      query={{ filters: [], search: "missing", sort: [] }}
      onQueryChange={() => undefined}
    />,
  );
  const detail = createActorDetailRequest(actors[0]!, "/repo");
  const detailMarkup = renderToStaticMarkup(
    <>
      {detail.title}
      {detail.description}
      {detail.content}
    </>,
  );

  expect(singleton.includes('role="list"')).toBe(true);
  expect(singleton.includes('role="listitem"')).toBe(true);
  expect(singleton.includes('tabindex="0"')).toBe(true);
  expect(
    singleton.includes('data-collection-presentation-toolbar="true"'),
  ).toBe(true);
  expect(singleton.includes('data-collection-core-presentation="humans"')).toBe(
    true,
  );
  expect(singleton.includes('data-collection-core-create="add-actor"')).toBe(
    true,
  );
  expect(singleton.includes("data-collection-core-refresh")).toBe(false);
  expect(singleton.includes('aria-label="Search..."')).toBe(true);
  expect(singleton.includes("Filter")).toBe(true);
  expect(singleton.includes("Sort")).toBe(true);
  expect(singleton.includes("Current Identity")).toBe(true);
  expect(singleton.includes("You")).toBe(false);
  expect(singleton.includes("Row actions")).toBe(false);
  expect(queryEmpty.includes("No results")).toBe(true);
  expect(detailMarkup.includes("data-actor-detail")).toBe(true);
  expect(detailMarkup.includes("flex-col text-left")).toBe(true);
  expect(detailMarkup.includes("ada@example.test")).toBe(true);
  expect(detailMarkup.includes("Repository identity")).toBe(true);
  expect(detailMarkup.includes("Loading activity")).toBe(true);
  expect(detailMarkup.includes("Git identities")).toBe(true);
  expect(detailMarkup.includes("Has commits")).toBe(false);
  expect(detailMarkup.includes("Commits: 4")).toBe(false);
  expect(detailMarkup.includes('data-slot="separator"')).toBe(false);
});

test("actors exposes retry only when an error provides recovery", () => {
  const withoutRetry = renderToStaticMarkup(
    <>{actorCatalogBlockingError("Unavailable", "offline")}</>,
  );
  const withRetry = renderToStaticMarkup(
    <>
      {actorCatalogBlockingError("Unavailable", "offline", {
        disabled: false,
        label: "Retry",
        onRetry: () => undefined,
      })}
    </>,
  );

  expect(withoutRetry.includes("Retry")).toBe(false);
  expect(withRetry.includes("Retry")).toBe(true);
});
