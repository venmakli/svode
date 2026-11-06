import { MarkdownPlugin } from "@platejs/markdown";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";

import { Editor, EditorContainer } from "@/components/ui/editor";
import { detailPageBodyClassName } from "@/shared/ui/page-layout";

import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { EditorKit } from "./editor-kit";

interface ControlledMarkdownEditorProps {
  disabled?: boolean;
  /** The accessible name of the body, which shows no label of its own. */
  label: string;
  placeholder?: string;
  value: string;
  onChange(value: string): void;
}

/** A Markdown value in the body of a page, without the page's file. */
export function ControlledMarkdownEditor({
  disabled = false,
  label,
  placeholder,
  value,
  onChange,
}: ControlledMarkdownEditorProps) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: (instance) =>
      deserializeEditorMarkdownInsertion(instance, value) as Value,
  });

  return (
    <Plate
      editor={editor}
      readOnly={disabled}
      onChange={({ value: nextValue }) => {
        if (
          disabled ||
          !editor.operations.some(
            (operation) => operation.type !== "set_selection",
          )
        ) {
          return;
        }
        onChange(
          editor.getApi(MarkdownPlugin).markdown.serialize({
            value: nextValue,
          }),
        );
      }}
    >
      <EditorContainer className="h-auto overflow-visible overflow-y-visible">
        <Editor
          variant="none"
          aria-label={label}
          className={detailPageBodyClassName}
          placeholder={placeholder}
        />
      </EditorContainer>
    </Plate>
  );
}
