import { expect, test } from "bun:test";

import { filePreferenceKey } from "./preference-key";

test("file preference is one slot per extension, case-insensitive", () => {
  expect(filePreferenceKey("docs/Guide.PDF")).toBe("file:pdf");
  expect(filePreferenceKey("docs\\guide.pdf")).toBe(filePreferenceKey("x.Pdf"));
  expect(filePreferenceKey("photo.png")).toBe("file:png");
  expect(filePreferenceKey("LICENSE")).toBe("file:");
  expect(filePreferenceKey("dir.v2/Makefile")).toBe("file:");
  expect(filePreferenceKey(".env")).toBe("file:");
});
