import { expect, test } from "bun:test";
import { createPlateEditor } from "platejs/react";
import { ComposerSendingPlugin, writeComposerField } from "./composer-sending";

function editor() {
  const value = [{ type: "p", children: [{ text: "Hello" }] }];
  const created = createPlateEditor({ plugins: [ComposerSendingPlugin], value });
  created.tf.select(created.api.end([]));
  created.tf.insertText(" x");
  return created;
}

function text(created: ReturnType<typeof editor>) {
  return created.api.string([]);
}

test("while sending the field drops edits and undo, and moves the caret", () => {
  const created = editor();
  created.setOption(ComposerSendingPlugin, "sending", true);
  created.tf.insertText("y");
  created.tf.deleteBackward("character");
  created.undo();
  created.redo();
  created.tf.select(created.api.start([]));
  expect(text(created)).toBe("Hello x");
  expect(created.history.undos.length).toBe(1);
  expect(created.history.redos.length).toBe(0);
  expect(created.selection?.anchor.offset).toBe(0);

  created.setOption(ComposerSendingPlugin, "sending", false);
  created.undo();
  expect(text(created)).toBe("Hello");
});

test("while sending a draft changed outside the field is written into it", () => {
  const created = editor();
  created.setOption(ComposerSendingPlugin, "sending", true);
  writeComposerField(created, () =>
    created.tf.setValue([{ type: "p", children: [{ text: "Hello x\n\nRequest" }] }]),
  );
  expect(text(created)).toBe("Hello x\n\nRequest");
  created.tf.insertText("y");
  expect(text(created)).toBe("Hello x\n\nRequest");
});
