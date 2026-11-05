import type { PluginConfig, SlateEditor } from "platejs";
import { createTPlatePlugin } from "platejs/react";
import { typeDuringSend } from "../model/composer";

type ComposerSendingConfig = PluginConfig<
  "composerSending",
  {
    /** The text in the field is on its way and takes no edits. */
    sending: boolean;
    /** The draft that takes the text typed meanwhile, in typing order. */
    draftKey: string | null;
  }
>;

/** Editors writing a draft changed outside the field into it. */
const writing = new WeakSet<SlateEditor>();

/**
 * The composer field while its text is sent (Stage 10 `04`, DF-199): it
 * stays editable and keeps focus, since WebKit takes focus off a field that
 * stops being editable and loses or reorders the keys typed meanwhile. The
 * text being sent takes no edits from any source; typed text waits for the
 * send's end and then goes after the draft's text. The caret still moves.
 */
export const ComposerSendingPlugin = createTPlatePlugin<ComposerSendingConfig>({
  key: "composerSending",
  options: { sending: false, draftKey: null },
  extendEditor: ({ editor, getOption }) => {
    // Undo and redo would move history over operations the field drops.
    const { redo, undo } = editor;
    editor.undo = () => {
      if (!getOption("sending")) undo();
    };
    editor.redo = () => {
      if (!getOption("sending")) redo();
    };
    return editor;
  },
  handlers: {
    onDOMBeforeInput: ({ event, getOptions }) => {
      const { sending, draftKey } = getOptions();
      if (!sending) return false;
      const input = nativeEvent<InputEvent>(event);
      input.preventDefault();
      if (
        draftKey !== null &&
        input.inputType === "insertText" &&
        !input.isComposing &&
        input.data
      ) {
        typeDuringSend(draftKey, input.data);
      }
      return true;
    },
    onPaste: ({ event, getOption }) => refuse(event, getOption("sending")),
    onDrop: ({ event, getOption }) => refuse(event, getOption("sending")),
  },
}).overrideEditor(({ editor, getOption, tf: { apply } }) => ({
  transforms: {
    apply(operation) {
      if (
        getOption("sending") &&
        operation.type !== "set_selection" &&
        !writing.has(editor)
      ) {
        return;
      }
      apply(operation);
    },
  },
}));

/** Writes a draft changed outside the field into it, also while it sends. */
export function writeComposerField(editor: SlateEditor, write: () => void) {
  writing.add(editor);
  try {
    write();
  } finally {
    writing.delete(editor);
  }
}

function refuse(event: Event | { nativeEvent?: Event }, sending: boolean) {
  if (!sending) return false;
  nativeEvent(event).preventDefault();
  return true;
}

/** Plate hands DOM handlers a copy of the event with the native one inside. */
function nativeEvent<E extends Event>(event: object): E {
  const { nativeEvent: native } = event as { nativeEvent?: Event };
  return (native ?? event) as E;
}
