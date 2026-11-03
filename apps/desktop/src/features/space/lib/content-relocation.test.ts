import { expect, test } from "bun:test";
import { relocatedItemPath } from "./content-relocation";

const moved = (from: string, to: string) => ({ from, to, converted: false });
const converted = (from: string, to: string) => ({ from, to, converted: true });

test("the moved Page and its converted parents go to their new paths", () => {
  expect(
    relocatedItemPath("Source.md", moved("Source.md", "Target/Source.md")),
  ).toBe("Target/Source.md");
  expect(
    relocatedItemPath("Target.md", converted("Target.md", "Target/README.md")),
  ).toBe("Target/README.md");
  expect(
    relocatedItemPath(
      "Folder/README.md",
      converted("Folder/README.md", "Folder.md"),
    ),
  ).toBe("Folder.md");
});

test("the README of a folder moved by its directory or README goes with it", () => {
  expect(
    relocatedItemPath("Folder/README.md", moved("Folder", "A/Folder")),
  ).toBe("A/Folder/README.md");
  expect(
    relocatedItemPath(
      "Folder/readme.md",
      moved("Folder/README.md", "A/Folder"),
    ),
  ).toBe("A/Folder/readme.md");
});

test("other paths are left to the folder relocation", () => {
  expect(
    relocatedItemPath("Folder/Child.md", moved("Folder", "A/Folder")),
  ).toBeNull();
  expect(
    relocatedItemPath("Other.md", moved("Source.md", "Target/Source.md")),
  ).toBeNull();
  expect(
    relocatedItemPath("Sourced.md", moved("Source.md", "T/Source.md")),
  ).toBeNull();
});
