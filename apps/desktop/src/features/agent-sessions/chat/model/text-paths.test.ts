import { expect, test } from "bun:test";
import {
  formatLineSuffix,
  inlineCodeReference,
  isAbsolute,
  labelledReference,
  linkTarget,
  localReference,
  referenceName,
  splitLineSuffix,
  type PathBase,
} from "./text-paths";

const base: PathBase = { cwd: "/work/project", home: "/Users/me" };

function localPath(href: string, at: PathBase = base) {
  const target = linkTarget(href, at);
  return target?.kind === "local" ? target.reference : null;
}

test("a line suffix splits off the path in every written form", () => {
  expect(splitLineSuffix("src/main.rs:42")).toEqual({
    path: "src/main.rs",
    line: { line: 42, column: null, endLine: null },
  });
  expect(splitLineSuffix("src/main.rs:42:7")).toEqual({
    path: "src/main.rs",
    line: { line: 42, column: 7, endLine: null },
  });
  expect(splitLineSuffix("src/main.rs:10-20")).toEqual({
    path: "src/main.rs",
    line: { line: 10, column: null, endLine: 20 },
  });
  expect(splitLineSuffix("src/main.rs#L10")).toEqual({
    path: "src/main.rs",
    line: { line: 10, column: null, endLine: null },
  });
  expect(splitLineSuffix("src/main.rs#L10-L20")).toEqual({
    path: "src/main.rs",
    line: { line: 10, column: null, endLine: 20 },
  });
  expect(splitLineSuffix("src/main.rs")).toEqual({
    path: "src/main.rs",
    line: null,
  });
  expect(splitLineSuffix("C:\\work\\a.rs:3").path).toBe("C:\\work\\a.rs");
  expect(formatLineSuffix({ line: 10, column: null, endLine: 20 })).toBe(
    ":10-20",
  );
  expect(formatLineSuffix({ line: 42, column: 7, endLine: null })).toBe(
    ":42:7",
  );
});

test("a link to a local object resolves an absolute path, file URI, ~ and the cwd", () => {
  expect(localPath("/abs/notes.md")).toEqual({
    path: "/abs/notes.md",
    line: null,
  });
  expect(localPath("file:///abs/my%20notes.md#L3")).toEqual({
    path: "/abs/my notes.md",
    line: { line: 3, column: null, endLine: null },
  });
  expect(localPath("file:///abs/main.rs:12")).toEqual({
    path: "/abs/main.rs",
    line: { line: 12, column: null, endLine: null },
  });
  expect(localPath("~/notes.txt")?.path).toBe("/Users/me/notes.txt");
  expect(localPath("~")?.path).toBe("/Users/me");
  expect(localPath("src/main.rs:42")).toEqual({
    path: "/work/project/src/main.rs",
    line: { line: 42, column: null, endLine: null },
  });
  expect(localPath("./x/../y.rs#L10-L20")).toEqual({
    path: "/work/project/y.rs",
    line: { line: 10, column: null, endLine: 20 },
  });
  expect(localPath("../up.md:3:7")?.path).toBe("/work/up.md");
  // A file named like a scheme with a line is a path, as in `Makefile:12`.
  expect(localPath("Makefile:12")?.path).toBe("/work/project/Makefile");
  expect(localPath("a%20b.md")?.path).toBe("/work/project/a b.md");
  // A heading anchor is not part of the path.
  expect(localPath("docs/setup.md#install")).toEqual({
    path: "/work/project/docs/setup.md",
    line: null,
  });
  expect(localPath("notes.md", { cwd: "C:\\work", home: null })?.path).toBe(
    "C:\\work\\notes.md",
  );
});

