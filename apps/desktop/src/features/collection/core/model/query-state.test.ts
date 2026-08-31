import { expect, test } from "bun:test";

import { defineCollectionCorePresentation } from "./runtime";
import {
  createCollectionCoreInstanceState,
  normalizeCollectionCoreInstanceState,
  queryForCollectionCorePresentation,
  setCollectionCorePresentationQuery,
  useCollectionCoreSessionQueryState,
} from "./query-state";
import type {
  CollectionCoreInstance,
  CollectionCorePresentationRuntime,
} from "./types";

interface Row {
  id: string;
  name: string;
}

function presentation(
  id: string,
  properties: "searchable" | "plain" = "searchable",
): CollectionCorePresentationRuntime {
  return defineCollectionCorePresentation<Row>({
    descriptor: {
      properties: [
        {
          capabilities: {
            filter: { kind: "standard" },
            sort: { kind: "standard" },
          },
          getValue: (row) => row.name,
          key: "name",
          label: "Name",
          origin: "owner_defined",
          owner: { featureId: "query-state-test", kind: "feature" },
          semantics: { kind: "standard", standard: { type: "text" } },
        },
      ],
      getRowId: (row) => row.id,
      id,
      label: id,
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleProperties: [],
      },
      query:
        properties === "searchable" ? { getSearchText: (row) => row.name } : {},
    },
    state: { phase: "ready", rows: [] },
  });
}

function instance(
  instanceKey: string,
  presentations = [presentation("people"), presentation("agents")],
): CollectionCoreInstance {
  return {
    defaultPresentationId: "people",
    instanceKey,
    presentations,
    stateScope: "session",
  };
}

test("query state is isolated between instances and presentations", () => {
  const actors = instance("space:root:actors");
  const projectActors = instance("project:actors");
  let actorsState = createCollectionCoreInstanceState();
  let projectState = createCollectionCoreInstanceState();

  actorsState = setCollectionCorePresentationQuery(
    actors,
    actorsState,
    "people",
    { filters: [], search: "Ilya", sort: [] },
  );
  actorsState = setCollectionCorePresentationQuery(
    actors,
    actorsState,
    "agents",
    { filters: [], search: "Codex", sort: [] },
  );
  projectState = setCollectionCorePresentationQuery(
    projectActors,
    projectState,
    "people",
    { filters: [], search: "Project", sort: [] },
  );

  expect(queryForCollectionCorePresentation(actorsState, "people").search).toBe(
    "Ilya",
  );
  expect(queryForCollectionCorePresentation(actorsState, "agents").search).toBe(
    "Codex",
  );
  expect(
    queryForCollectionCorePresentation(projectState, "people").search,
  ).toBe("Project");
});

test("session store restores state while independent lifecycle state starts empty", () => {
  const catalog = instance("space:root:actors");
  const stored = setCollectionCorePresentationQuery(
    catalog,
    createCollectionCoreInstanceState("agents"),
    "agents",
    { filters: [], search: "Claude", sort: [] },
  );
  useCollectionCoreSessionQueryState.setState({
    stateByInstanceKey: { [catalog.instanceKey]: stored },
  });

  expect(
    useCollectionCoreSessionQueryState.getState().stateByInstanceKey[
      catalog.instanceKey
    ],
  ).toBe(stored);
  expect(createCollectionCoreInstanceState()).toEqual(
    createCollectionCoreInstanceState(),
  );
  expect(
    createCollectionCoreInstanceState() === createCollectionCoreInstanceState(),
  ).toBe(false);
});

test("descriptor changes reset invalid query once and normalize active presentation", () => {
  const before = instance("space:root:context");
  const stored = setCollectionCorePresentationQuery(
    before,
    createCollectionCoreInstanceState("agents"),
    "agents",
    {
      filters: [{ propertyKey: "name", operator: "contains", value: "Claude" }],
      search: "Claude",
      sort: [{ direction: "asc", propertyKey: "name" }],
    },
  );
  const after = instance("space:root:context", [
    presentation("people", "plain"),
  ]);
  const normalized = normalizeCollectionCoreInstanceState(after, stored);

  expect(normalized.activePresentationId).toBe("people");
  expect("agents" in normalized.queryByPresentationId).toBe(false);

  const stalePeople = {
    ...normalized,
    queryByPresentationId: {
      people: {
        filters: [{ propertyKey: "removed", operator: "eq", value: "stale" }],
        search: "stale",
        sort: [{ direction: "asc" as const, propertyKey: "removed" }],
      },
    },
  };
  const reset = normalizeCollectionCoreInstanceState(after, stalePeople);
  expect(queryForCollectionCorePresentation(reset, "people")).toEqual({
    filters: [],
    search: "",
    sort: [],
  });
  expect(reset.resetWarningByPresentationId.people).toBe(true);
  expect(normalizeCollectionCoreInstanceState(after, reset)).toBe(reset);

  const warningWithoutQuery = normalizeCollectionCoreInstanceState(after, {
    activePresentationId: "missing",
    queryByPresentationId: {},
    resetWarningByPresentationId: { people: true },
  });
  expect(warningWithoutQuery.activePresentationId).toBe("people");
  expect(warningWithoutQuery.resetWarningByPresentationId.people).toBe(true);
});
