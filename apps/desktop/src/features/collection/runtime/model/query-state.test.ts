import { expect, test } from "bun:test";

import { defineCollectionPresentation } from "./runtime";
import {
  createCollectionInstanceState,
  normalizeCollectionInstanceState,
  queryForCollectionPresentation,
  setCollectionPresentationQuery,
  useCollectionSessionQueryState,
} from "./query-state";
import type {
  CollectionInstance,
  CollectionPresentationRuntime,
} from "./types";

interface Row {
  id: string;
  name: string;
}

function presentation(
  id: string,
  properties: "searchable" | "plain" = "searchable",
): CollectionPresentationRuntime {
  return defineCollectionPresentation<Row>({
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
): CollectionInstance {
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
  let actorsState = createCollectionInstanceState();
  let projectState = createCollectionInstanceState();

  actorsState = setCollectionPresentationQuery(actors, actorsState, "people", {
    filters: [],
    search: "Ilya",
    sort: [],
  });
  actorsState = setCollectionPresentationQuery(actors, actorsState, "agents", {
    filters: [],
    search: "Codex",
    sort: [],
  });
  projectState = setCollectionPresentationQuery(
    projectActors,
    projectState,
    "people",
    { filters: [], search: "Project", sort: [] },
  );

  expect(queryForCollectionPresentation(actorsState, "people").search).toBe(
    "Ilya",
  );
  expect(queryForCollectionPresentation(actorsState, "agents").search).toBe(
    "Codex",
  );
  expect(queryForCollectionPresentation(projectState, "people").search).toBe(
    "Project",
  );
});

test("session store restores state while independent lifecycle state starts empty", () => {
  const catalog = instance("space:root:actors");
  const stored = setCollectionPresentationQuery(
    catalog,
    createCollectionInstanceState("agents"),
    "agents",
    { filters: [], search: "Claude", sort: [] },
  );
  useCollectionSessionQueryState.setState({
    stateByInstanceKey: { [catalog.instanceKey]: stored },
  });

  expect(
    useCollectionSessionQueryState.getState().stateByInstanceKey[
      catalog.instanceKey
    ],
  ).toBe(stored);
  expect(createCollectionInstanceState()).toEqual(
    createCollectionInstanceState(),
  );
  expect(
    createCollectionInstanceState() === createCollectionInstanceState(),
  ).toBe(false);
});

test("descriptor changes reset invalid query once and normalize active presentation", () => {
  const before = instance("space:root:context");
  const stored = setCollectionPresentationQuery(
    before,
    createCollectionInstanceState("agents"),
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
  const normalized = normalizeCollectionInstanceState(after, stored);

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
  const reset = normalizeCollectionInstanceState(after, stalePeople);
  expect(queryForCollectionPresentation(reset, "people")).toEqual({
    filters: [],
    search: "",
    sort: [],
  });
  expect(reset.resetWarningByPresentationId.people).toBe(true);
  expect(normalizeCollectionInstanceState(after, reset)).toBe(reset);

  const warningWithoutQuery = normalizeCollectionInstanceState(after, {
    activePresentationId: "missing",
    queryByPresentationId: {},
    resetWarningByPresentationId: { people: true },
  });
  expect(warningWithoutQuery.activePresentationId).toBe("people");
  expect(warningWithoutQuery.resetWarningByPresentationId.people).toBe(true);
});
