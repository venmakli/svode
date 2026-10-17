import type { SlateEditor } from "platejs";
import { createPlatePlugin } from "platejs/react";

interface Commit {
  /** The text of the last `textInput` since `compositionend`. */
  text: string | null;
  stop: () => void;
}

const commits = new WeakMap<SlateEditor, Commit>();

function forget(editor: SlateEditor) {
  commits.get(editor)?.stop();
  commits.delete(editor);
}

/**
 * System dictation (DF-174). WebKit commits some dictations as
 * `compositionend` without data, then a native `textInput` with the text,
 * then a `beforeinput` without `inputType`, `data` or `dataTransfer`.
 * slate-react cancels that `beforeinput` and inserts nothing, so the text is
 * lost. Here that `beforeinput` inserts the `textInput` text at the caret,
 * replacing the selection; any `beforeinput` forgets the text, so every other
 * input, the commit with `insertFromComposition` included, stays
 * slate-react's. A read-only field takes nothing.
 *
 * Remove once slate-react applies this commit itself; its DOM tests stay.
 */
export const SystemDictationPlugin = createPlatePlugin({
  key: "systemDictation",
  editOnly: true,
  handlers: {
    onCompositionStart: ({ editor }) => {
      forget(editor);
      return false;
    },
    onCompositionEnd: ({ editor }) => {
      forget(editor);
      const root = editor.api.toDOMNode(editor);
      if (!root) return false;
      // React builds no event from `textInput` where there is no
      // `TextEvent`, so the field listens to the native one.
      const listen = (event: Event) => {
        const { data } = event as Event & { data?: unknown };
        commit.text = typeof data === "string" && data !== "" ? data : null;
      };
      const commit: Commit = {
        text: null,
        stop: () => root.removeEventListener("textInput", listen),
      };
      root.addEventListener("textInput", listen);
      commits.set(editor, commit);
      return false;
    },
    onDOMBeforeInput: ({ editor, event }) => {
      const text = commits.get(editor)?.text ?? null;
      forget(editor);
      if (text === null) return false;
      const input = nativeInputEvent(event);
      if (input.inputType !== "" || input.data != null || input.dataTransfer != null) {
        return false;
      }
      input.preventDefault();
      editor.tf.insertText(text);
      return true;
    },
  },
});

/** Plate hands DOM handlers a copy of the event with the native one inside. */
function nativeInputEvent(event: Event): InputEvent {
  const { nativeEvent } = event as Event & { nativeEvent?: Event };
  return (nativeEvent ?? event) as InputEvent;
}
