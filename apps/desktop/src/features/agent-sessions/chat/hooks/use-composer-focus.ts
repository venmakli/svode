import {
  createContext,
  useContext,
  useEffect,
  useState,
  type RefObject,
} from "react";
import { useEditorRef } from "platejs/react";

/**
 * The draft whose send holds focus for a composer taking its place, as the
 * created session's does after the first send of a new session draft.
 */
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
 * 10 `04`, DF-197). The field keeps focus while it sends (DF-199); a
 * composer that takes its place on a new surface takes the focus.
 */
export function holdComposerFocus(draftKey: string, root: Element | null) {
  held = focusFree(root) ? draftKey : null;
}

/** The send of `draftKey` is over or its composer went: nothing to take. */
export function releaseComposerFocus(draftKey: string) {
  if (held === draftKey) held = null;
}

/**
 * The first send of a new session draft created session `to`: its
 * composer, which takes the draft's place, takes the focus back.
 */
export function passComposerFocus(from: string, to: string) {
  if (held === from) held = to;
}

/**
 * Inside the composer's Plate: the composer that took the place of a
 * sending one on a new surface takes the focus held for that send and puts
 * the caret at the end, unless the user moved focus elsewhere meanwhile.
 */
export function useComposerFocusReturn(
  draftKey: string,
  root: RefObject<HTMLElement | null>,
) {
  const editor = useEditorRef();
  useEffect(() => {
    if (held !== draftKey) return;
    held = null;
    if (!focusFree(root.current)) return;
    editor.tf.select(editor.api.end([]));
    // Once Slate applied the selection, so the page's caret is put there
    // at once rather than left to a later read of the stale one.
    queueMicrotask(() => {
      if (root.current) editor.tf.focus();
    });
  }, [draftKey, editor, root]);
}

/**
 * The opener's request that the composer of the session it opens take
 * focus, as a row of the sidebar does on a click or Enter (Stage 10 `01`,
 * Focus): a new one for every opening, carried out at most once.
 */
export interface ComposerFocusRequest {
  /** What had focus at the opening: the row, or nothing after a click. */
  readonly opener: Element | null;
}

/** A request of the opening happening now. */
export function requestComposerFocus(): ComposerFocusRequest {
  const active = document.activeElement;
  return { opener: active === document.body ? null : active };
}

/** Requests the chat already carried out or let lapse. */
const settled = new WeakSet<ComposerFocusRequest>();

/**
 * Whether the composer takes focus for `request` now: once, as the chat
 * first shows its bottom, if that is the field and focus is still where the
 * opening left it — on the opener or nowhere. Where focus is decides
 * nothing without a request.
 */
export function useRequestedComposerFocus(
  request: ComposerFocusRequest | null,
  shown: boolean,
  field: boolean,
): boolean {
  const [carried, setCarried] = useState<{
    request: ComposerFocusRequest;
    focus: boolean;
  } | null>(null);
  if (request && shown && carried?.request !== request && !settled.has(request)) {
    const active = document.activeElement;
    setCarried({
      request,
      focus:
        field &&
        (!active || active === document.body || active === request.opener),
    });
  }
  // Once the field took it, a field shown again does not take it anew.
  useEffect(() => {
    if (carried) settled.add(carried.request);
  }, [carried]);
  return (
    carried?.request === request && carried.focus && !settled.has(request)
  );
}

/** Drafts whose composer takes focus as soon as it is shown. */
const focusAsked = new Set<string>();
const focusTakers = new Map<string, Set<() => void>>();

/**
 * The composer of `draftKey` takes focus: at once when it is shown,
 * otherwise once it is, as after a Svode action put a request into its
 * draft (Stage 11 1.10). The caret goes to the end of the draft.
 */
export function requestDraftComposerFocus(draftKey: string) {
  const takers = focusTakers.get(draftKey);
  if (takers && takers.size > 0) {
    for (const take of takers) take();
    return;
  }
  focusAsked.add(draftKey);
}

/** Inside the composer of `draftKey`: carries out its focus requests. */
export function useDraftComposerFocusRequest(
  draftKey: string,
  focus: () => void,
) {
  useEffect(() => {
    const takers = focusTakers.get(draftKey) ?? new Set<() => void>();
    takers.add(focus);
    focusTakers.set(draftKey, takers);
    if (focusAsked.delete(draftKey)) focus();
    return () => {
      takers.delete(focus);
      if (takers.size === 0) focusTakers.delete(draftKey);
    };
  }, [draftKey, focus]);
}

/** The composer's field to the controls inside the composer (DF-217). */
export interface ComposerFieldHandle {
  /** The point is in the visible box of the field. */
  contains: (x: number, y: number) => boolean;
  /** Puts the caret back where it was in the field, or at its end. */
  focus: () => void;
}

export const ComposerFieldContext = createContext<ComposerFieldHandle | null>(
  null,
);

/** The field of the composer the control is in, if any. */
export function useComposerField(): ComposerFieldHandle | null {
  return useContext(ComposerFieldContext);
}
