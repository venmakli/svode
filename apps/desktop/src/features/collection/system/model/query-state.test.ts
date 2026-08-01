import { expect, test } from "bun:test";

import { defineSystemCollectionPresentation } from "./runtime";
import {
  createSystemCollectionInstanceState,
  normalizeSystemCollectionInstanceState,
  queryForSystemCollectionPresentation,
  setSystemCollectionPresentationQuery,
  useSystemCollectionSessionQueryState,
} from "./query-state";
import type {
  SystemCollectionInstance,
  SystemCollectionPresentationRuntime,
} from "./types";

interface Row {
  id: string;
  name: string;
}

function presentation(
  id: string,
  fields: "searchable" | "plain" = "searchable",
): SystemCollectionPresentationRuntime {
  return defineSystemCollectionPresentation<Row>({
    descriptor: {
      fields: [
        {
          filter: { kind: "property" },
          getValue: (row) => row.name,
          key: "name",
          label: "Name",
          sort: { kind: "property" },
          valueSemantics: {
            column: { name: "Name", type: "text" },
            kind: "property",
          },
        },
      ],
      getRowId: (row) => row.id,
      id,
      label: id,
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleFields: [],
      },
      query:
        fields === "searchable" ? { getSearchText: (row) => row.name } : {},
    },
    state: { phase: "ready", rows: [] },
  });
}

function instance(
  instanceKey: string,
  presentations = [presentation("people"), presentation("agents")],
): SystemCollectionInstance {
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
  let actorsState = createSystemCollectionInstanceState();
  let projectState = createSystemCollectionInstanceState();

  actorsState = setSystemCollectionPresentationQuery(
    actors,
    actorsState,
    "people",
    { filters: [], search: "Ilya", sort: [] },
  );
  actorsState = setSystemCollectionPresentationQuery(
    actors,
    actorsState,
    "agents",
    { filters: [], search: "Codex", sort: [] },
  );
  projectState = setSystemCollectionPresentationQuery(
    projectActors,
    projectState,
    "people",
    { filters: [], search: "Project", sort: [] },
  );

  expect(
    queryForSystemCollectionPresentation(actorsState, "people").search,
  ).toBe("Ilya");
  expect(
    queryForSystemCollectionPresentation(actorsState, "agents").search,
  ).toBe("Codex");
  expect(
    queryForSystemCollectionPresentation(projectState, "people").search,
  ).toBe("Project");
});

test("session store restores state while independent lifecycle state starts empty", () => {
  const catalog = instance("space:root:actors");
  const stored = setSystemCollectionPresentationQuery(
    catalog,
    createSystemCollectionInstanceState("agents"),
    "agents",
    { filters: [], search: "Claude", sort: [] },
  );
  useSystemCollectionSessionQueryState.setState({
    stateByInstanceKey: { [catalog.instanceKey]: stored },
  });

  expect(
    useSystemCollectionSessionQueryState.getState().stateByInstanceKey[
      catalog.instanceKey
    ],
  ).toBe(stored);
  expect(createSystemCollectionInstanceState()).toEqual(
    createSystemCollectionInstanceState(),
  );
  expect(
    createSystemCollectionInstanceState() ===
      createSystemCollectionInstanceState(),
  ).toBe(false);
});

test("descriptor changes reset invalid query once and normalize active presentation", () => {
  const before = instance("space:root:context");
  const stored = setSystemCollectionPresentationQuery(
    before,
    createSystemCollectionInstanceState("agents"),
    "agents",
    {
      filters: [{ fieldKey: "name", operator: "contains", value: "Claude" }],
      search: "Claude",
      sort: [{ direction: "asc", fieldKey: "name" }],
    },
  );
  const after = instance("space:root:context", [
    presentation("people", "plain"),
  ]);
  const normalized = normalizeSystemCollectionInstanceState(after, stored);

  expect(normalized.activePresentationId).toBe("people");
  expect("agents" in normalized.queryByPresentationId).toBe(false);

  const stalePeople = {
    ...normalized,
    queryByPresentationId: {
      people: {
        filters: [{ fieldKey: "removed", operator: "eq", value: "stale" }],
        search: "stale",
        sort: [{ direction: "asc" as const, fieldKey: "removed" }],
      },
    },
  };
  const reset = normalizeSystemCollectionInstanceState(after, stalePeople);
  expect(queryForSystemCollectionPresentation(reset, "people")).toEqual({
    filters: [],
    search: "",
    sort: [],
  });
  expect(reset.resetWarningByPresentationId.people).toBe(true);
  expect(normalizeSystemCollectionInstanceState(after, reset)).toBe(reset);

  const warningWithoutQuery = normalizeSystemCollectionInstanceState(after, {
    activePresentationId: "missing",
    queryByPresentationId: {},
    resetWarningByPresentationId: { people: true },
  });
  expect(warningWithoutQuery.activePresentationId).toBe("people");
  expect(warningWithoutQuery.resetWarningByPresentationId.people).toBe(true);
});
