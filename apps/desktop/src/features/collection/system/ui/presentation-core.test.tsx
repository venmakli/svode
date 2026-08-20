import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { defineSystemCollectionPresentation } from "../model/runtime";
import type { SystemCollectionStateController } from "../hooks/use-system-collection-state";
import { SystemCollectionPresentationCore } from "./presentation-core";

interface Row {
  id: string;
  name: string;
}

test("feature-owned actions keep their positions and survive presentation switches", () => {
  const presentation = defineSystemCollectionPresentation<Row>({
    descriptor: {
      fields: [],
      getRowId: (row) => row.id,
      id: "people",
      label: "People",
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleFields: [],
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
      defineSystemCollectionPresentation<Row>({
        descriptor: {
          fields: [],
          getRowId: (row) => row.id,
          id: "teams",
          label: "Teams",
          layout: {
            getTitle: (row) => row.name,
            kind: "list",
            visibleFields: [],
          },
          query: {},
        },
        state: { phase: "ready", rows: [] },
      }),
    ],
    stateScope: "lifecycle" as const,
  };
  const state: Extract<SystemCollectionStateController, { phase: "ready" }> = {
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
      <SystemCollectionPresentationCore
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
    'data-system-collection-create="add-person"',
  );
  const trailingPosition = markup.indexOf("data-trailing-action");
  expect(searchPosition > -1).toBe(true);
  expect(contextualPosition > searchPosition).toBe(true);
  expect(createPosition > contextualPosition).toBe(true);
  expect(trailingPosition > createPosition).toBe(true);
  expect(markup.match(/data-collection-presentation-toolbar/g)?.length).toBe(1);

  const switchedMarkup = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationCore
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
