import { expect, test } from "bun:test";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type TElement } from "platejs";
import { createPlateEditor } from "platejs/react";
import { deserializeWithConflicts } from "../src/features/editor/conflict/parse-conflicts";
import { pageLinkPath } from "../src/features/editor/lib/page-link-utils";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";
import { EditorKit } from "../src/features/editor/plate/editor-kit";

type Editor = ReturnType<typeof createPlateEditor>;

function editorFor(source: string): Editor {
  const editor = createPlateEditor({ plugins: EditorKit });
  loadProgrammaticEditorValue(editor, deserializeWithConflicts(editor, source));
  return editor;
}

function save(editor: Editor): string {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}

function linkUrls(editor: Editor): string[] {
  return [...NodeApi.elements(editor)]
    .filter(([node]) => node.type === "a")
    .map(([node]) => (node as TElement & { url: string }).url);
}

test("DF-154 percent-encoded links keep their form through load and save", () => {
  const source = [
    "- [Roadmap Draft](Roadmap%20Draft.md)",
    "- [План](%D0%9F%D0%BB%D0%B0%D0%BD.md)",
    "- [Nested](a%2Fb.md#Goals%20Q3)",
    "- [Fifty](50%25.md)",
    "- [Missing](../Nope%20Here.md)",
    "- [Angle](<Roadmap Draft.md>)",
    "",
  ].join("\n");
  let markdown = source;
  for (let round = 0; round < 2; round += 1) {
    const editor = editorFor(markdown);
    expect(linkUrls(editor)).toEqual([
      "Roadmap%20Draft.md",
      "%D0%9F%D0%BB%D0%B0%D0%BD.md",
      "a%2Fb.md#Goals%20Q3",
      "50%25.md",
      "../Nope%20Here.md",
      "Roadmap Draft.md",
    ]);
    markdown = save(editor);
    expect(markdown).toBe(source);
  }
});

test("DF-154 an inserted link to a Page with % in its title decodes to that Page", () => {
  const editor = editorFor("Start\n");
  editor.tf.insertNodes(
    {
      type: "a",
      url: "50%25 off.md",
      children: [{ text: "50% off" }],
    } as TElement,
    { at: [0, 1] },
  );
  const markdown = save(editor);
  expect(markdown).toContain("[50% off](<50%25 off.md>)");
  const reloaded = editorFor(markdown);
  expect(linkUrls(reloaded)).toEqual(["50%25 off.md"]);
  expect(pageLinkPath(linkUrls(reloaded)[0])).toBe("50% off.md");
});
