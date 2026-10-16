import { expect, test } from "bun:test";

import { markdownCommentText } from "./markdown-comment-text";

test("comment text drops the delimiters of every comment form", () => {
  expect(markdownCommentText("<!-- note -->")).toBe("note");
  expect(markdownCommentText("{/* note */}")).toBe("note");
  expect(markdownCommentText("{// note\n}")).toBe("note");
  expect(markdownCommentText("{/* one */ /* two */}")).toBe("one\ntwo");
  expect(markdownCommentText("[//]: # (note)")).toBe("note");
  expect(markdownCommentText('[//]: # "note"')).toBe("note");
  expect(markdownCommentText("[//]: <> 'note'")).toBe("note");
});

test("multi-line comment text keeps its lines without the shared indent", () => {
  expect(markdownCommentText("<!--\n  first\n    second\n-->")).toBe(
    "first\n  second",
  );
});

test("a comment without text has empty text", () => {
  expect(markdownCommentText("<!-- -->")).toBe("");
  expect(markdownCommentText("<!---->")).toBe("");
  expect(markdownCommentText("[//]: #")).toBe("");
  expect(markdownCommentText("{/**/}")).toBe("");
});
