"use client";

import type { Descendant, TElement } from "platejs";
import {
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
  useEditorRef,
  useReadOnly,
} from "platejs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as m from "@/paraglide/messages.js";
import {
  type AmbiguousConflictElement,
  ambiguousConflictFieldText,
  type ConflictElement as TConflictElement,
  deserializeAmbiguousConflictText,
  deserializeConflictBranches,
  isAmbiguousConflict,
} from "./parse-conflicts";
import { diffConflictSides } from "./conflict-diff";
import {
  ConflictLane,
  ConflictLanes,
  ConflictLines,
  ConflictLinesField,
} from "./conflict-lanes";
import { ConflictSideView } from "./conflict-side-view";

/** Put `fragment` in place of the conflict `element`; its path, if found. */
function replaceConflict(
  editor: PlateEditor,
  element: TElement,
  fragment: Descendant[],
) {
  const path = editor.api.findPath(element);
  if (!path) return null;
  editor.tf.withoutNormalizing(() => {
    editor.tf.removeNodes({ at: path });
    // A Page keeps at least one block.
    const nodes =
      fragment.length === 0 && editor.children.length === 0
        ? [{ type: "p", children: [{ text: "" }] }]
        : fragment;
    if (nodes.length > 0) editor.tf.insertNodes(nodes as never, { at: path });
  });
  return path;
}

/**
 * Renders a git merge-conflict block as the lanes of its two sides rendered
 * as text with what each changed marked and Accept mine / incoming / both,
 * or a block whose marker lines allow more than one split as its whole text
 * in one neutral lane with Edit only. Void element — the surrounding text is
 * normal.
 */
export function ConflictElementComponent(
  props: PlateElementProps<TConflictElement | AmbiguousConflictElement>,
) {
  const element = props.element;

  if (isAmbiguousConflict(element))
    return <AmbiguousConflict {...props} element={element} />;

  return <SidesConflict {...props} element={element} />;
}

/**
 * An ambiguous place: its lines in one neutral lane with Edit, which turns the
 * lane into a field of its text (DF-303 R3). Until Apply the Page keeps the
 * place unresolved; Apply puts the text of the field in its place, Cancel or
 * Esc shows the place again. The field lives only while the block is shown.
 */
function AmbiguousConflict(props: PlateElementProps<AmbiguousConflictElement>) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element;
  const { ambiguous, markerSize } = element;
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null && !readOnly;
  const field = useRef<HTMLTextAreaElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const focusEdit = useRef(false);

  useEffect(() => {
    if (editing) {
      field.current?.focus();
      field.current?.setSelectionRange(0, 0);
    } else if (focusEdit.current) {
      focusEdit.current = false;
      lanes.current
        ?.querySelector<HTMLElement>('[data-conflict-action="edit"]')
        ?.focus();
    }
  }, [editing]);

  function cancel() {
    focusEdit.current = true;
    setDraft(null);
  }

  function apply(text: string) {
    const path = replaceConflict(
      editor,
      element,
      deserializeAmbiguousConflictText(editor, text, markerSize),
    );
    if (!path) return;
    editor.tf.focus(
      editor.api.node(path)
        ? { at: path, edge: "start" }
        : { edge: "endEditor" },
    );
  }

  return (
    <PlateElement
      {...props}
      attributes={{ ...props.attributes, contentEditable: false }}
    >
      <ConflictLanes
        ref={lanes}
        heading={m.git_conflict_ambiguous_title()}
        note={
          editing
            ? m.git_conflict_ambiguous_editing()
            : m.git_conflict_ambiguous_description()
        }
        disabled={readOnly}
        actions={
          editing
            ? [
                {
                  key: "apply",
                  label: m.git_conflict_apply(),
                  onSelect: () => apply(draft ?? ""),
                },
                {
                  key: "cancel",
                  label: m.git_conflict_cancel(),
                  onSelect: cancel,
                },
              ]
            : [
                {
                  key: "edit",
                  label: m.git_conflict_edit(),
                  onSelect: () =>
                    setDraft(ambiguousConflictFieldText(ambiguous)),
                },
              ]
        }
      >
        <ConflictLane side={null}>
          {editing ? (
            <ConflictLinesField
              ref={field}
              aria-label={m.git_conflict_ambiguous_title()}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }}
              // The field owns its input and its native undo: they must not
              // reach the editor of the Page around it.
              onInput={(event) => event.stopPropagation()}
              onDrop={(event) => event.stopPropagation()}
            />
          ) : (
            <ConflictLines>
              {ambiguous.lines.map((line, index) => (
                <span
                  key={index}
                  data-conflict-marker={line.marker || undefined}
                  className={line.marker ? "text-muted-foreground" : undefined}
                >
                  {line.text}
                  {index < ambiguous.lines.length - 1 ? "\n" : null}
                </span>
              ))}
            </ConflictLines>
          )}
        </ConflictLane>
      </ConflictLanes>
      {props.children}
    </PlateElement>
  );
}

function SidesConflict(props: PlateElementProps<TConflictElement>) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element;
  const { ours, theirs, base } = element;
  const sides = useMemo(
    () => diffConflictSides(editor, { ours, theirs, base }),
    [editor, ours, theirs, base],
  );

  function accept(markdowns: string[]) {
    replaceConflict(
      editor,
      element,
      deserializeConflictBranches(editor, markdowns),
    );
  }

  return (
    <PlateElement
      {...props}
      attributes={{ ...props.attributes, contentEditable: false }}
    >
      <ConflictLanes
        disabled={readOnly}
        note={sides.againstBase ? null : m.git_conflict_no_base()}
        actions={[
          {
            key: "ours",
            side: "ours",
            label: m.changes_conflict_accept_ours(),
            onSelect: () => accept([ours]),
          },
          {
            key: "theirs",
            side: "theirs",
            label: m.changes_conflict_accept_theirs(),
            onSelect: () => accept([theirs]),
          },
          {
            key: "both",
            label: m.changes_conflict_accept_both(),
            onSelect: () => accept([ours, theirs]),
          },
        ]}
      >
        <ConflictLane side="ours">
          <ConflictSideView value={sides.ours} />
        </ConflictLane>
        <ConflictLane side="theirs">
          <ConflictSideView value={sides.theirs} />
        </ConflictLane>
      </ConflictLanes>
      {props.children}
    </PlateElement>
  );
}
