import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { defineCollectionCorePresentation } from "../model/runtime";
import { CollectionCoreQueryEditor } from "./query-editor";

interface Row {
  id: string;
  name: string;
}

function presentation({
  filterable = false,
  searchable = false,
}: {
  filterable?: boolean;
  searchable?: boolean;
}) {
  return defineCollectionCorePresentation<Row>({
    descriptor: {
      properties: [
        {
          capabilities: filterable
            ? { filter: { kind: "standard" as const } }
            : undefined,
          getValue: (row) => row.name,
          key: "name",
          label: "Name",
          origin: "owner_defined",
          owner: { featureId: "query-editor-test", kind: "feature" },
          semantics: { kind: "standard", standard: { type: "text" } },
        },
      ],
      getRowId: (row) => row.id,
      id: "people",
      label: "People",
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleProperties: [],
      },
      query: searchable ? { getSearchText: (row) => row.name } : {},
    },
    state: { phase: "ready", rows: [] },
  });
}

test("query editor exposes only declared query controls", () => {
  const searchable = renderToStaticMarkup(
    <CollectionCoreQueryEditor
      presentation={presentation({ searchable: true })}
      value={{ filters: [], search: "Ada", sort: [] }}
      onChange={() => undefined}
    />,
  );
  const unsupported = renderToStaticMarkup(
    <CollectionCoreQueryEditor
      presentation={presentation({})}
      value={{ filters: [], search: "", sort: [] }}
      onChange={() => undefined}
    />,
  );

  expect(searchable.includes('value="Ada"')).toBe(true);
  expect(searchable.includes("View settings")).toBe(false);
  expect(unsupported).toBe("");
});

test("query reset warning remains a visible non-blocking control", () => {
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionCoreQueryEditor
        presentation={presentation({ filterable: true })}
        resetWarning
        value={{ filters: [], search: "", sort: [] }}
        onChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(markup.includes("Filter")).toBe(true);
  expect(markup.includes("View settings")).toBe(false);
});
