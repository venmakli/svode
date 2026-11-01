import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineCollectionPresentation } from "../model/runtime";
import { CollectionFixedTabs } from "./fixed-presentation-tabs";

interface Item {
  id: string;
}

function presentation(id: string, label: string) {
  return defineCollectionPresentation<Item>({
    descriptor: {
      properties: [],
      getItemId: (item) => item.id,
      id,
      label,
      layout: {
        getTitle: (item) => item.id,
        kind: "list",
        visibleProperties: [],
      },
      query: {},
    },
    state: {
      phase: "ready",
      items: [],
    },
  });
}

test("fixed presentation tabs render labels without mutation controls", () => {
  const markup = renderToStaticMarkup(
    <CollectionFixedTabs
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
  expect(markup.includes("data-collection-presentation")).toBe(true);
  expect(markup.includes("dropdown-menu")).toBe(false);
});

test("fixed presentation tabs remain visible for one presentation", () => {
  const markup = renderToStaticMarkup(
    <CollectionFixedTabs
      presentations={[presentation("contributors", "Contributors")]}
      value="contributors"
      onValueChange={() => undefined}
    />,
  );

  expect(markup.includes("Contributors")).toBe(true);
  expect(markup.includes('data-collection-presentation="contributors"')).toBe(
    true,
  );
  expect(markup.includes("scrollbar-hide")).toBe(true);
  expect(markup.includes("overflow-y-hidden")).toBe(true);
});
