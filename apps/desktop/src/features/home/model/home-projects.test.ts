import { expect, test } from "bun:test";
import type { SpaceInfo } from "@/features/space";
import {
  firstAvailableHomeProject,
  homeProjectAvailability,
  homeProjectsWithSharedNames,
  sortHomeProjects,
} from "./home-projects";

function project(
  id: string,
  lastOpened: string | null,
  overrides: Partial<SpaceInfo> = {},
): SpaceInfo {
  return {
    id,
    name: id,
    icon: "",
    description: "",
    path: `/projects/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened,
    status: "ready",
    lfsState: "n/a",
    ...overrides,
  };
}

const projects = [
  project("never", null),
  project("old", "2026-09-01T00:00:00Z"),
  project("new", "2026-10-05T00:00:00Z"),
  project("gone", "2026-10-06T00:00:00Z", { status: "missing" }),
];

test("orders projects by the last opening, never opened last", () => {
  expect(sortHomeProjects(projects).map((item) => item.id)).toEqual([
    "gone",
    "new",
    "old",
    "never",
  ]);
});

test("tells why Home cannot work with a project", () => {
  const otherWindows = new Set(["new"]);
  expect(homeProjectAvailability(projects[1], otherWindows)).toBe("available");
  expect(homeProjectAvailability(projects[2], otherWindows)).toBe(
    "otherWindow",
  );
  expect(homeProjectAvailability(projects[3], otherWindows)).toBe("missing");
  expect(
    homeProjectAvailability(
      project("x", null, { status: "broken" }),
      otherWindows,
    ),
  ).toBe("broken");
});

test("takes the first project of the list that is neither elsewhere nor unavailable", () => {
  expect(firstAvailableHomeProject(projects, new Set())?.id).toBe("new");
  expect(firstAvailableHomeProject(projects, new Set(["new"]))?.id).toBe("old");
  expect(
    firstAvailableHomeProject(projects, new Set(["new", "old", "never"])),
  ).toBeNull();
});

test("finds projects whose name another project shares", () => {
  const shared = homeProjectsWithSharedNames([
    project("a", null, { name: "Svode" }),
    project("b", null, { name: "Svode" }),
    project("c", null, { name: "Notes" }),
  ]);
  expect([...shared].sort()).toEqual(["a", "b"]);
});
