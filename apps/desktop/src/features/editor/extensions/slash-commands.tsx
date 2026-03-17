import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import type {
  SuggestionOptions,
  SuggestionProps,
  SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import * as m from "@/paraglide/messages.js";

export interface SlashCommandItem {
  title: string;
  description: string;
  icon: string;
  aliases: string[];
  command: (props: { editor: unknown; range: unknown }) => void;
}

function getSlashCommands(): SlashCommandItem[] {
  return [
    {
      title: m.editor_slash_heading1(),
      description: "H1",
      icon: "H1",
      aliases: ["h1", "heading1", "заголовок", "заголовок1"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run();
      },
    },
    {
      title: m.editor_slash_heading2(),
      description: "H2",
      icon: "H2",
      aliases: ["h2", "heading2", "заголовок2"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run();
      },
    },
    {
      title: m.editor_slash_heading3(),
      description: "H3",
      icon: "H3",
      aliases: ["h3", "heading3", "заголовок3"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run();
      },
    },
    {
      title: m.editor_slash_bullet(),
      description: "•",
      icon: "•",
      aliases: ["ul", "bullet", "список"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      },
    },
    {
      title: m.editor_slash_numbered(),
      description: "1.",
      icon: "1.",
      aliases: ["ol", "numbered", "нумерованный"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
    },
    {
      title: m.editor_slash_checklist(),
      description: "☑",
      icon: "☑",
      aliases: ["todo", "checklist", "задачи"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run();
      },
    },
    {
      title: m.editor_slash_quote(),
      description: "❝",
      icon: "❝",
      aliases: ["quote", "blockquote", "цитата"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      },
    },
    {
      title: m.editor_slash_divider(),
      description: "─",
      icon: "─",
      aliases: ["hr", "divider", "линия"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
      },
    },
    {
      title: m.editor_slash_code(),
      description: "{}",
      icon: "{}",
      aliases: ["code", "codeblock", "код"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      },
    },
    {
      title: m.editor_slash_callout(),
      description: "💡",
      icon: "💡",
      aliases: ["callout", "заметка", "info"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setCallout({ type: "info" })
          .run();
      },
    },
    {
      title: m.editor_slash_table(),
      description: "▦",
      icon: "▦",
      aliases: ["table", "таблица"],
      command: ({ editor, range }: { editor: any; range: any }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
      },
    },
  ];
}

function SlashCommandList({
  items,
  command,
}: {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[selectedIndex]) {
          command(items[selectedIndex]);
        }
      }
    },
    [items, selectedIndex, command],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const selected = container.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="z-50 w-56 overflow-hidden rounded-lg border bg-popover p-1 shadow-md max-h-[320px] overflow-y-auto"
    >
      {items.map((item, index) => (
        <button
          key={item.title}
          type="button"
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
            index === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50"
          }`}
          onClick={() => command(item)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="w-6 text-center text-xs font-mono shrink-0">
            {item.icon}
          </span>
          <span>{item.title}</span>
        </button>
      ))}
    </div>
  );
}

export const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: unknown;
          range: unknown;
          props: SlashCommandItem;
        }) => {
          props.command({ editor, range });
        },
        items: ({ query }: { query: string }) => {
          const commands = getSlashCommands();
          if (!query) return commands.slice(0, 10);

          const lower = query.toLowerCase();
          return commands
            .filter(
              (item) =>
                item.title.toLowerCase().includes(lower) ||
                item.aliases.some((a) => a.includes(lower)),
            )
            .slice(0, 10);
        },
        render: () => {
          let container: HTMLDivElement | null = null;
          let root: ReturnType<typeof createRoot> | null = null;

          return {
            onStart: (props: SuggestionProps<SlashCommandItem>) => {
              container = document.createElement("div");
              document.body.appendChild(container);

              root = createRoot(container);
              root.render(
                <SlashCommandList
                  items={props.items}
                  command={props.command}
                />,
              );

              if (props.clientRect) {
                const rect = props.clientRect();
                if (rect && container) {
                  container.style.position = "fixed";
                  container.style.left = `${rect.left}px`;
                  container.style.top = `${rect.bottom + 4}px`;
                  container.style.zIndex = "50";
                }
              }
            },
            onUpdate: (props: SuggestionProps<SlashCommandItem>) => {
              if (root) {
                root.render(
                  <SlashCommandList
                    items={props.items}
                    command={props.command}
                  />,
                );
              }

              if (props.clientRect && container) {
                const rect = props.clientRect();
                if (rect) {
                  container.style.left = `${rect.left}px`;
                  container.style.top = `${rect.bottom + 4}px`;
                }
              }
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === "Escape") {
                if (container) {
                  root?.unmount();
                  container.remove();
                  container = null;
                  root = null;
                }
                return true;
              }
              if (
                props.event.key === "ArrowDown" ||
                props.event.key === "ArrowUp" ||
                props.event.key === "Enter"
              ) {
                return true;
              }
              return false;
            },
            onExit: () => {
              if (container) {
                root?.unmount();
                container.remove();
                container = null;
                root = null;
              }
            },
          };
        },
      } as Partial<SuggestionOptions<SlashCommandItem>>,
    };
  },

  addProseMirrorPlugins() {
    const self = this as any;
    return [
      Suggestion({
        editor: self.editor,
        ...self.options.suggestion,
      }),
    ];
  },
});
