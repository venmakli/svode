import { expect, test } from "bun:test";
import {
  ATTACHMENT_ELEMENT,
  attachmentKind,
  draftParts,
  draftValue,
  fileUriToPath,
  folderAttachment,
  isDraftBlank,
  locateAttachment,
  messageParts,
  promptParts,
  type DraftPart,
} from "./attachments";

const note = { path: "/p/notes/plan.md", name: "Plan" };
const shot = { path: "/tmp/svode-pasted/01/shot.png", name: "shot.png" };

test("badges stay where they were typed through the editor value", () => {
  const parts: DraftPart[] = [
    { type: "text", text: "Compare " },
    { type: "attachment", attachment: note },
    { type: "text", text: " with\n" },
    { type: "attachment", attachment: shot },
  ];
  const value = draftValue(parts);
  expect(value.length).toBe(1);
  expect(value[0].children.map((child) => child.type ?? "text")).toEqual([
    "text",
    ATTACHMENT_ELEMENT,
    "text",
    ATTACHMENT_ELEMENT,
    "text",
  ]);
  expect(draftParts(value)).toEqual(parts);
});

test("the prompt keeps the order of text and links", () => {
  expect(
    promptParts([
      { type: "attachment", attachment: note },
      { type: "text", text: "" },
      { type: "text", text: " read it" },
    ]),
  ).toEqual([
    { type: "file", path: note.path, name: note.name },
    { type: "text", text: " read it" },
  ]);
});

test("a draft with only an attachment can be sent, blank text cannot", () => {
  expect(isDraftBlank([{ type: "text", text: "  \n" }])).toBe(true);
  expect(isDraftBlank([])).toBe(true);
  expect(isDraftBlank([{ type: "attachment", attachment: note }])).toBe(false);
});

test("an open mention search is not part of the draft", () => {
  expect(
    draftParts([
      {
        type: "p",
        children: [
          { text: "see " },
          { type: "mention_input", trigger: "@", children: [{ text: "" }] },
          { text: "" },
        ],
      },
    ]),
  ).toEqual([{ type: "text", text: "see " }]);
});

test("segments become text and badges in order", () => {
  expect(
    messageParts(
      [
        { type: "text", text: "Look at " },
        { type: "link", uri: "file:///p/a%20b.md", name: "a b.md" },
        { type: "image", uri: null, name: null },
        { type: "link", uri: "https://example.com/x", name: "x" },
      ],
      "Look at @a b.md",
    ),
  ).toEqual([
    { type: "text", text: "Look at " },
    { type: "attachment", attachment: { path: "/p/a b.md", name: "a b.md" } },
    { type: "image", name: null },
    { type: "text", text: "@x" },
  ]);
});

test("links the adapter replayed as text become badges, the rest stays text", () => {
  expect(
    messageParts(
      [],
      "See [@plan.md](file:///p/notes/plan.md) and [@x](http://x) or [@y](file://relative)",
    ),
  ).toEqual([
    { type: "text", text: "See " },
    {
      type: "attachment",
      attachment: { path: "/p/notes/plan.md", name: "plan.md" },
    },
    {
      type: "text",
      text: " and [@x](http://x) or [@y](file://relative)",
    },
  ]);
});

test("replays of Claude Code and Codex show one badge per attached image", () => {
  const shot = "file:///p/flag%20shot.png";
  const badge = {
    type: "attachment",
    attachment: { path: "/p/flag shot.png", name: "flag shot.png" },
  };
  // Claude Code: a percent-encoded name, then the image block.
  expect(
    messageParts(
      [
        { type: "text", text: `Colors: [@flag%20shot.png](${shot})` },
        { type: "image", uri: null, name: null },
        { type: "text", text: " done" },
      ],
      "",
    ),
  ).toEqual([
    { type: "text", text: "Colors: " },
    badge,
    { type: "text", text: " done" },
  ]);
  // Codex: the image inlined as data, which the runtime keeps as a name.
  expect(
    messageParts(
      [
        { type: "text", text: `Colors: [@flag shot.png](${shot})` },
        { type: "image", uri: null, name: "image" },
      ],
      "",
    ),
  ).toEqual([{ type: "text", text: "Colors: " }, badge]);
});

