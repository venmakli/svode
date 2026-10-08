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

test("keeps the row title and rejects one that is not text", () => {
  const titled = { ...resource, title: "Tasks" };
  expect(
    parseSvodeDraggedResource(serializeSvodeDraggedResource(titled)),
  ).toEqual(titled);
  expect(
    parseSvodeDraggedResource(JSON.stringify({ ...resource, title: 7 })),
  ).toBeNull();
});
