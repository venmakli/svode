import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineSystemCollectionPresentation } from "../model/runtime";
import { SystemCollectionQueryEditor } from "./query-editor";

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
  return defineSystemCollectionPresentation<Row>({
    descriptor: {
      fields: [
        {
          filter: filterable ? { kind: "property" as const } : undefined,
          getValue: (row) => row.name,
          key: "name",
          label: "Name",
          valueSemantics: {
            column: { name: "Name", type: "text" },
            kind: "property",
          },
        },
      ],
      getRowId: (row) => row.id,
      id: "people",
      label: "People",
      query: searchable ? { getSearchText: (row) => row.name } : {},
      renderer: "list",
      renderRowContent: (row) => row.name,
    },
    state: { phase: "ready", rows: [] },
  });
}

test("query editor exposes only declared query controls", () => {
  const searchable = renderToStaticMarkup(
    <SystemCollectionQueryEditor
      presentation={presentation({ searchable: true })}
      value={{ filters: [], search: "Ada", sort: [] }}
      onChange={() => undefined}
    />,
  );
  const unsupported = renderToStaticMarkup(
    <SystemCollectionQueryEditor
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
    <SystemCollectionQueryEditor
      presentation={presentation({ filterable: true })}
      resetWarning
      value={{ filters: [], search: "", sort: [] }}
      onChange={() => undefined}
    />,
  );

  expect(markup.includes('aria-label="View settings"')).toBe(true);
  expect(markup.includes('data-variant="secondary"')).toBe(true);
});
