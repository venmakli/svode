import { useRef } from "react";
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
      const cursor = editor.selection?.anchor;
      const before = cursor
        ? editor.api.string({ anchor: editor.api.start([])!, focus: cursor })
        : "";
      const value = dictatedText(text, before);
      if (!value) return;
      editor.tf.insertText(value);
      editor.tf.focus();
      if (send) sendAfterRef.current = JSON.stringify(draftParts(editor.children));
    },
    onDetachedText: (key, text) =>
      appendComposerDraftText(key, (before) => dictatedText(text, before)),
  });
  return { dictation, sendAfterRef };
}
