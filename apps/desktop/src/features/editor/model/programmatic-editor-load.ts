import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";

export function loadProgrammaticEditorValue(
  editor: PlateEditor,
  value: Descendant[],
): Descendant[] {
  editor.tf.init({ value });
  editor.operations.length = 0;
  editor.marks = null;
  editor.selection = null;

  if (editor.history) {
    editor.history.undos.length = 0;
    editor.history.redos.length = 0;
  }

  return editor.children as Descendant[];
}
