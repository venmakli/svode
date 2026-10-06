import { useEffect, useRef } from "react";
import type { PlateEditor } from "platejs/react";
import { dictatedText, useDictation } from "@/features/voice-input";
import { draftParts } from "../model/attachments";
import { appendComposerDraftText } from "../model/composer";

/**
 * Dictation into the composer field (`04`, `06`): the text goes in at the
 * cursor for editing and is sent only by ↑. `sendAfterRef` holds the draft
 * that ↑ waits for, so the send carries the dictated text.
 */
export function useComposerDictation(editor: PlateEditor, draftKey: string) {
  const sendAfterRef = useRef<string | null>(null);
  const dictation = useDictation({
    key: draftKey,
    onText: (text, send) => {
      if (!editor.selection) editor.tf.select(editor.api.end([]));
      const selection = editor.selection;
      const before = selection
        ? editor.api.string({ anchor: editor.api.start([])!, focus: selection.anchor })
        : "";
      const after = selection
        ? editor.api.string({ anchor: selection.focus, focus: editor.api.end([])! })
        : "";
      const value = dictatedText(text, before, after);
      if (!value) return;
      editor.tf.insertText(value);
      editor.tf.focus();
      if (send) sendAfterRef.current = JSON.stringify(draftParts(editor.children));
    },
    onDetachedText: (key, text) =>
      appendComposerDraftText(key, (before) => dictatedText(text, before)),
  });

  // The microphone, ■, "Повторить" or ✕ that moved the dictation on goes
  // with the row it was in, which leaves the focus nowhere: bring it back to
  // the field, so the hotkey and Esc keep reaching the composer.
  const phase = dictation.state.phase;
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (document.activeElement !== document.body) return;
    // Without a caret yet the text goes after the draft, as it would unfocused.
    editor.tf.focus(editor.selection ? undefined : { edge: "endEditor" });
  }, [editor, phase]);

  return { dictation, sendAfterRef };
}
