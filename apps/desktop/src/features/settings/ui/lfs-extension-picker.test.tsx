import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LfsExtensionPicker } from "./lfs-extension-picker";

test("LFS extension picker exposes selection at group and total levels", () => {
  const markup = renderToStaticMarkup(
    <LfsExtensionPicker
      value="jpg, mp4, zip"
      onChange={() => undefined}
      disabled={false}
      invalid={false}
    />,
  );

  expect(markup.includes("Selected: 3")).toBe(true);
  expect(markup.includes("Images")).toBe(true);
  expect(markup.includes("1 of 9")).toBe(true);
  expect(markup.includes("1 of 6")).toBe(true);
  expect(markup.includes("1 of 3")).toBe(true);
  expect(markup.includes('id="storage-lfs-group-images"')).toBe(true);
  expect(markup.includes('data-slot="combobox"')).toBe(false);
});

test("LFS extension picker keeps custom selections visible and removable", () => {
  const markup = renderToStaticMarkup(
    <LfsExtensionPicker
      value="blend"
      onChange={() => undefined}
      disabled={false}
      invalid={false}
    />,
  );

  expect(markup.includes("Selected: 1")).toBe(true);
  expect(markup.includes(".blend")).toBe(true);
  expect(markup.includes('aria-label="Remove .blend"')).toBe(true);
  expect(markup.includes('id="storage-lfs-custom-extension"')).toBe(true);
});
