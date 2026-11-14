import { afterEach, expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import {
  childSpacePath,
  takenNamePath,
} from "@/platform/space/content-tree-api";
import { takenNameMessage } from "./taken-name-error";

const originalLocale = getLocale();

afterEach(async () => {
  await setLocale(originalLocale, { reload: false });
});

function takenName(path: string) {
  return {
    kind: "file_already_exists",
    message: `File already exists: ${path}`,
    path,
  };
}

test("the refusal of a taken name is recognised by its kind and path", () => {
  expect(takenNamePath(takenName("Docs/New folder"))).toBe("Docs/New folder");
  expect(takenNamePath("File already exists: Docs/New folder")).toBeNull();
  expect(takenNamePath(new Error("File already exists: Docs"))).toBeNull();
  expect(takenNamePath({ kind: "file_already_exists" })).toBeNull();
  expect(
    takenNamePath({ kind: "tree_order_unreadable", path: "a.json" }),
  ).toBeNull();
  expect(
    takenNamePath({ kind: "path_in_other_space", path: "a.md", spaceId: "x" }),
  ).toBeNull();
  expect(takenNamePath(null)).toBeNull();
});

test("a taken name in a nested folder names the name and the folder", async () => {
  await setLocale("en", { reload: false });
  expect(takenNameMessage(takenName("Docs/Plans/New folder"), "Team")).toBe(
    "“New folder” is already taken in “Docs/Plans”.",
  );
  await setLocale("ru", { reload: false });
  expect(takenNameMessage(takenName("Docs/Plans/New folder"), "Team")).toBe(
    "Имя «New folder» уже занято в «Docs/Plans».",
  );
});

test("a taken name in the Space root names the Space", async () => {
  await setLocale("en", { reload: false });
  expect(takenNameMessage(takenName("items"), "Team")).toBe(
    "“items” is already taken in “Team”.",
  );
  await setLocale("ru", { reload: false });
  expect(takenNameMessage(takenName("items"), "Team")).toBe(
    "Имя «items» уже занято в «Team».",
  );
});

test("other errors are left to the caller", () => {
  expect(takenNameMessage("IO error: denied", "Team")).toBeNull();
  expect(
    takenNameMessage({ kind: "source_busy", path: "a.md" }, "Team"),
  ).toBeNull();
  expect(takenNameMessage(takenName("items"), null)).toBeNull();
});

test("a name a child Space owns counts as taken only when the caller asks", async () => {
  const childSpace = {
    kind: "path_in_other_space",
    message: "Docs/eng belongs to Space eng; run the operation in that Space",
    path: "Docs/eng",
    spaceId: "eng",
  };
  expect(childSpacePath(childSpace)).toBe("Docs/eng");
  expect(childSpacePath(takenName("Docs/eng"))).toBeNull();
  expect(childSpacePath({ kind: "path_in_other_space" })).toBeNull();
  expect(childSpacePath("Docs/eng belongs to Space eng")).toBeNull();
  expect(takenNameMessage(childSpace, "Team")).toBeNull();
  await setLocale("en", { reload: false });
  expect(takenNameMessage(childSpace, "Team", { childSpaceTaken: true })).toBe(
    "“eng” is already taken in “Docs”.",
  );
  expect(
    takenNameMessage({ ...childSpace, path: "eng" }, "Team", {
      childSpaceTaken: true,
    }),
  ).toBe("“eng” is already taken in “Team”.");
  await setLocale("ru", { reload: false });
  expect(takenNameMessage(childSpace, "Team", { childSpaceTaken: true })).toBe(
    "Имя «eng» уже занято в «Docs».",
  );
});
