import { expect, test } from "bun:test";

import {
  decodePageLinkPath,
  encodePageLinkPath,
  isBrokenPageLink,
  makeRelativePath,
  pageLinkPath,
  resolveRelativeDocPath,
} from "./page-link-utils";

test("link paths are percent-decoded once as UTF-8", () => {
  expect(decodePageLinkPath("Roadmap%20Draft.md")).toBe("Roadmap Draft.md");
  expect(decodePageLinkPath("%D0%9F%D0%BB%D0%B0%D0%BD.md")).toBe("План.md");
  expect(decodePageLinkPath("%d0%9f.md")).toBe("П.md");
  expect(decodePageLinkPath("a%2Fb.md")).toBe("a/b.md");
  expect(decodePageLinkPath("50%25.md")).toBe("50%.md");
  expect(decodePageLinkPath("a%2520b.md")).toBe("a%20b.md");
  expect(decodePageLinkPath("План.md")).toBe("План.md");
});

test("a percent sign that is not a valid UTF-8 escape stays literal", () => {
  expect(decodePageLinkPath("100% done.md")).toBe("100% done.md");
  expect(decodePageLinkPath("%ZZ.md")).toBe("%ZZ.md");
  expect(decodePageLinkPath("%FF.md")).toBe("%FF.md");
  expect(decodePageLinkPath("%D0.md")).toBe("%D0.md");
  expect(decodePageLinkPath("%D0%9")).toBe("%D0%9");
  expect(decodePageLinkPath("%C0%80.md")).toBe("%C0%80.md");
  expect(decodePageLinkPath("%E0%80%80%20x.md")).toBe("%E0%80%80 x.md");
  expect(decodePageLinkPath("%D0%9F%FF.md")).toBe("П%FF.md");
});

test("the link path matches the path validate_links reports", () => {
  expect(pageLinkPath("Roadmap%20Draft.md#Goals%20Q3")).toBe(
    "Roadmap Draft.md",
  );
  expect(pageLinkPath("./notes/../Roadmap%20Draft.md")).toBe(
    "Roadmap Draft.md",
  );
  expect(pageLinkPath("../../%D0%9F%D0%BB%D0%B0%D0%BD.md")).toBe(
    "../../План.md",
  );
  expect(pageLinkPath("A%23B.md#c")).toBe("A#B.md");
});

test("a relative link resolves against the document after decoding", () => {
  expect(resolveRelativeDocPath("tasks/Ship.md", "../Roadmap%20Draft.md")).toBe(
    "Roadmap Draft.md",
  );
  expect(resolveRelativeDocPath("/proj/Index.md", "a%2Fb.md#top")).toBe(
    "/proj/a/b.md",
  );
});

test("broken links match decoded paths in project and Space mode", () => {
  // Project mode: paths as written in the document, decoded.
  const project = new Set(["Nope Here.md", "../Пропал.md"]);
  expect(isBrokenPageLink(project, "Nope%20Here.md", "tasks/Ship.md")).toBe(
    true,
  );
  expect(
    isBrokenPageLink(
      project,
      "../%D0%9F%D1%80%D0%BE%D0%BF%D0%B0%D0%BB.md",
      null,
    ),
  ).toBe(true);
  expect(isBrokenPageLink(project, "Roadmap%20Draft.md", "Index.md")).toBe(
    false,
  );
  // Space mode: paths resolved against the Space root.
  const space = new Set(["tasks/Nope Here.md"]);
  expect(isBrokenPageLink(space, "Nope%20Here.md#x", "tasks/Ship.md")).toBe(
    true,
  );
  expect(isBrokenPageLink(space, "Nope%20Here.md", "Index.md")).toBe(false);
  expect(isBrokenPageLink(space, "https://a.test/Nope.md", "Index.md")).toBe(
    false,
  );
  expect(isBrokenPageLink(space, undefined, "Index.md")).toBe(false);
});

test("a literal percent of a Page link is written as %25", () => {
  expect(encodePageLinkPath("50% off.md")).toBe("50%25 off.md");
  expect(encodePageLinkPath("assets/50% off.png")).toBe("assets/50% off.png");
  expect(makeRelativePath("/proj/tasks/Ship.md", "/proj/50% off.md")).toBe(
    "../50%25 off.md",
  );
  expect(decodePageLinkPath(encodePageLinkPath("A%2B.md"))).toBe("A%2B.md");
});
