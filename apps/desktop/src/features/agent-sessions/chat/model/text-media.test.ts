import { expect, test } from "bun:test";
import {
  dataImage,
  textImageParts,
  withMediaImages,
  type TextImagePart,
} from "./text-media";
import type { PathBase } from "./text-paths";

const base: PathBase = { cwd: "/work/project", home: "/Users/me" };

const done = { complete: true };

test("MEDIA lines become images by the rule of the runtime", () => {
  expect(
    withMediaImages(
      [
        "Done.",
        "MEDIA:/a/one.png",
        'see MEDIA:"/a/two words.wav" [[audio_as_voice]]',
        "MEDIA:`~/three.mp4`.",
        "(MEDIA:'/a/four (1).pdf') [[as_document]]",
        "`MEDIA:/a/code.png`",
        "```",
        "MEDIA:/a/fenced.png",
        "```",
        "xMEDIA:/a/glued.png",
        "MEDIA:relative.png",
        "",
      ].join("\n"),
      done,
    ),
  ).toBe(
    [
      "Done.",
      "![](/a/one.png)",
      "see ![](/a/two%20words.wav) ",
      "![](~/three.mp4).",
      "(![](/a/four%20%281%29.pdf)) ",
      "`MEDIA:/a/code.png`",
      "```",
      "MEDIA:/a/fenced.png",
      "```",
      "xMEDIA:/a/glued.png",
      "MEDIA:relative.png",
      "",
    ].join("\n"),
  );
  expect(withMediaImages("no media", done)).toBe("no media");
  expect(withMediaImages("MEDIA:C:\\out\\a.png", done)).toBe(
    "![](C:%5Cout%5Ca.png)",
  );
  // A network share stays text.
  for (const line of [
    "MEDIA:\\\\server\\share\\a.png",
    "MEDIA://server/share/a.png",
    'MEDIA:"\\\\?\\UNC\\server\\share\\a.png"',
  ]) {
    expect(withMediaImages(line, done)).toBe(line);
  }
});

test("a MEDIA line split by the stream is recognized once it ended", () => {
  const streaming = { complete: false };
  expect(withMediaImages("Here:\nMEDIA:/a/pic", streaming)).toBe(
    "Here:\nMEDIA:/a/pic",
  );
  expect(withMediaImages("Here:\nMEDIA:/a/pic.png", streaming)).toBe(
    "Here:\nMEDIA:/a/pic.png",
  );
  expect(withMediaImages("Here:\nMEDIA:/a/pic.png\n", streaming)).toBe(
    "Here:\n![](/a/pic.png)\n",
  );
  expect(withMediaImages("Here:\nMEDIA:/a/pic.png", done)).toBe(
    "Here:\n![](/a/pic.png)",
  );
});

test("images of the text: local files and data within the bound as media, external ones as cards", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const parts = textImageParts(
    [
      { source: "/abs/a.png", alt: "Bunny" },
      { source: "file:///abs/clip%20one.mp4", alt: "" },
      { source: "out/voice.wav", alt: "" },
      { source: "~/report.pdf", alt: "" },
      { source: png, alt: "dot" },
      { source: "https://example.com:8080/x.png?a=1", alt: "remote" },
      { source: "data:image/png;base64," + "A".repeat(40), alt: "big" },
      { source: "data:text/html,<b>x</b>", alt: "html" },
      { source: "vscode://file/x.png", alt: "" },
      { source: "/abs/b.png", alt: "" },
    ],
    base,
    20,
  );
  const shape = (part: TextImagePart) =>
    part.type === "media"
      ? part.media.map(({ kind, name, path, url }) => ({
          kind,
          name,
          path,
          url,
        }))
      : part;
  expect(parts.map(shape)).toEqual([
    [
      { kind: "image", name: "Bunny", path: "/abs/a.png", url: null },
      {
        kind: "video",
        name: "clip one.mp4",
        path: "/abs/clip one.mp4",
        url: null,
      },
      {
        kind: "audio",
        name: "voice.wav",
        path: "/work/project/out/voice.wav",
        url: null,
      },
      {
        kind: "file",
        name: "report.pdf",
        path: "/Users/me/report.pdf",
        url: null,
      },
      { kind: "image", name: "dot", path: null, url: png },
    ],
    {
      type: "external",
      url: "https://example.com:8080/x.png?a=1",
      host: "example.com",
      alt: "remote",
    },
    { type: "text", text: "big" },
    { type: "text", text: "html" },
    [{ kind: "image", name: "b.png", path: "/abs/b.png", url: null }],
  ]);
});

test("an image of a Windows drive is a file, one of a network share its alt text", () => {
  const windows = { cwd: "C:\\work\\project", home: "C:\\Users\\me" };
  const parts = textImageParts(
    [
      { source: "C:%5Cout%5CShot.PNG", alt: "" },
      { source: "img/a.png", alt: "" },
      { source: "%5C%5Cserver%5Cshare%5Cb.png", alt: "share" },
      { source: "//server/share/c.png", alt: "" },
      { source: "file://server/share/d.png", alt: "host" },
    ],
    windows,
  );
  expect(
    parts.map((part) =>
      part.type === "media"
        ? part.media.map(({ kind, path }) => ({ kind, path }))
        : part,
    ),
  ).toEqual([
    [
      { kind: "image", path: "C:\\out\\Shot.PNG" },
      { kind: "image", path: "C:\\work\\project\\img\\a.png" },
    ],
    { type: "text", text: "share" },
    { type: "text", text: "host" },
  ]);
});

test("a data image is read by its type and decoded size", () => {
  expect(dataImage("data:image/png;base64,iVBORw==")).toEqual({
    mimeType: "image/png",
    size: 4,
    base64: true,
    payload: "iVBORw==",
  });
  expect(dataImage("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")?.size).toBe(
    6,
  );
  expect(dataImage("data:application/pdf;base64,AAAA")).toBe(null);
  expect(dataImage("/abs/a.png")).toBe(null);
});
