import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineSystemCollectionPresentation } from "../model/runtime";
import { SystemCollectionFixedTabs } from "./fixed-presentation-tabs";

interface Row {
  id: string;
}

function presentation(id: string, label: string) {
  return defineSystemCollectionPresentation<Row>({
    descriptor: {
      fields: [],
      getRowId: (row) => row.id,
      id,
      label,
      query: {},
      renderer: "list",
      renderRowContent: (row) => row.id,
    },
    state: {
      phase: "ready",
      rows: [],
    },
  });
}

test("fixed presentation tabs render labels without mutation controls", () => {
  const markup = renderToStaticMarkup(
    <SystemCollectionFixedTabs
      presentations={[
        presentation("contributors", "Contributors"),
        presentation("agents", "Agents"),
      ]}
      value="contributors"
      onValueChange={() => undefined}
    />,
  );

  expect(markup.includes("Contributors")).toBe(true);
  expect(markup.includes("Agents")).toBe(true);
  expect(markup.includes("data-system-collection-presentation")).toBe(true);
  expect(markup.includes("dropdown-menu")).toBe(false);
});

test("fixed presentation tabs stay hidden for one presentation", () => {
  const markup = renderToStaticMarkup(
    <SystemCollectionFixedTabs
      presentations={[presentation("contributors", "Contributors")]}
      value="contributors"
      onValueChange={() => undefined}
    />,
  );

  expect(markup).toBe("");
});
