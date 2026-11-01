"use client";

import type { Descendant, TElement } from "platejs";
import {
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
  useEditorRef,
  useReadOnly,
} from "platejs/react";
import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import {
  type AmbiguousConflictElement,
  type ConflictElement as TConflictElement,
  deserializeAmbiguousConflictEdit,
  deserializeConflictBranches,
  isAmbiguousConflict,
} from "./parse-conflicts";
import { diffConflictSides } from "./conflict-diff";
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
 * Renders a git merge-conflict block as its two sides rendered as text with
 * what each changed marked and Accept mine / incoming / both, or a block
 * whose marker lines allow more than one split as its whole text with Edit
 * only. Void element — the surrounding text is normal.
 */
export function ConflictElementComponent(
  props: PlateElementProps<TConflictElement | AmbiguousConflictElement>,
) {
  const editor = useEditorRef();
  const element = props.element;
  const titleId = useId();

  if (isAmbiguousConflict(element)) {
    const { lines, edit } = element.ambiguous;
    return (
      <PlateElement
        {...props}
        attributes={{
          ...props.attributes,
          contentEditable: false,
          role: "group",
          "aria-labelledby": titleId,
        }}
        className="my-3 rounded-md border border-yellow-600/40 bg-yellow-50/40 dark:bg-yellow-950/20"
      >
        <div className="p-2 text-xs">
          <div
            id={titleId}
            className="font-medium text-yellow-700 dark:text-yellow-400"
          >
            ⚠ {m.git_conflict_ambiguous_title()}
          </div>
          <p className="mt-1 text-muted-foreground">
            {m.git_conflict_ambiguous_description()}
          </p>
        </div>
        <div className="border-t border-yellow-600/40 p-3">
          <pre className="whitespace-pre-wrap text-sm font-mono">
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
          </pre>
        </div>
        <div className="border-t border-yellow-600/40 p-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              replaceConflict(
                editor,
                element,
                deserializeAmbiguousConflictEdit(editor, edit),
              )
            }
          >
            {m.git_conflict_edit()}
          </Button>
        </div>
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
  const titleId = useId();
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
      attributes={{
        ...props.attributes,
        contentEditable: false,
        role: "group",
        "aria-labelledby": titleId,
      }}
      className="my-3 rounded-md border border-yellow-600/40 bg-yellow-50/40 dark:bg-yellow-950/20"
    >
      <div className="p-2 text-xs">
        <div
          id={titleId}
          className="font-medium text-yellow-700 dark:text-yellow-400"
        >
          ⚠ {m.git_conflict_title()}
        </div>
        {sides.againstBase ? null : (
          <p className="mt-1 text-muted-foreground">
            {m.git_conflict_no_base()}
          </p>
        )}
      </div>
      <section
        aria-label={m.git_conflict_ours()}
        className="border-t border-yellow-600/40 p-3"
      >
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {m.git_conflict_ours()}
        </div>
        <ConflictSideView value={sides.ours} />
      </section>
      <section
        aria-label={m.git_conflict_theirs()}
        className="border-t border-yellow-600/40 p-3"
      >
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {m.git_conflict_theirs()}
        </div>
        <ConflictSideView value={sides.theirs} />
      </section>
      <div className="flex flex-wrap justify-end gap-2 border-t border-yellow-600/40 p-2">
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() => accept([ours])}
        >
          {m.changes_conflict_accept_ours()}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() => accept([theirs])}
        >
          {m.changes_conflict_accept_theirs()}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() => accept([ours, theirs])}
        >
          {m.changes_conflict_accept_both()}
        </Button>
      </div>
      {props.children}
    </PlateElement>
  );
}
