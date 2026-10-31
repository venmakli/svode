import { expect, test } from "bun:test";
import { conflictPartners } from "./conflict-paths";

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
