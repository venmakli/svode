import { expect, test } from "bun:test";

import {
  folderFromUrl,
  normalizeFolderNameInput,
  resolveFolderName,
} from "./space-folder-rules";

test("resolveFolderName accepts one ASCII-friendly segment", () => {
  expect(resolveFolderName("support")).toBe("support");
  expect(resolveFolderName("Ops_2026-support-v2")).toBe("Ops_2026-support-v2");
});

test("resolveFolderName rejects paths and unsafe names without sanitizing input", () => {
  expect(resolveFolderName("")).toBeNull();
  expect(resolveFolderName("testov/support")).toBeNull();
  expect(resolveFolderName("testov\\support")).toBeNull();
  expect(resolveFolderName("../support")).toBeNull();
  expect(resolveFolderName("/support")).toBeNull();
  expect(resolveFolderName("C:/support")).toBeNull();
  expect(resolveFolderName("поддержка")).toBeNull();
});

test("normalizeFolderNameInput only trims input", () => {
  expect(normalizeFolderNameInput(" support ")).toBe("support");
});

test("folderFromUrl preserves underscores in repository folder names", () => {
  expect(folderFromUrl("https://github.com/org/support_tools.git")).toBe(
    "support_tools",
  );
});
