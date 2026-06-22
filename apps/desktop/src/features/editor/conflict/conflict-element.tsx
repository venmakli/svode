"use client";

import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
} from "platejs/react";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { type ConflictElement as TConflictElement } from "./parse-conflicts";

/**
 * Renders a git merge-conflict block as two stacked panels (ours / theirs)
 * with Accept / Edit actions. Void element — the surrounding text is normal.
 */
export function ConflictElementComponent(
  props: PlateElementProps<TConflictElement>,
) {
  const editor = useEditorRef();
  const element = props.element;

  function replaceWithMarkdown(markdown: string) {
    const path = editor.api.findPath(element);
    if (!path) return;
    const fragment = deserializeEditorMarkdownInsertion(
      editor,
      markdown.trim() + "\n",
    );
    editor.tf.removeNodes({ at: path });
    editor.tf.insertNodes(fragment as never, { at: path });
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
