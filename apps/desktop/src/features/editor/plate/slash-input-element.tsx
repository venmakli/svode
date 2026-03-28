import type { PlateEditor, PlateElementProps } from "platejs/react";

import { insertCallout } from "@platejs/callout";
import { insertCodeBlock } from "@platejs/code-block";
import { TablePlugin } from "@platejs/table/react";
import {
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrdered,
  Square,
  Quote,
  MinusIcon,
  Code2,
  LightbulbIcon,
  Table,
  ChevronRight,
} from "lucide-react";
import { type TComboboxInputElement, KEYS } from "platejs";
import { PlateElement } from "platejs/react";
import * as m from "@/paraglide/messages.js";

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from "@/components/ui/inline-combobox";

interface SlashItem {
  icon: React.ReactNode;
  value: string;
  keywords: string[];
  label: string;
  onSelect: (editor: PlateEditor, value: string) => void;
}

function getSlashItems(): SlashItem[] {
  return [
    {
      icon: <Heading1Icon />,
      keywords: ["h1", "heading1", "заголовок", "заголовок1"],
      label: m.editor_slash_heading1(),
      value: KEYS.h1,
      onSelect: (editor) => {
        editor.tf.setNodes({ type: KEYS.h1 }, { mode: "lowest" });
      },
    },
    {
      icon: <Heading2Icon />,
      keywords: ["h2", "heading2", "заголовок2"],
      label: m.editor_slash_heading2(),
      value: KEYS.h2,
      onSelect: (editor) => {
        editor.tf.setNodes({ type: KEYS.h2 }, { mode: "lowest" });
      },
    },
    {
      icon: <Heading3Icon />,
      keywords: ["h3", "heading3", "заголовок3"],
      label: m.editor_slash_heading3(),
      value: KEYS.h3,
      onSelect: (editor) => {
        editor.tf.setNodes({ type: KEYS.h3 }, { mode: "lowest" });
      },
    },
    {
      icon: <ListIcon />,
      keywords: ["ul", "bullet", "список"],
      label: m.editor_slash_bullet(),
      value: KEYS.ul,
      onSelect: (editor) => {
        editor.tf.setNodes({ type: KEYS.ul }, { mode: "lowest" });
      },
    },
    {
      icon: <ListOrdered />,
      keywords: ["ol", "numbered", "нумерованный"],
      label: m.editor_slash_numbered(),
      value: KEYS.ol,
      onSelect: (editor) => {
        editor.tf.setNodes({ type: KEYS.ol }, { mode: "lowest" });
      },
    },
    {
      icon: <Square />,
      keywords: ["todo", "checklist", "задачи"],
      label: m.editor_slash_checklist(),
      value: KEYS.listTodo,
      onSelect: (editor) => {
        editor.tf.setNodes(
          { type: KEYS.listTodo, checked: false },
          { mode: "lowest" },
        );
      },
    },
    {
      icon: <Quote />,
      keywords: ["quote", "blockquote", "цитата"],
      label: m.editor_slash_quote(),
      value: KEYS.blockquote,
      onSelect: (editor) => {
        editor.tf.setNodes({ type: KEYS.blockquote }, { mode: "lowest" });
      },
    },
    {
      icon: <MinusIcon />,
      keywords: ["hr", "divider", "линия"],
      label: m.editor_slash_divider(),
      value: KEYS.hr,
      onSelect: (editor) => {
        editor.tf.insertNodes({ type: KEYS.hr, children: [{ text: "" }] });
      },
    },
    {
      icon: <Code2 />,
      keywords: ["code", "codeblock", "код"],
      label: m.editor_slash_code(),
      value: KEYS.codeBlock,
      onSelect: (editor) => {
        insertCodeBlock(editor, { select: true });
      },
    },
    {
      icon: <LightbulbIcon />,
      keywords: ["callout", "заметка", "info"],
      label: m.editor_slash_callout(),
      value: KEYS.callout,
      onSelect: (editor) => {
        insertCallout(editor, { select: true });
      },
    },
    {
      icon: <Table />,
      keywords: ["table", "таблица"],
      label: m.editor_slash_table(),
      value: KEYS.table,
      onSelect: (editor) => {
        editor
          .getTransforms(TablePlugin)
          .insert.table({}, { select: true });
      },
    },
    {
      icon: <ChevronRight />,
      keywords: ["toggle", "спойлер", "details", "collapsible"],
      label: m.editor_slash_toggle(),
      value: KEYS.toggle,
      onSelect: (editor) => {
        editor.tf.insertNodes({
          type: KEYS.toggle,
          children: [{ type: KEYS.p, children: [{ text: "" }] }],
        });
      },
    },
  ];
}

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { editor, element } = props;
  const items = getSlashItems();

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/">
        <InlineComboboxInput />

        <InlineComboboxContent>
          <InlineComboboxEmpty>No results</InlineComboboxEmpty>

          <InlineComboboxGroup>
            <InlineComboboxGroupLabel>Blocks</InlineComboboxGroupLabel>

            {items.map(({ icon, keywords, label, value, onSelect }) => (
              <InlineComboboxItem
                key={value}
                value={value}
                onClick={() => onSelect(editor, value)}
                label={label}
                focusEditor
                keywords={keywords}
              >
                <div className="mr-2 text-muted-foreground">{icon}</div>
                {label}
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  );
}
