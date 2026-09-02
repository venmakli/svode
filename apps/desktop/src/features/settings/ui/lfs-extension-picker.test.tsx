import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LfsExtensionPicker } from "./lfs-extension-picker";

test("LFS extension picker summarizes the selection instead of exposing a raw list", () => {
  const markup = renderToStaticMarkup(
    <LfsExtensionPicker
      value="jpg, mp4, zip"
      onChange={() => undefined}
      disabled={false}
      invalid={false}
    />,
  );

  expect(markup.includes("Selected: 3")).toBe(true);
  expect(markup.includes("jpg, mp4, zip")).toBe(false);
  expect(markup.includes('id="storage-lfs-extensions"')).toBe(true);
  expect(markup.includes('id="storage-lfs-custom-extension"')).toBe(true);
});

test("LFS extension picker presents an empty searchable field", () => {
  const markup = renderToStaticMarkup(
    <LfsExtensionPicker
      value=""
      onChange={() => undefined}
      disabled={false}
      invalid={false}
    />,
  );

  expect(markup.includes('placeholder="Select or find a format…"')).toBe(true);
  expect(markup.includes("Selected: 0")).toBe(true);
});
