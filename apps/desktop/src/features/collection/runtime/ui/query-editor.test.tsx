import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { defineCollectionPresentation } from "../model/runtime";
import { CollectionQueryEditor } from "./query-editor";

interface Item {
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
  return defineCollectionPresentation<Item>({
    descriptor: {
      properties: [
        {
          capabilities: filterable
            ? { filter: { kind: "standard" as const } }
            : undefined,
          getValue: (item) => item.name,
          key: "name",
          label: "Name",
          origin: "owner_defined",
          owner: { featureId: "query-editor-test", kind: "feature" },
          semantics: { kind: "standard", standard: { type: "text" } },
        },
      ],
      getItemId: (item) => item.id,
      id: "people",
      label: "People",
      layout: {
        getTitle: (item) => item.name,
        kind: "list",
        visibleProperties: [],
      },
      query: searchable ? { getSearchText: (item) => item.name } : {},
    },
    state: { phase: "ready", items: [] },
  });
}

test("query editor exposes only declared query controls", () => {
  const searchable = renderToStaticMarkup(
    <CollectionQueryEditor
      presentation={presentation({ searchable: true })}
      value={{ filters: [], search: "Ada", sort: [] }}
      onChange={() => undefined}
    />,
  );
  const unsupported = renderToStaticMarkup(
    <CollectionQueryEditor
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
      <CollectionQueryEditor
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
