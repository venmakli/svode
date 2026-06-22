import { expect, test } from "bun:test";
import { createPlateEditor } from "platejs/react";
import { BasicBlocksKit } from "../src/components/editor/plugins/basic-blocks-kit";
import { loadProgrammaticEditorValue } from "../src/features/editor/model/programmatic-editor-load";

function createMarkdownEditor() {
  return createPlateEditor({
    plugins: [...BasicBlocksKit],
  });
}

test("programmatic editor load does not leave content operations for dirty detection", () => {
  const editor = createMarkdownEditor();
  const value = [{ type: "p", children: [{ text: "Loaded" }] }];

  const loadedValue = loadProgrammaticEditorValue(editor, value);

  expect(loadedValue).toBe(editor.children);
  expect(editor.operations).toEqual([]);
  expect(editor.history?.undos).toEqual([]);
  expect(editor.history?.redos).toEqual([]);
});
