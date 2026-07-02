import { expect, test } from "bun:test";
import {
  relationTargetSpaceId,
  relationTargetSpacePath,
} from "./relation";

test("relationTargetSpacePath does not fall back root scope to current space", () => {
  expect(
    relationTargetSpacePath(
      { spacePath: "/project/spaces/design", projectPath: null },
      "root",
      { activeRootPath: null, spaces: [] },
    ),
  ).toBeNull();

  expect(
    relationTargetSpacePath(
      { spacePath: "/project/spaces/design", projectPath: "/project" },
      "root",
      { activeRootPath: null, spaces: [] },
    ),
  ).toBe("/project");
});

test("relationTargetSpacePath resolves explicit space scope by id", () => {
  expect(
    relationTargetSpacePath(
      { spacePath: "/project", projectPath: "/project" },
      { type: "space", id: "design" },
      {
        activeRootPath: "/project",
        spaces: [{ id: "design", path: "/project/spaces/design" }],
      },
    ),
  ).toBe("/project/spaces/design");
});

test("relationTargetSpaceId mirrors relation scope identity", () => {
  expect(relationTargetSpaceId("design", "project", null)).toBe("design");
  expect(relationTargetSpaceId("design", "project", "root")).toBe("project");
  expect(
    relationTargetSpaceId("design", "project", {
      type: "space",
      id: "research",
    }),
  ).toBe("research");
});
