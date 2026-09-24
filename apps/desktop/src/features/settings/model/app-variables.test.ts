import { expect, test } from "bun:test";
import { withOwnerNames } from "./app-variables";
import { catalogFixture, variableFixture } from "./testing/variables";

const space = { scope: "space", id: "docs" } as const;

function catalog() {
  const result = catalogFixture(
    [
      variableFixture(
        { name: "OWN", kind: "variable", ownerLabel: "docs" },
        space,
      ),
      variableFixture({
        name: "PARENT",
        kind: "variable",
        inherited: true,
        ownerLabel: "/Users/me/Testov",
      }),
    ],
    space,
  );
  result.owners = [
    { owner: space, label: "docs", revision: "r1", error: null },
    {
      owner: { scope: "project" },
      label: "/Users/me/Testov",
      revision: "r1",
      error: null,
    },
    { owner: { scope: "global" }, label: "Svode", revision: "r1", error: null },
  ];
  return result;
}

test("owners of the open project are named by their display names", () => {
  const named = withOwnerNames(catalog(), "/Users/me/Testov", {
    rootPath: "/Users/me/Testov",
    rootName: "Testov",
    spaces: [{ id: "docs", name: "Сопровождение" }],
  });
  expect(named.owners.map((owner) => owner.label)).toEqual([
    "Сопровождение",
    "Testov",
    "Svode",
  ]);
  expect(named.entries.map((entry) => entry.ownerLabel)).toEqual([
    "Сопровождение",
    "Testov",
  ]);
});

test("owners outside the open project keep their catalog labels", () => {
  const source = catalog();
  expect(
    withOwnerNames(source, "/Users/me/Other", {
      rootPath: "/Users/me/Testov",
      rootName: "Testov",
      spaces: [{ id: "docs", name: "Сопровождение" }],
    }),
  ).toBe(source);
  expect(
    withOwnerNames(source, "/Users/me/Testov", {
      rootPath: "/Users/me/Testov",
      rootName: null,
      spaces: [],
    }).owners.map((owner) => owner.label),
  ).toEqual(["docs", "/Users/me/Testov", "Svode"]);
});
