import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LfsExtensionPicker,
  selectedLfsExtensionCount,
} from "./lfs-extension-picker";

test("LFS extension picker exposes selection at group and total levels", () => {
  const markup = renderToStaticMarkup(
    <LfsExtensionPicker
      value="jpg, mp4, zip"
      onChange={() => undefined}
      disabled={false}
      invalid={false}
    />,
  );

  expect(selectedLfsExtensionCount("jpg, mp4, zip")).toBe(3);
  expect(selectedLfsExtensionCount(".JPG, jpg, blend")).toBe(2);
  expect(markup.includes("Images")).toBe(true);
  expect(markup.includes("1 of 9")).toBe(true);
  expect(markup.includes("1 of 6")).toBe(true);
  expect(markup.includes("1 of 3")).toBe(true);
  expect(/id="[^"]*-group-images"/.test(markup)).toBe(true);
  expect(markup.includes('data-slot="combobox"')).toBe(false);
  // Format groups sit in the settings row without cards of their own.
  expect(markup.includes("border-border")).toBe(false);
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

  expect(selectedLfsExtensionCount("blend")).toBe(1);
  expect(markup.includes(".blend")).toBe(true);
  expect(markup.includes('aria-label="Remove .blend"')).toBe(true);
  expect(/id="[^"]*-custom-extension"/.test(markup)).toBe(true);
});
