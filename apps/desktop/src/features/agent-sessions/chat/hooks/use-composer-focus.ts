import { useEffect, type RefObject } from "react";
import { useEditorReadOnly, useEditorRef } from "platejs/react";

/** The draft whose composer takes focus back once its send is over. */
let held: string | null = null;

/**
 * Focus is in `root` or nowhere: the page, or a container around the
 * composer such as the peek a removed field leaves it on.
 */
function focusFree(root: Element | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return root !== null && (active.contains(root) || root.contains(active));
}

/**
 * The composer of `draftKey` sends while focus is in it or nowhere (Stage
 * 10 `04`, DF-197): the field takes no edits while sending and loses focus,
 * so it takes focus back when the send is over.
 */
export function holdComposerFocus(draftKey: string, root: Element | null) {
  held = focusFree(root) ? draftKey : null;
}

/**
 * The first send of a new session draft created session `to`: its
 * composer, which takes the draft's place, takes the focus back.
 */
export function passComposerFocus(from: string, to: string) {
  if (held === from) held = to;
}

/**
 * Inside the composer's Plate: once the field takes edits again, the
 * composer that held focus for its send — or the one that took its place
 * on a new surface — puts the caret at the end, unless the user moved
 * focus elsewhere meanwhile.
 */
export function useComposerFocusReturn(
  draftKey: string,
  root: RefObject<HTMLElement | null>,
) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  useEffect(() => {
    if (readOnly || held !== draftKey) return;
    held = null;
    if (!focusFree(root.current)) return;
    editor.tf.select(editor.api.end([]));
    // Once Slate applied the selection, so the page's caret is put there
    // at once rather than left to a later read of the stale one.
    queueMicrotask(() => {
      if (!root.current) return;
      // Slate ignores the blur of a read-only field and still counts it
      // focused, so it would not focus it again.
      editor.tf.blur();
      editor.tf.focus();
    });
  }, [draftKey, editor, readOnly, root]);
}
