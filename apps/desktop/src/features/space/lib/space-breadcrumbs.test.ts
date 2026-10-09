import { expect, test } from "bun:test";
import type { SpaceInfo, TreeNode } from "../model/types";
import {
  breadcrumbSpaceChoices,
  buildBreadcrumbPrefix,
  buildMainBreadcrumbs,
  buildSpaceBreadcrumbSegments,
  collapseBreadcrumbs,
  type MainBreadcrumb,
} from "./space-breadcrumbs";

function node(
  input: Partial<TreeNode> & Pick<TreeNode, "name" | "path">,
): TreeNode {
  return {
    title: input.name,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
    ...input,
  };
}

function space(id: string, name: string, icon = ""): SpaceInfo {
  return {
    id,
    name,
    icon,
    description: "",
    path: `/project/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  };
}

const project = { id: "root", name: "Svode", icon: "🚀" };
const docs = space("docs", "Docs", "📚");
const labels = (crumbs: MainBreadcrumb[]) => crumbs.map((crumb) => crumb.label);

test("keeps Collection owners structural in breadcrumbs", () => {
  const tree = [
    node({
      name: "tasks",
      path: "tasks/README.md",
      title: "Tasks",
      has_schema: true,
      children: [
        node({ name: "today.md", path: "tasks/today.md", title: "Today" }),
      ],
    }),
  ];

  expect(buildSpaceBreadcrumbSegments("tasks/today.md", tree)).toEqual([
    {
      label: "Tasks",
      path: "tasks",
      ownerKind: "collection",
      icon: null,
      fallback: "collection",
    },
    {
      label: "Today",
      path: "tasks/today.md",
      ownerKind: null,
      icon: null,
      fallback: "page",
    },
  ]);
});

test("keeps an ordinary directory-backed Page as an Artifact breadcrumb", () => {
  const tree = [
    node({
      name: "notes",
      path: "notes/README.md",
      title: "Notes",
    }),
  ];

  expect(buildSpaceBreadcrumbSegments("notes/README.md", tree)).toEqual([
    {
      label: "Notes",
      path: "notes/README.md",
      ownerKind: null,
      icon: null,
      fallback: "page",
    },
  ]);
});

test("every segment has its own icon or the fallback of its kind", () => {
  const tree = [
    node({
      name: "apps",
      path: "apps",
      children: [
        node({
          name: "board",
          path: "apps/board/README.md",
          title: "Board",
          kind: "app",
          icon: "🧩",
        }),
      ],
    }),
  ];

  expect(
    buildSpaceBreadcrumbSegments("apps/board/README.md", tree).map(
      ({ icon, fallback }) => [icon, fallback],
    ),
  ).toEqual([
    [null, "directory"],
    ["🧩", "app"],
  ]);
  expect(
    ["files/report.pdf", "files/photo.JPG", "files/talk.mp3", "files/demo.mov"]
      .map((path) => buildSpaceBreadcrumbSegments(path, []).at(-1)?.fallback)
      .concat(buildSpaceBreadcrumbSegments("files/report.pdf", [])[0].fallback),
  ).toEqual(["document", "image", "audio", "video", "page"]);
});

test("Home starts with the project, then a child Space", () => {
  const root = buildBreadcrumbPrefix({ home: true, project, space: null });
  expect(root).toEqual([
    {
      key: "project:root",
      label: "Svode",
      icon: "🚀",
      fallback: "project",
      target: { kind: "project-home" },
    },
  ]);

  const child = buildBreadcrumbPrefix({ home: true, project, space: docs });
  expect(labels(child)).toEqual(["Svode", "Docs"]);
  expect([child[1].icon, child[1].fallback, child[1].target]).toEqual([
    "📚",
    "space",
    { kind: "space-home", spaceId: "docs" },
  ]);
});

test("inside the project the project is not shown and the root has no Space", () => {
  expect(buildBreadcrumbPrefix({ home: false, project, space: null })).toEqual(
    [],
  );
  expect(
    labels(buildBreadcrumbPrefix({ home: false, project, space: docs })),
  ).toEqual(["Docs"]);
});

test("a Space without an icon falls back like the sidebar", () => {
  const [crumb] = buildBreadcrumbPrefix({
    home: false,
    project,
    space: space("plain", "Plain"),
  });
  expect([crumb.icon, crumb.fallback]).toEqual([null, "space"]);
});

const tree = [
  node({
    name: "guide",
    path: "guide/README.md",
    title: "Guide",
    children: [node({ name: "intro.md", path: "guide/intro.md" })],
  }),
];

test("an object of the project root inside the project is only its path", () => {
  const { crumbs, prefixLength } = buildMainBreadcrumbs({
    home: false,
    project,
    space: null,
    path: "guide/intro.md",
    tree,
  });
  expect(prefixLength).toBe(0);
  expect(labels(crumbs)).toEqual(["Guide", "intro.md"]);
  const target = crumbs[0].target;
  expect(
    target.kind === "segment" ? [target.segment.path, target.spaceId] : null,
  ).toEqual(["guide/README.md", "root"]);
});

test("an object of a child Space on Home goes through project and Space", () => {
  const { crumbs, prefixLength } = buildMainBreadcrumbs({
    home: true,
    project,
    space: docs,
    path: "guide/intro.md",
    tree,
  });
  expect(prefixLength).toBe(2);
  expect(labels(crumbs)).toEqual(["Svode", "Docs", "Guide", "intro.md"]);
  const target = crumbs.at(-1)?.target;
  expect(target?.kind === "segment" ? target.spaceId : null).toBe("docs");
});

test("a Space home has the prefix only", () => {
  const home = (isHome: boolean, child: SpaceInfo | null) =>
    labels(
      buildMainBreadcrumbs({
        home: isHome,
        project,
        space: child,
        path: null,
        tree,
      }).crumbs,
    );
  expect(home(false, null)).toEqual([]);
  expect(home(false, docs)).toEqual(["Docs"]);
  expect(home(true, null)).toEqual(["Svode"]);
  expect(home(true, docs)).toEqual(["Svode", "Docs"]);
});

const { crumbs, prefixLength } = buildMainBreadcrumbs({
  home: true,
  project,
  space: docs,
  path: "a/b/c/d/e.md",
  tree: [],
});

test("a path longer than three segments keeps the first and two last", () => {
  const items = collapseBreadcrumbs(crumbs, prefixLength);
  expect(
    items.map((item) =>
      item.kind === "crumb" ? item.crumb.label : `…${labels(item.hidden)}`,
    ),
  ).toEqual(["Svode", "Docs", "a", "…b,c", "d", "e"]);
});

test("three segments stay whole", () => {
  const short = buildMainBreadcrumbs({
    home: false,
    project,
    space: null,
    path: "a/b/c.md",
    tree: [],
  });
  expect(
    collapseBreadcrumbs(short.crumbs, short.prefixLength).every(
      (item) => item.kind === "crumb",
    ),
  ).toBe(true);
});

test("the Space element lists Spaces only for two and more", () => {
  expect(breadcrumbSpaceChoices([docs])).toEqual([]);
  expect(
    breadcrumbSpaceChoices([docs, space("ops", "Ops")]).map(({ id }) => id),
  ).toEqual(["docs", "ops"]);
});
