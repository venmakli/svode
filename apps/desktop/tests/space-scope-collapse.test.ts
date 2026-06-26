import { expect, test } from "bun:test";
import {
  getSpaceScopeActiveRevealKey,
  isSpaceScopeOpen,
} from "../src/features/space/hooks/use-space-scope-collapse";

test("space home selection does not create an active reveal target", () => {
  expect(
    getSpaceScopeActiveRevealKey({
      activeDocument: null,
      activeDocumentSpaceId: "root",
      activeRevealRequest: null,
      scopeId: "root",
    }),
  ).toBeNull();

  expect(
    getSpaceScopeActiveRevealKey({
      activeDocument: "README.md",
      activeDocumentSpaceId: "space-a",
      activeRevealRequest: null,
      scopeId: "space-a",
    }),
  ).toBeNull();
});

test("active reveal key is computed the same way for root and nested document routes", () => {
  expect(
    getSpaceScopeActiveRevealKey({
      activeDocument: "docs/note.md",
      activeDocumentSpaceId: "space-a",
      activeRevealRequest: {
        key: 1,
        path: "docs/note.md",
        spaceId: "space-a",
      },
      scopeId: "space-a",
    }),
  ).toBe("1:docs/note.md");

  expect(
    getSpaceScopeActiveRevealKey({
      activeDocument: "README.md",
      activeDocumentSpaceId: "space-a",
      activeRevealRequest: {
        key: 2,
        path: "README.md",
        spaceId: "space-a",
      },
      scopeId: "space-a",
    }),
  ).toBe("2:README.md");

  expect(
    getSpaceScopeActiveRevealKey({
      activeDocument: "docs/note.md",
      activeDocumentSpaceId: "space-a",
      activeRevealRequest: {
        key: 3,
        path: "docs/note.md",
        spaceId: "space-a",
      },
      scopeId: "root",
    }),
  ).toBeNull();
});

test("manual collapse hides only the current active reveal target", () => {
  expect(
    isSpaceScopeOpen({
      activeRevealKey: "docs/note.md",
      manuallyCollapsedRevealKey: null,
      manuallyOpened: false,
    }),
  ).toBe(true);

  expect(
    isSpaceScopeOpen({
      activeRevealKey: "docs/note.md",
      manuallyCollapsedRevealKey: "docs/note.md",
      manuallyOpened: false,
    }),
  ).toBe(false);

  expect(
    isSpaceScopeOpen({
      activeRevealKey: "docs/next.md",
      manuallyCollapsedRevealKey: "docs/note.md",
      manuallyOpened: false,
    }),
  ).toBe(true);

  expect(
    isSpaceScopeOpen({
      activeRevealKey: null,
      manuallyCollapsedRevealKey: null,
      manuallyOpened: true,
    }),
  ).toBe(true);
});