test("Windows paths resolve in either separator to the form of Windows", () => {
  const windows: PathBase = {
    cwd: "C:\\work\\project",
    home: "C:\\Users\\me",
  };
  expect(localPath("C:/work/a.md")?.path).toBe("C:\\work\\a.md");
  expect(localPath("C:%5Cwork%5Ca%20b.md")?.path).toBe("C:\\work\\a b.md");
  expect(localPath("file:///C:/work/my%20notes.md#L3")).toEqual({
    path: "C:\\work\\my notes.md",
    line: { line: 3, column: null, endLine: null },
  });
  // The drive is not a line suffix.
  expect(localPath("C:\\a\\b.rs:42")).toEqual({
    path: "C:\\a\\b.rs",
    line: { line: 42, column: null, endLine: null },
  });
  expect(localPath("C:/a/b.rs:10-20")?.line).toEqual({
    line: 10,
    column: null,
    endLine: 20,
  });
  expect(localPath("src/main.rs:42:7", windows)).toEqual({
    path: "C:\\work\\project\\src\\main.rs",
    line: { line: 42, column: 7, endLine: null },
  });
  expect(localPath("..\\up.md", windows)?.path).toBe("C:\\work\\up.md");
  expect(localPath("~/notes/a.md", windows)?.path).toBe(
    "C:\\Users\\me\\notes\\a.md",
  );
  expect(localPath("~\\notes\\a.md", windows)?.path).toBe(
    "C:\\Users\\me\\notes\\a.md",
  );
  expect(localPath("D:\\x\\..\\..\\y.md")?.path).toBe("D:\\y.md");
  expect(localPath("\\\\?\\C:\\work\\a.md")?.path).toBe("C:\\work\\a.md");
  expect(inlineCodeReference("C:\\Users\\me\\a.rs:3", windows)).toEqual({
    path: "C:\\Users\\me\\a.rs",
    line: { line: 3, column: null, endLine: null },
  });
  expect(inlineCodeReference("C:/", windows)).toBe(null);
  expect(inlineCodeReference("\\\\?\\C:\\", windows)).toBe(null);
  expect(inlineCodeReference("C:relative.rs", windows)).toBe(null);
});

test("a network share is not a local object in any form", () => {
  for (const href of [
    "\\\\server\\share\\a.md",
    "//server/share/a.md",
    "/\\server\\share\\a.md",
    "\\\\?\\UNC\\server\\share\\a.md",
    "\\\\.\\pipe\\name",
    "%5C%5Cserver%5Cshare%5Ca.md",
    "file://server/share/a.md",
    "file:////server/share/a.md",
    "file:///%5C%5Cserver/share/a.md",
  ]) {
    expect(linkTarget(href, base)).toBe(null);
    // Only a link percent-decodes what it names.
    if (!href.startsWith("%")) {
      expect(localReference(href, base, { relative: true })).toBe(null);
    }
  }
  expect(inlineCodeReference("\\\\server\\share\\a.md", base)).toBe(null);
  expect(inlineCodeReference("//server/share/a.md", base)).toBe(null);
  // A session or a home on a share resolves nothing either.
  const shared: PathBase = { cwd: "\\\\server\\share", home: "//server/home" };
  expect(linkTarget("notes.md", shared)).toBe(null);
  expect(linkTarget("~/notes.md", shared)).toBe(null);
  expect(isAbsolute("\\\\server\\share")).toBe(false);
  expect(isAbsolute("\\\\?\\C:\\a")).toBe(true);
});

test("a link without a base it needs resolves nothing", () => {
  expect(linkTarget("src/main.rs", { cwd: null, home: "/Users/me" })).toBe(
    null,
  );
  expect(linkTarget("~/notes.txt", { cwd: "/work", home: null })).toBe(null);
  expect(linkTarget("~other/notes.txt", base)).toBe(null);
});

test("http(s) opens a web page; other schemes and anchors stay text", () => {
  expect(linkTarget("https://example.com/a?b=1#c", base)).toEqual({
    kind: "web",
    url: "https://example.com/a?b=1#c",
  });
  expect(linkTarget("HTTP://example.com", base)?.kind).toBe("web");
  for (const href of [
    "mailto:me@example.com",
    "javascript:alert(1)",
    "vscode://file/x",
    "data:text/html,<b>",
    "ftp://example.com/a",
    "#anchor",
    "",
    "https://",
  ]) {
    expect(linkTarget(href, base)).toBe(null);
  }
});

test("inline code names a path only when absolute or from ~, never a bare root", () => {
  expect(inlineCodeReference("/abs/src/main.rs:42", base)).toEqual({
    path: "/abs/src/main.rs",
    line: { line: 42, column: null, endLine: null },
  });
  expect(inlineCodeReference("~/notes", base)?.path).toBe("/Users/me/notes");
  expect(inlineCodeReference("src/main.rs", base)).toBe(null);
  expect(inlineCodeReference("main.rs:42", base)).toBe(null);
  expect(inlineCodeReference("npm install", base)).toBe(null);
  expect(inlineCodeReference("/", base)).toBe(null);
  expect(inlineCodeReference("C:\\", base)).toBe(null);
  expect(inlineCodeReference("/a\n/b", base)).toBe(null);
  // Inline code keeps what it says: no percent-decoding.
  expect(inlineCodeReference("/abs/a%20b", base)?.path).toBe("/abs/a%20b");
});

