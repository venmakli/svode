import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { defineCollectionCorePresentation } from "../model/runtime";
import type { CollectionCoreStateController } from "../hooks/use-collection-core-state";
import { CollectionCorePresentationCore } from "./presentation-core";

interface Row {
  id: string;
  name: string;
}

test("feature-owned actions keep their positions and survive presentation switches", () => {
  const presentation = defineCollectionCorePresentation<Row>({
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
        getState: () => ({ status: "idle" }),
        id: "add-person",
        label: "Add",
        run: () => undefined,
      },
    },
    state: { phase: "ready", rows: [{ id: "ada", name: "Ada" }] },
  });
  const instance = {
    defaultPresentationId: "people",
    instanceKey: "people:test",
    presentations: [
      presentation,
      defineCollectionCorePresentation<Row>({
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
  const state: Extract<CollectionCoreStateController, { phase: "ready" }> = {
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
      <CollectionCorePresentationCore
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
  const createPosition = markup.indexOf(
    'data-collection-core-create="add-person"',
  );
  const trailingPosition = markup.indexOf("data-trailing-action");
  expect(searchPosition > -1).toBe(true);
  expect(contextualPosition > searchPosition).toBe(true);
  expect(createPosition > contextualPosition).toBe(true);
  expect(trailingPosition > createPosition).toBe(true);
  expect(markup.match(/data-collection-presentation-toolbar/g)?.length).toBe(1);

  const switchedMarkup = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionCorePresentationCore
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
