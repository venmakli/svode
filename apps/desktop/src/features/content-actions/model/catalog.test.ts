import { expect, test } from "bun:test";
import {
  contentActionGroups,
  type ContentActionMenuInput,
  type ContentObject,
} from "./catalog";

function menu(input: ContentActionMenuInput) {
  return contentActionGroups(input).map((group) => ({
    group: group.id,
    actions: group.actions.map((action) => action.id),
  }));
}

function ids(object: ContentObject) {
  return menu({ object });
}

test("a regular page", () => {
  expect(ids({ kind: "page", form: "leaf" })).toEqual([
    { group: "navigation", actions: ["pin"] },
    { group: "create", actions: ["nest-page", "new-folder"] },
    { group: "convert", actions: ["make-collection"] },
    { group: "edit", actions: ["rename", "duplicate"] },
    { group: "delete", actions: ["delete"] },
  ]);
});

test("a page with subpages", () => {
  expect(ids({ kind: "page", form: "folder" })).toEqual([
    { group: "navigation", actions: ["pin"] },
    { group: "create", actions: ["nest-page", "new-folder"] },
    { group: "convert", actions: ["make-collection", "make-leaf"] },
    { group: "edit", actions: ["rename", "duplicate"] },
    { group: "delete", actions: ["delete"] },
  ]);
});

test("a Collection item has the menu of a page of the same form", () => {
  for (const form of ["leaf", "folder"] as const) {
    expect(ids({ kind: "collection-item", form })).toEqual(
      ids({ kind: "page", form }),
    );
  }
});

test("a template sets its default instead of pinning and duplicates as a template", () => {
  expect(ids({ kind: "template", form: "leaf", isDefault: false })).toEqual([
    { group: "navigation", actions: ["set-template-default"] },
    { group: "create", actions: ["nest-page", "new-folder"] },
    { group: "convert", actions: ["make-collection"] },
    { group: "edit", actions: ["rename", "duplicate-template"] },
    { group: "delete", actions: ["delete"] },
  ]);
  expect(ids({ kind: "template", form: "folder", isDefault: true })).toEqual([
    { group: "navigation", actions: ["unset-template-default"] },
    { group: "create", actions: ["nest-page", "new-folder"] },
    { group: "convert", actions: ["make-collection", "make-leaf"] },
    { group: "edit", actions: ["rename", "duplicate-template"] },
    { group: "delete", actions: ["delete"] },
  ]);
});

test("a bare folder is not pinned", () => {
  expect(ids({ kind: "folder" })).toEqual([
    { group: "create", actions: ["nest-page", "new-folder"] },
    { group: "convert", actions: ["make-page", "make-collection"] },
    { group: "edit", actions: ["rename"] },
    { group: "delete", actions: ["delete"] },
  ]);
});

test("a Collection creates items and has no page actions", () => {
  expect(ids({ kind: "collection" })).toEqual([
    { group: "navigation", actions: ["pin"] },
    { group: "create", actions: ["new-item"] },
    { group: "edit", actions: ["rename"] },
    { group: "delete", actions: ["delete"] },
  ]);
});

test("an App pins, renames and deletes only", () => {
  expect(ids({ kind: "app" })).toEqual([
    { group: "navigation", actions: ["pin"] },
    { group: "edit", actions: ["rename"] },
    { group: "delete", actions: ["delete"] },
  ]);
});

test("a Space saves all only with unsaved changes and is removed from the project", () => {
  expect(ids({ kind: "space", unsavedChanges: false })).toEqual([
    { group: "navigation", actions: ["pin"] },
    {
      group: "create",
      actions: ["new-page", "new-folder", "new-collection"],
    },
    { group: "edit", actions: ["rename"] },
    { group: "delete", actions: ["remove-space"] },
  ]);
  expect(ids({ kind: "space", unsavedChanges: true })).toEqual([
    { group: "navigation", actions: ["pin"] },
    {
      group: "create",
      actions: ["new-page", "new-folder", "new-collection"],
    },
    { group: "edit", actions: ["save-all", "rename"] },
    { group: "delete", actions: ["remove-space"] },
  ]);
});

test("the project root creates content only", () => {
  expect(ids({ kind: "project-root" })).toEqual([
    { group: "navigation", actions: ["pin"] },
    {
      group: "create",
      actions: ["new-page", "new-folder", "new-collection"],
    },
  ]);
});

test("surface actions take their own groups", () => {
  expect(
    menu({
      object: { kind: "space", unsavedChanges: false },
      surfaceActions: { newSession: true, newTerminal: true },
    }),
  ).toEqual([
    { group: "navigation", actions: ["pin"] },
    {
      group: "create",
      actions: ["new-page", "new-folder", "new-collection"],
    },
    { group: "launch", actions: ["new-session", "new-terminal"] },
    { group: "edit", actions: ["rename"] },
    { group: "delete", actions: ["remove-space"] },
  ]);
  expect(
    menu({
      object: { kind: "project-root" },
      surfaceActions: { newTerminal: true },
    }).map((group) => group.group),
  ).toEqual(["navigation", "create", "launch"]);
  expect(
    menu({
      object: { kind: "collection-item", form: "leaf" },
      surfaceActions: { openInPeek: true },
    })[0],
  ).toEqual({ group: "open", actions: ["open-in-peek"] });
});

test("read-only keeps every action and disables the mutating ones", () => {
  const objects: ContentObject[] = [
    { kind: "page", form: "folder" },
    { kind: "template", form: "leaf", isDefault: false },
    { kind: "folder" },
    { kind: "collection" },
    { kind: "app" },
    { kind: "space", unsavedChanges: true },
    { kind: "project-root" },
  ];
  for (const object of objects) {
    const surfaceActions = {
      openInPeek: true,
      newSession: true,
      newTerminal: true,
    };
    const readOnly = contentActionGroups({
      object,
      readOnly: true,
      surfaceActions,
    });
    expect(readOnly.map((group) => group.actions.map((a) => a.id))).toEqual(
      contentActionGroups({ object, surfaceActions }).map((group) =>
        group.actions.map((a) => a.id),
      ),
    );
    const enabled = readOnly
      .flatMap((group) => group.actions)
      .filter((action) => !action.disabled)
      .map((action) => action.id);
    const pinned = object.kind !== "template" && object.kind !== "folder";
    expect(enabled).toEqual([
      "open-in-peek",
      ...(pinned ? ["pin" as const] : []),
      "new-session",
      "new-terminal",
    ]);
  }
});

test("a page with subpages or files cannot become regular and says why", () => {
  const makeLeaf = (
    contents: {
      subpageCount: number;
      otherFileCount: number;
    } | null,
  ) =>
    contentActionGroups({
      object: { kind: "page", form: "folder", contents },
    })
      .flatMap((group) => group.actions)
      .find((action) => action.id === "make-leaf");

  expect(makeLeaf(null)).toEqual({
    id: "make-leaf",
    disabled: false,
    reason: null,
  });
  expect(makeLeaf({ subpageCount: 0, otherFileCount: 0 })?.disabled).toBe(
    false,
  );
  const blocked = makeLeaf({ subpageCount: 2, otherFileCount: 1 });
  expect(blocked?.disabled).toBe(true);
  expect(blocked?.reason).toBe(
    "Folder contains 2 subpages, 1 other file(s) — move them out first",
  );
});
