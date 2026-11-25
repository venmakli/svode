import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import { RangeApi } from "platejs";
import type { PlateEditor } from "platejs/react";
import { dictatedText, useDictation } from "@/features/voice-input";
import { draftParts, type DraftPart } from "../model/attachments";
import {
  appendComposerDraftText,
  composerDraftRevision,
  draftSendActive,
} from "../model/composer";

/** Closing peeks keep their content during the exit animation. */
export const ComposerActiveContext = createContext(true);

/**
 * Inserts into a live field or appends to its window draft when it goes.
 * Existing sessions send through their window-scoped send operation.
 */
export function useComposerDictation(
  editor: PlateEditor,
  root: RefObject<HTMLElement | null>,
  draftKey: string,
  saveParts: (parts: DraftPart[]) => void,
  sendDictated?: () => void,
) {
  // A new session's first send still belongs to the mounted draft surface.
  const sendAfterRef = useRef<string | null>(null);
  const active = useContext(ComposerActiveContext);
  const append = (text: string) =>
    appendComposerDraftText(draftKey, (before) => dictatedText(text, before));
  const dictation = useDictation({
    key: draftKey,
    active,
    onText: (text, send) => {
      if (draftSendActive(draftKey)) {
        append(text);
        return;
      }
      if (!editor.selection) editor.tf.select(editor.api.end([]));
      const selection = editor.selection;
      const first = editor.api.start([]);
      const last = editor.api.end([]);
      if (!selection || !first || !last) return;
      const [start, end] = RangeApi.edges(selection);
      const before = editor.api.string({ anchor: first, focus: start });
      const after = editor.api.string({ anchor: end, focus: last });
      const value = dictatedText(text, before, after);
      if (!value) return;
      editor.tf.insertText(value);
      const active = document.activeElement;
      if (active === document.body || root.current?.contains(active)) editor.tf.focus();
      const parts = draftParts(editor.children);
      saveParts(parts);
      if (send && sendDictated) sendDictated();
      else if (send) sendAfterRef.current = JSON.stringify(parts);
    },
    onDetach: () => {
      const revision = composerDraftRevision(draftKey);
      const sending = draftSendActive(draftKey);
      return (text, send) => {
        if (!text.trim()) return;
        const canSend = !sending && composerDraftRevision(draftKey) === revision;
        append(text);
        if (send && canSend) sendDictated?.();
      };
    },
  });

  // The microphone, ■, "Повторить" or ✕ that moved the dictation on goes
  // with the row it was in, which drops the focus to the page or, in a
  // session peek, to the peek around the composer: bring it back to the
  // field, so the hotkey and Esc keep reaching the composer.
  const phase = dictation.state.phase;
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (!active) return;
    const focused = document.activeElement;
    const field = editor.api.toDOMNode(editor);
    if (!focused || !field || focused === field || !focused.contains(field)) return;
    // Without a caret yet the text goes after the draft, as it would unfocused.
    editor.tf.focus(editor.selection ? undefined : { edge: "endEditor" });
  }, [active, editor, phase]);

  return { dictation, sendAfterRef };
}
