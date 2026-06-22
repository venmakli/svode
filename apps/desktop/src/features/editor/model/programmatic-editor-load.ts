import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";

export function loadProgrammaticEditorValue(
  editor: PlateEditor,
  value: Descendant[],
): Descendant[] {
  editor.tf.init({ value });
  editor.operations = [];
  editor.marks = null;
  editor.selection = null;

  if (editor.history) {
    editor.history.undos = [];
    editor.history.redos = [];
  }

  return editor.children as Descendant[];
}
