"use client";

import type { Descendant, TElement } from "platejs";
import {
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
  useEditorRef,
  useReadOnly,
} from "platejs/react";
import { useMemo } from "react";
import * as m from "@/paraglide/messages.js";
import {
  type AmbiguousConflictElement,
  type ConflictElement as TConflictElement,
  deserializeAmbiguousConflictEdit,
  deserializeConflictBranches,
  isAmbiguousConflict,
} from "./parse-conflicts";
import { diffConflictSides } from "./conflict-diff";
import { ConflictLane, ConflictLanes, ConflictLines } from "./conflict-lanes";
import { ConflictSideView } from "./conflict-side-view";

/** Put `fragment` in place of the conflict `element`. */
function replaceConflict(
  editor: PlateEditor,
  element: TElement,
  fragment: Descendant[],
) {
  const path = editor.api.findPath(element);
  if (!path) return;
  editor.tf.removeNodes({ at: path });
  editor.tf.insertNodes(fragment as never, { at: path });
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
  const editor = useEditorRef();
  const element = props.element;

  if (isAmbiguousConflict(element)) {
    const { lines, edit } = element.ambiguous;
    return (
      <PlateElement
        {...props}
        attributes={{ ...props.attributes, contentEditable: false }}
      >
        <ConflictLanes
          heading={m.git_conflict_ambiguous_title()}
          note={m.git_conflict_ambiguous_description()}
          disabled={false}
          actions={[
            {
              key: "edit",
              label: m.git_conflict_edit(),
              onSelect: () =>
                replaceConflict(
                  editor,
                  element,
                  deserializeAmbiguousConflictEdit(editor, edit),
                ),
            },
          ]}
        >
          <ConflictLane side={null}>
            <ConflictLines>
              {lines.map((line, index) => (
                <span
                  key={index}
                  data-conflict-marker={line.marker || undefined}
                  className={line.marker ? "text-muted-foreground" : undefined}
                >
                  {line.text}
                  {index < lines.length - 1 ? "\n" : null}
                </span>
              ))}
            </ConflictLines>
          </ConflictLane>
        </ConflictLanes>
        {props.children}
      </PlateElement>
    );
  }

  return <SidesConflict {...props} element={element} />;
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
