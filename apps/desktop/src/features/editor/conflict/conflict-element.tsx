"use client";

import type { Descendant } from "platejs";
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
} from "platejs/react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import {
  type AmbiguousConflictElement,
  type ConflictElement as TConflictElement,
  deserializeAmbiguousConflictEdit,
  deserializeConflictBranch,
  isAmbiguousConflict,
} from "./parse-conflicts";

/**
 * Renders a git merge-conflict block as two stacked panels (ours / theirs)
 * with Accept / Edit actions, or a block whose marker lines allow more than
 * one split as its whole text with Edit only. Void element — the surrounding
 * text is normal.
 */
export function ConflictElementComponent(
  props: PlateElementProps<TConflictElement | AmbiguousConflictElement>,
) {
  const editor = useEditorRef();
  const element = props.element;
  const titleId = useId();

  function replaceWith(fragment: Descendant[]) {
    const path = editor.api.findPath(element);
    if (!path) return;
    editor.tf.removeNodes({ at: path });
    editor.tf.insertNodes(fragment as never, { at: path });
  }

  function replaceWithMarkdown(markdown: string) {
    replaceWith(deserializeConflictBranch(editor, markdown.trim() + "\n"));
  }

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
              replaceWith(deserializeAmbiguousConflictEdit(editor, edit))
            }
          >
            {m.git_conflict_edit()}
          </Button>
        </div>
        {props.children}
      </PlateElement>
    );
  }

  const handleAcceptOurs = () => replaceWithMarkdown(element.ours);
  const handleAcceptTheirs = () => replaceWithMarkdown(element.theirs);
  const handleEdit = () => {
    // Merge both sides into one editable block with a visible divider
    replaceWithMarkdown(`${element.ours}\n\n---\n\n${element.theirs}`);
  };

  return (
    <PlateElement
      {...props}
      attributes={{ ...props.attributes, contentEditable: false }}
      className="my-3 rounded-md border border-yellow-600/40 bg-yellow-50/40 dark:bg-yellow-950/20"
    >
      <div className="p-2 text-xs font-medium text-yellow-700 dark:text-yellow-400">
        ⚠ {m.git_conflict_ours()} / {m.git_conflict_theirs()}
      </div>
      <div className="border-t border-yellow-600/40 p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {m.git_conflict_ours()}
        </div>
        <pre className="whitespace-pre-wrap text-sm font-mono">
          {element.ours}
        </pre>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" onClick={handleAcceptOurs}>
            {m.git_conflict_accept()}
          </Button>
        </div>
      </div>
      <div className="border-t border-yellow-600/40 p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {m.git_conflict_theirs()}
        </div>
        <pre className="whitespace-pre-wrap text-sm font-mono">
          {element.theirs}
        </pre>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" onClick={handleAcceptTheirs}>
            {m.git_conflict_accept()}
          </Button>
        </div>
      </div>
      <div className="border-t border-yellow-600/40 p-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={handleEdit}>
          {m.git_conflict_edit()}
        </Button>
      </div>
      {props.children}
    </PlateElement>
  );
}