test("a text-only message is its text", () => {
  expect(messageParts([], "plain")).toEqual([{ type: "text", text: "plain" }]);
});

test("file URIs map to local paths, Windows drives included", () => {
  expect(fileUriToPath("file:///Users/me/%D0%9C%D0%BE%D0%B8/a.md")).toBe(
    "/Users/me/Мои/a.md",
  );
  expect(fileUriToPath("file:///C:/work/a.md")).toBe("C:/work/a.md");
  expect(fileUriToPath("file://localhost/tmp/a")).toBe("/tmp/a");
  expect(fileUriToPath("https://x/a")).toBeNull();
  expect(fileUriToPath("file:///%E0%A4%A")).toBeNull();
});

test("a file URI of a network share, by its host or its path, is not local", () => {
  for (const uri of [
    "file://server/share/a.md",
    "file:////server/share/a.md",
    "file:///%5C%5Cserver/share/a.md",
    "file://localhost//server/share/a.md",
  ]) {
    expect(fileUriToPath(uri)).toBeNull();
  }
  expect(fileUriToPath("file:///C:%5Cwork%5Ca.md")).toBe("C:\\work\\a.md");
});

test("the kind follows the extension", () => {
  expect(attachmentKind("/p/a.MD")).toBe("page");
  expect(attachmentKind("/p/a.jpeg")).toBe("image");
  expect(attachmentKind("/p/report.pdf")).toBe("file");
  expect(attachmentKind("/p/.env")).toBe("file");
});

test("a file belongs to its innermost Space", () => {
  const spaces = [
    { id: "root", path: "/p" },
    { id: "child", path: "/p/child" },
  ];
  expect(locateAttachment("/p/child/a.md", spaces)).toEqual({
    spaceId: "child",
    spacePath: "/p/child",
    path: "a.md",
  });
  expect(locateAttachment("/p/childish/a.md", spaces)?.spaceId).toBe("root");
  expect(locateAttachment("/elsewhere/a.md", spaces)).toBeNull();
});

test("a Windows file belongs to its Space whatever its case and separators", () => {
  const spaces = [
    { id: "root", path: "C:\\Users\\me\\project" },
    { id: "child", path: "C:\\Users\\me\\project\\child\\" },
  ];
  for (const path of [
    "C:\\Users\\me\\project\\child\\docs\\a.md",
    "C:/Users/me/project/child/docs/a.md",
    "c:\\users\\ME\\project\\child\\docs\\a.md",
    "\\\\?\\C:\\Users\\me\\project\\child\\docs\\a.md",
  ]) {
    expect(locateAttachment(path, spaces)).toEqual({
      spaceId: "child",
      spacePath: "C:\\Users\\me\\project\\child",
      path: "docs/a.md",
    });
  }
  expect(
    locateAttachment("C:\\Users\\me\\projects\\a.md", spaces),
  ).toBeNull();
  expect(locateAttachment("D:\\Users\\me\\project\\a.md", spaces)).toBeNull();
  // Unix paths keep their case.
  expect(locateAttachment("/P/a.md", [{ id: "root", path: "/p" }])).toBeNull();
});

test("a folder ends with its separator, and its replayed link is a folder again", () => {
  expect(folderAttachment("/p/tasks", "Tasks")).toEqual({ path: "/p/tasks/", name: "Tasks" });
  expect(folderAttachment("/p/tasks/")).toEqual({ path: "/p/tasks/", name: "tasks" });
  expect(folderAttachment("C:\\work\\tasks").path).toBe("C:\\work\\tasks\\");
  expect(attachmentKind("/p/tasks/")).toBe("folder");
  expect(attachmentKind("/p/plan.md")).toBe("page");
  expect(
    messageParts(
      [{ type: "link", uri: "file:///p/tasks/", name: "Tasks" }],
      "@Tasks",
    ),
  ).toEqual([{ type: "attachment", attachment: { path: "/p/tasks/", name: "Tasks" } }]);
  expect(messageParts([], "[@tasks](file:///p/tasks/)")).toEqual([
    { type: "attachment", attachment: { path: "/p/tasks/", name: "tasks" } },
  ]);
});
