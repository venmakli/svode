import { MarkdownPlugin } from "@platejs/markdown";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";

import { Editor, EditorContainer } from "@/components/ui/editor";
import { cn } from "@/shared/lib/utils";

import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { EditorKit } from "./editor-kit";

interface ControlledMarkdownEditorProps {
  disabled?: boolean;
  placeholder?: string;
  value: string;
  onChange(value: string): void;
}

export function ControlledMarkdownEditor({
  disabled = false,
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
      <EditorContainer
        variant="select"
        className={cn(
          disabled ? "min-h-12 has-data-readonly:w-full" : "min-h-48",
        )}
      >
        <Editor
          variant="select"
          className={cn(
            disabled ? "min-h-12 data-readonly:w-full" : "min-h-48",
          )}
          placeholder={placeholder}
        />
      </EditorContainer>
    </Plate>
  );
}
