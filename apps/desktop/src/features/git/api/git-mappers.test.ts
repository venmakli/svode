import { expect, test } from "bun:test";
import { toSyncResult } from "./git-mappers";

test("toSyncResult maps backend camelCase sync results", () => {
  expect(toSyncResult({ type: "success" })).toEqual({ type: "Success" });
  expect(toSyncResult({ type: "noRemote" })).toEqual({ type: "NoRemote" });
  expect(toSyncResult({ type: "authRequired" })).toEqual({
    type: "AuthRequired",
  });
  expect(toSyncResult({ type: "conflict", files: ["README.md"] })).toEqual({
    type: "Conflict",
    files: ["README.md"],
  });
});
