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

test("feature-owned contextual actions follow query controls and survive presentation switches", () => {
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
      />
    </TooltipProvider>,
  );

  const searchPosition = markup.indexOf('data-slot="input-group"');
  const contextualPosition = markup.indexOf("data-contextual-action");
  expect(searchPosition > -1).toBe(true);
  expect(contextualPosition > searchPosition).toBe(true);
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
      />
    </TooltipProvider>,
  );
  expect(switchedMarkup.includes("data-contextual-action")).toBe(true);
  expect(switchedMarkup.includes("Diagnostics")).toBe(true);
});
