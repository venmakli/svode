import { expect, test } from "bun:test";
import {
  parseSvodeDraggedResource,
  serializeSvodeDraggedResource,
  type SvodeDraggedResource,
} from "./resource-drag";

const resource: SvodeDraggedResource = {
  version: 1,
  kind: "collection",
  projectPath: "/project",
  spacePath: "/project/space",
  relativePath: "tasks",
};

test("round-trips a versioned Svode resource drag payload", () => {
  expect(
    parseSvodeDraggedResource(serializeSvodeDraggedResource(resource)),
  ).toEqual(resource);
});

test("rejects unknown resource payload versions and malformed JSON", () => {
  expect(
    parseSvodeDraggedResource(JSON.stringify({ ...resource, version: 2 })),
  ).toBeNull();
  expect(parseSvodeDraggedResource("not-json")).toBeNull();
});
