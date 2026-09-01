import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { defineCollectionPresentation } from "../model/runtime";
import type { CollectionStateController } from "../hooks/use-collection-state";
import { CollectionHost } from "./collection-host";

interface Row {
  id: string;
  name: string;
}

test("feature-owned actions keep their positions and survive presentation switches", () => {
  const presentation = defineCollectionPresentation<Row>({
    descriptor: {
      properties: [],
      getRowId: (row) => row.id,
      id: "people",
      label: "People",
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleProperties: [],
      },
      query: { getSearchText: (row) => row.name },
      create: {
        label: "Add",
        intents: [
          {
            getState: () => ({ status: "idle" }),
            id: "add-person",
            label: "Add",
            run: () => undefined,
          },
        ],
      },
    },
    state: { phase: "ready", rows: [{ id: "ada", name: "Ada" }] },
  });
  const instance = {
    defaultPresentationId: "people",
    instanceKey: "people:test",
    presentations: [
      presentation,
      defineCollectionPresentation<Row>({
        descriptor: {
          properties: [],
          getRowId: (row) => row.id,
          id: "teams",
          label: "Teams",
          layout: {
            getTitle: (row) => row.name,
            kind: "list",
            visibleProperties: [],
          },
          query: {},
        },
        state: { phase: "ready", rows: [] },
      }),
    ],
    stateScope: "lifecycle" as const,
  };
  const state: Extract<CollectionStateController, { phase: "ready" }> = {
    activePresentationId: "people",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: { filters: [], search: "", sort: [] },
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionHost
        contextualActions={
          <button type="button" data-contextual-action>
            Diagnostics
          </button>
        }
        instance={instance}
        state={state}
        trailingActions={
          <button type="button" data-trailing-action>
            Authority
          </button>
        }
      />
    </TooltipProvider>,
  );

  const searchPosition = markup.indexOf('data-slot="input-group"');
  const contextualPosition = markup.indexOf("data-contextual-action");
  const createPosition = markup.indexOf('data-collection-create="add-person"');
  const trailingPosition = markup.indexOf("data-trailing-action");
  expect(searchPosition > -1).toBe(true);
  expect(contextualPosition > searchPosition).toBe(true);
  expect(createPosition > contextualPosition).toBe(true);
  expect(trailingPosition > createPosition).toBe(true);
  expect(markup.match(/data-collection-presentation-toolbar/g)?.length).toBe(1);

  const switchedMarkup = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionHost
        contextualActions={
          <button type="button" data-contextual-action>
            Diagnostics
          </button>
        }
        instance={instance}
        state={{ ...state, activePresentationId: "teams" }}
        trailingActions={
          <button type="button" data-trailing-action>
            Authority
          </button>
        }
      />
    </TooltipProvider>,
  );
  expect(switchedMarkup.includes("data-contextual-action")).toBe(true);
  expect(switchedMarkup.includes("Diagnostics")).toBe(true);
  expect(switchedMarkup.includes("data-trailing-action")).toBe(true);
  expect(switchedMarkup.includes("Authority")).toBe(true);
});

test("create capability hides zero intents and groups multiple owner intents", () => {
  const createPresentation = (intents: "zero" | "many") =>
    defineCollectionPresentation<Row>({
      descriptor: {
        create: {
          label: "Add attachment",
          intents:
            intents === "zero"
              ? []
              : [
                  {
                    getState: () => ({ status: "idle" }),
                    id: "upload-file",
                    label: "Upload file",
                    run: () => undefined,
                  },
                  {
                    getState: () => ({ status: "idle" }),
                    id: "create-document",
                    label: "Create document",
                    run: () => undefined,
                  },
                ],
        },
        getRowId: (row) => row.id,
        id: intents,
        label: intents,
        layout: {
          getTitle: (row) => row.name,
          kind: "list",
          visibleProperties: [],
        },
        properties: [],
        query: {},
      },
      state: { phase: "ready", rows: [] },
    });
  const state: Extract<CollectionStateController, { phase: "ready" }> = {
    activePresentationId: "zero",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: { filters: [], search: "", sort: [] },
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const instance = {
    defaultPresentationId: "zero",
    instanceKey: "create:test",
    presentations: [createPresentation("zero"), createPresentation("many")],
    stateScope: "session" as const,
  };
  const zeroMarkup = renderToStaticMarkup(
    <CollectionHost instance={instance} state={state} />,
  );
  const manyMarkup = renderToStaticMarkup(
    <CollectionHost
      instance={instance}
      state={{ ...state, activePresentationId: "many" }}
    />,
  );

  expect(zeroMarkup.includes("data-collection-create")).toBe(false);
  expect(manyMarkup.includes("data-collection-create-menu")).toBe(true);
  expect(manyMarkup.includes("Add attachment")).toBe(true);
  expect(manyMarkup.includes('data-collection-create="upload-file"')).toBe(
    false,
  );
});