test("a reference resolves relative paths only when asked", () => {
  expect(localReference("img/a.png", base, { relative: true })?.path).toBe(
    "/work/project/img/a.png",
  );
  expect(localReference("img/a.png", base, { relative: false })).toBe(null);
  expect(
    localReference("file:///abs/a.png", base, { relative: false })?.path,
  ).toBe("/abs/a.png");
});

/** The badge a local link shows, or null when its label is its own name. */
function badgeOf(label: string, href: string, at: PathBase = base) {
  const reference = localPath(href, at);
  if (!reference) return null;
  const named = labelledReference(label, href, reference, at);
  return named && { path: named.path, name: referenceName(named) };
}

test("a link whose label only names its target is that object", () => {
  const page = { path: "/work/project/reports/a.html", name: "a.html" };
  // Empty, the same path in every form a link reads, the target's name.
  expect(badgeOf("", "/work/project/reports/a.html")).toEqual(page);
  for (const label of [
    "/work/project/reports/a.html",
    "reports/a.html",
    "./reports/../reports/a.html",
    "file:///work/project/reports/a.html",
    "`/work/project/reports/a.html`",
    "a.html",
    "`a.html`",
  ]) {
    expect(badgeOf(label, "/work/project/reports/a.html")).toEqual(page);
    expect(badgeOf(label, "reports/a.html")).toEqual(page);
  }
  expect(badgeOf("~/todo.txt", "/Users/me/todo.txt")).toEqual({
    path: "/Users/me/todo.txt",
    name: "todo.txt",
  });
  expect(badgeOf("docs/", "docs")).toEqual({
    path: "/work/project/docs",
    name: "docs",
  });
  // A relative label without a cwd still names its target by its name.
  expect(
    badgeOf("a.html", "/abs/a.html", { cwd: null, home: null }),
  ).toEqual({ path: "/abs/a.html", name: "a.html" });
});

test("the badge of a link shows the line of its target, else of its label", () => {
  const line = { path: "/work/project/src/app.rs", name: "app.rs:42" };
  expect(badgeOf("src/app.rs:42", "src/app.rs:42")).toEqual(line);
  expect(badgeOf("app.rs", "src/app.rs:42")).toEqual(line);
  expect(badgeOf("app.rs:42", "src/app.rs")).toEqual(line);
  expect(badgeOf("app.rs:7", "src/app.rs#L42")).toEqual(line);
  expect(badgeOf("app.rs:10-20", "/work/project/src/app.rs")).toEqual({
    path: "/work/project/src/app.rs",
    name: "app.rs:10-20",
  });
});

test("a link with a name of its own, another file's name or a web label stays a link", () => {
  expect(badgeOf("Отчёт", "reports/weekly.md")).toBe(null);
  expect(badgeOf("weekly", "reports/weekly.md")).toBe(null);
  expect(badgeOf("monthly.md", "reports/weekly.md")).toBe(null);
  expect(badgeOf("reports/monthly.md", "reports/weekly.md")).toBe(null);
  expect(badgeOf("https://example.com/weekly.md", "reports/weekly.md")).toBe(
    null,
  );
  expect(badgeOf("weekly.md report", "reports/weekly.md")).toBe(null);
  // A network share is no local object: nothing to show.
  expect(badgeOf("", "//server/share/a.md")).toBe(null);
  expect(badgeOf("a.md", "file:////server/share/a.md")).toBe(null);
});

test("Windows paths name the same object whatever their case and separators", () => {
  const windows: PathBase = { cwd: "C:\\work\\project", home: null };
  expect(
    badgeOf("c:/WORK/project/notes.md", "notes.md", windows),
  ).toEqual({ path: "C:\\work\\project\\notes.md", name: "notes.md" });
  expect(badgeOf("notes.md", "C:/work/project/notes.md", windows)).toEqual({
    path: "C:\\work\\project\\notes.md",
    name: "notes.md",
  });
});

test("a badge is named by the object and its line suffix", () => {
  expect(
    referenceName({ path: "/abs/dir/app.rs", line: null }),
  ).toBe("app.rs");
  expect(
    referenceName({
      path: "/abs/dir/app.rs",
      line: { line: 42, column: 7, endLine: null },
    }),
  ).toBe("app.rs:42:7");
  expect(referenceName({ path: "C:\\work\\docs", line: null })).toBe("docs");
});
