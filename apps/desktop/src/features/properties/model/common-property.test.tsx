import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { setLocale } from "@/paraglide/runtime";

import { CollectionPropertyPanel } from "../ui/collection-property-panel";
import { CollectionPropertyValue } from "../ui/collection-property-value";
import { defineStateCollectionProperty } from "../ui/state-property";
import {
  resolveStandardPropertyColumn,
  type CollectionPropertyDefinition,
} from "./collection-property";
import {
  commonCollectionPropertyLabel,
  defineSpaceCollectionProperty,
  defineTitleCollectionProperty,
  defineUpdatedCollectionProperty,
} from "./common-property";
import {
  matchesStandardPropertyFilter,
  standardPropertyFilterOperators,
} from "./standard-query";

setLocale("en", { reload: false });

interface Routine {
  name: string;
  changedAt: string;
  space: string;
  problems: string[];
}

interface Session {
  title: string;
  lastActivityAt: string;
  owner: string;
}

/** What a Collection may not set itself for a common property. */
function contract<Item>(property: CollectionPropertyDefinition<Item>) {
  const column = resolveStandardPropertyColumn(property);
  return {
    capabilities: property.capabilities,
    common: property.common,
    display: column?.display,
    key: property.key,
    label: property.label,
    operators: standardPropertyFilterOperators(property),
    origin: property.origin,
    owner: property.owner,
    type: column?.type,
  };
}

test("a common property is the same in every Collection: key, label, type, display and operators", () => {
  const routines = [
    defineTitleCollectionProperty<Routine>({ getValue: (item) => item.name }),
    defineUpdatedCollectionProperty<Routine>({
      getValue: (item) => item.changedAt,
    }),
    defineSpaceCollectionProperty<Routine>({
      getValue: (item) => item.space,
      items: [],
    }),
  ];
  const sessions = [
    defineTitleCollectionProperty<Session>({ getValue: (item) => item.title }),
    defineUpdatedCollectionProperty<Session>({
      getValue: (item) => item.lastActivityAt,
    }),
    defineSpaceCollectionProperty<Session>({
      getValue: (item) => item.owner,
      items: [],
    }),
  ];
  expect<unknown>(routines.map(contract)).toEqual(sessions.map(contract));
  expect(routines.map(contract)).toEqual([
    {
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      common: "title",
      display: undefined,
      key: "title",
      label: "Name",
      operators: [
        "contains",
        "eq",
        "neq",
        "not_contains",
        "is_empty",
        "is_not_empty",
      ],
      origin: "computed",
      owner: { featureId: "properties", kind: "feature" },
      type: "text",
    },
    {
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      common: "updated",
      display: "medium",
      // The storage key of Pages stays `updated`.
      key: "updated",
      label: "Modified",
      operators: ["eq", "neq", "before", "after", "is_empty", "is_not_empty"],
      origin: "computed",
      owner: { featureId: "properties", kind: "feature" },
      type: "date",
    },
    {
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      common: "space",
      display: undefined,
      key: "space",
      label: "Space",
      operators: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
      origin: "computed",
      owner: { featureId: "properties", kind: "feature" },
      type: "select",
    },
  ]);
  expect(
    contract(
      defineTitleCollectionProperty<Routine>({
        getValue: (item) => item.name,
        label: "Task",
      }),
    ).label,
  ).toBe("Task");
});

test("the labels follow the locale", async () => {
  try {
    await setLocale("ru", { reload: false });
    expect(
      (["title", "updated", "agent", "agents", "state", "space"] as const).map(
        commonCollectionPropertyLabel,
      ),
    ).toEqual([
      "Название",
      "Изменено",
      "Агент",
      "Агенты",
      "Состояние",
      "Пространство",
    ]);
  } finally {
    await setLocale("en", { reload: false });
  }
});

test("Space offers the Spaces of the set by name", () => {
  const space = defineSpaceCollectionProperty<Routine>({
    getValue: (item) => item.space,
    items: [
      { changedAt: "", name: "a", problems: [], space: "Docs" },
      { changedAt: "", name: "b", problems: [], space: "Project" },
      { changedAt: "", name: "c", problems: [], space: "Docs" },
    ],
  });
  expect(resolveStandardPropertyColumn(space)?.options).toEqual([
    { color: "neutral", name: "Docs" },
    { color: "neutral", name: "Project" },
  ]);
});

test("Status: empty when normal, Has problems with its reasons on hover and in the panel; the filter offers Normal and Has problems", () => {
  const state = defineStateCollectionProperty<Routine>({
    getProblems: (item) => item.problems,
  });
  const normal: Routine = {
    changedAt: "",
    name: "Daily",
    problems: [],
    space: "Docs",
  };
  const broken: Routine = {
    ...normal,
    name: "Broken",
    problems: ["trigger is invalid", "executor is unknown"],
  };
  const render = (item: Routine, context?: "detail") =>
    renderToStaticMarkup(
      <TooltipProvider>
        <CollectionPropertyValue
          context={context}
          property={state as CollectionPropertyDefinition<unknown>}
          item={item}
        />
      </TooltipProvider>,
    );

  expect(contract(state)).toEqual({
    capabilities: { filter: { kind: "standard" }, sort: { kind: "standard" } },
    common: "state",
    display: undefined,
    key: "state",
    label: "Status",
    operators: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
    origin: "computed",
    owner: { featureId: "properties", kind: "feature" },
    type: "select",
  });
  expect(
    resolveStandardPropertyColumn(state)?.options?.map((option) => option.name),
  ).toEqual(["Normal", "Has problems"]);
  expect(render(normal)).toBe("");
  const cell = render(broken);
  expect(cell.includes("Has problems")).toBe(true);
  expect(cell.includes("trigger is invalid · executor is unknown")).toBe(true);
  // Reason codes never reach the interface: only the texts.
  const detail = render(broken, "detail");
  expect(detail.match(/<li/g)?.length).toBe(2);
  expect(
    [normal, broken].map((item) =>
      matchesStandardPropertyFilter(state, item, {
        operator: "eq",
        value: "Normal",
      }),
    ),
  ).toEqual([true, false]);
  expect(
    [normal, broken].map((item) =>
      matchesStandardPropertyFilter(state, item, {
        operator: "eq",
        value: "Has problems",
      }),
    ),
  ).toEqual([false, true]);
});

test("the property panel does not repeat Name and shows Status only with problems", () => {
  const properties = [
    defineTitleCollectionProperty<Routine>({ getValue: (item) => item.name }),
    defineSpaceCollectionProperty<Routine>({
      getValue: (item) => item.space,
      items: [],
    }),
    defineStateCollectionProperty<Routine>({
      getProblems: (item) => item.problems,
    }),
  ];
  const panel = (item: Routine) =>
    [
      ...renderToStaticMarkup(
        <TooltipProvider>
          <CollectionPropertyPanel item={item} properties={properties} />
        </TooltipProvider>,
      ).matchAll(/data-collection-panel-property="([^"]+)"/g),
    ].map((match) => match[1]);
  const routine: Routine = {
    changedAt: "",
    name: "Daily",
    problems: [],
    space: "Docs",
  };
  expect(panel(routine)).toEqual(["space"]);
  expect(panel({ ...routine, problems: ["trigger is invalid"] })).toEqual([
    "space",
    "state",
  ]);
});
