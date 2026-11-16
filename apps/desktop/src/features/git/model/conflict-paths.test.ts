import { expect, test } from "bun:test";
import {
  conflictEditedSide,
  conflictPartners,
  conflictResolvedByEditorWrite,
  gitPathConflictKind,
} from "./conflict-paths";

test("the other names of a rename/rename conflict are shown at its entry", () => {
  expect([
    ...conflictPartners([
      { path: "notes.txt", kind: "text" },
      {
        path: "moved-ours.txt",
        kind: "rename_rename",
        also: ["moved.txt", "moved-theirs.txt"],
      },
    ]),
  ]).toEqual(["moved.txt", "moved-theirs.txt"]);
  expect(conflictPartners([{ path: "a.png", kind: "binary" }]).size).toBe(0);
});

test("a write decides only the conflicts whose dispute stands in marker lines", () => {
  for (const kind of [
    "page_text",
    "page_properties",
    "text",
    "add_add",
  ] as const)
    expect(conflictResolvedByEditorWrite(kind)).toBe(true);
  for (const kind of [
    "modify_delete",
    "rename_delete",
    "rename_rename",
    "binary",
    "space_pointer",
  ] as const)
    expect(conflictResolvedByEditorWrite(kind)).toBe(false);
});

test("the kind of a path is the kind of the conflict that holds it, at its entry or as another name", () => {
  const conflicts = [
    { path: "pages/plan.md", kind: "modify_delete" as const },
    {
      path: "moved-ours.md",
      kind: "rename_rename" as const,
      also: ["moved.md", "moved-theirs.md"],
    },
  ];
  expect(gitPathConflictKind(conflicts, "pages/plan.md")).toBe("modify_delete");
  expect(gitPathConflictKind(conflicts, "pages\\plan.md")).toBe(
    "modify_delete",
  );
  expect(gitPathConflictKind(conflicts, "moved-theirs.md")).toBe(
    "rename_rename",
  );
  expect(gitPathConflictKind(conflicts, "notes.md")).toBeNull();
});

test("the file stays with the side whose version the index holds against a deletion", () => {
  expect(conflictEditedSide({ ours: true })).toBe("ours");
  expect(conflictEditedSide({ ours: false })).toBe("theirs");
});
