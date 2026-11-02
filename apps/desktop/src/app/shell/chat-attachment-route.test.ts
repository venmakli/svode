import { expect, test } from "bun:test";

import { chatAttachmentRoute, htmlRoute } from "./chat-attachment-route";

const SPACE = { spaceId: "root", spacePath: "/project" };

test("HTML of the project is asked about its App, then a Document or the App", () => {
  for (const path of ["reports/dash.html", "OLD.HTM"]) {
    const location = { ...SPACE, path };
    expect(chatAttachmentRoute(`/project/${path}`, location)).toEqual({
      kind: "html",
      location,
    });
    expect(htmlRoute(location, null)).toEqual({ kind: "document", location });
  }
  const page = { ...SPACE, path: "tools/dash/public/index.html" };
  expect(
    htmlRoute(page, { kind: "app-directory", path: "tools/dash" }),
  ).toEqual({
    kind: "page",
    location: { ...SPACE, path: "tools/dash" },
    surfaceId: "app",
  });
  // A Space that is itself an App: the peek of the Space, on its App.
  const root = { ...SPACE, path: "index.html" };
  expect(htmlRoute(root, { kind: "space" })).toEqual({
    kind: "page",
    location: { ...SPACE, path: "." },
    surfaceId: "app",
  });
});

test("HTML outside the project is a Document only to view it", () => {
  for (const path of [
    "/private/tmp/claude/scratchpad/report.html",
    "/Users/me/Downloads/PAGE.HTM",
    // A missing file still opens the Document, which names it missing; a
    // link to it is text (R3).
    "/tmp/gone.html",
    "C:\\Users\\me\\report.html",
  ]) {
    expect(chatAttachmentRoute(path, null)).toEqual({ kind: "local-document" });
  }
});

test("a network path is not a local object and other files keep their rule", () => {
  for (const path of [
    "//server/share/report.html",
    "\\\\server\\share\\a.htm",
  ]) {
    expect(chatAttachmentRoute(path, null)).toEqual({ kind: "system" });
  }
  expect(chatAttachmentRoute("/Users/me/guide.pdf", null)).toEqual({
    kind: "system",
  });
  expect(chatAttachmentRoute("/Users/me/notes.txt", null)).toEqual({
    kind: "system",
  });
  expect(chatAttachmentRoute("/Users/me/photo.png", null)).toEqual({
    kind: "local-media",
  });
  const pdf = { ...SPACE, path: "guide.pdf" };
  expect(chatAttachmentRoute("/project/guide.pdf", pdf)).toEqual({
    kind: "document",
    location: pdf,
  });
  const note = { ...SPACE, path: "notes/a.md" };
  expect(chatAttachmentRoute("/project/notes/a.md", note)).toEqual({
    kind: "page",
    location: note,
  });
});
