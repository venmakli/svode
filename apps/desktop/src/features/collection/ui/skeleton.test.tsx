import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CollectionSkeleton } from "./skeleton";

test("mirrors the collection toolbar and content without duplicate owner chrome", () => {
  const markup = renderToStaticMarkup(<CollectionSkeleton />);

  expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(26);
  expect(markup.includes("min-h-[320px]")).toBe(true);
  expect(markup.includes("px-6 py-2")).toBe(true);
  expect(markup.includes("px-6 pb-4 pt-3")).toBe(true);
  expect(markup.includes("h-10 w-72")).toBe(false);
});
