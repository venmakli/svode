import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CollectionCardsShell,
  CollectionCardsSkeleton,
  CollectionCardShell,
  CollectionListRowShell,
  CollectionListSkeleton,
} from "./presentation-layout";

test("list shells preserve compact and comfortable collection geometry", () => {
  const compact = renderToStaticMarkup(
    <CollectionListRowShell density="compact">Row</CollectionListRowShell>,
  );
  const comfortable = renderToStaticMarkup(
    <CollectionListRowShell density="comfortable" selected>
      Row
    </CollectionListRowShell>,
  );

  expect(compact.includes("min-h-10")).toBe(true);
  expect(compact.includes("min-h-[52px]")).toBe(false);
  expect(comfortable.includes("min-h-[52px]")).toBe(true);
  expect(comfortable.includes("bg-muted/50")).toBe(true);
});

test("list skeleton keeps extracted density geometry", () => {
  const compact = renderToStaticMarkup(
    <CollectionListSkeleton density="compact" />,
  );
  const comfortable = renderToStaticMarkup(
    <CollectionListSkeleton density="comfortable" />,
  );

  expect(compact.match(/data-slot="skeleton"/g)?.length).toBe(32);
  expect(comfortable.match(/data-slot="skeleton"/g)?.length).toBe(40);
});

test("card shells preserve responsive grid and selected card geometry", () => {
  const grid = renderToStaticMarkup(
    <CollectionCardsShell cardWidth={224}>Cards</CollectionCardsShell>,
  );
  const card = renderToStaticMarkup(
    <CollectionCardShell selected>Card</CollectionCardShell>,
  );
  const skeleton = renderToStaticMarkup(
    <CollectionCardsSkeleton cardWidth={224} />,
  );

  expect(grid.includes("repeat(auto-fill, minmax(224px, 1fr))")).toBe(true);
  expect(card.includes("ring-2 ring-ring/50")).toBe(true);
  expect(skeleton.match(/data-slot="skeleton"/g)?.length).toBe(40);
});
