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
    <CollectionCardsShell cardWidth={240}>Cards</CollectionCardsShell>,
  );
  const card = renderToStaticMarkup(
    <CollectionCardShell selected>Card</CollectionCardShell>,
  );
  const skeleton = renderToStaticMarkup(
    <CollectionCardsSkeleton cardWidth={224} />,
  );
  const coverlessSkeleton = renderToStaticMarkup(
    <CollectionCardsSkeleton
      cardWidth={240}
      density="compact"
      hasCover={false}
    />,
  );

  expect(grid.includes("repeat(auto-fill, minmax(240px, 1fr))")).toBe(true);
  expect(grid.includes("max-width")).toBe(false);
  expect(card.includes("ring-2 ring-ring/50")).toBe(true);
  expect(skeleton.match(/data-slot="skeleton"/g)?.length).toBe(40);
  expect(coverlessSkeleton.match(/data-slot="skeleton"/g)?.length).toBe(32);
  expect(coverlessSkeleton.includes("aspect-video")).toBe(false);
  expect(
    coverlessSkeleton.includes("repeat(auto-fill, minmax(240px, 1fr))"),
  ).toBe(true);
  expect(coverlessSkeleton.includes("max-width")).toBe(false);
  expect(coverlessSkeleton.includes('data-size="sm"')).toBe(true);
});
