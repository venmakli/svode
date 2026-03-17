import { useState, useCallback } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  Strikethrough,
  Highlighter,
  Code,
  Link,
  MoreHorizontal,
  Underline as UnderlineIcon,
} from "lucide-react";

const COLORS = [
  { label: "Default", value: "" },
  { label: "Red", value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Yellow", value: "#eab308" },
  { label: "Green", value: "#22c55e" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Purple", value: "#a855f7" },
  { label: "Pink", value: "#ec4899" },
];

interface EditorBubbleMenuProps {
  editor: Editor;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cmd(editor: Editor): any {
  return editor.chain().focus();
}

interface ToolbarButtonProps {
  pressed: boolean;
  onPressedChange: () => void;
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}

function ToolbarButton({
  pressed,
  onPressedChange,
  label,
  shortcut,
  children,
}: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          pressed={pressed}
          onPressedChange={onPressedChange}
          aria-label={label}
        >
          {children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {label}
        {shortcut && (
          <kbd
            data-slot="kbd"
            className="ml-1.5 inline-flex h-5 items-center rounded bg-background/20 px-1 font-mono text-[10px]"
          >
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function EditorBubbleMenu({ editor }: EditorBubbleMenuProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const handleLinkSubmit = useCallback(() => {
    if (linkUrl) {
      cmd(editor).setLink({ href: linkUrl }).run();
    } else {
      cmd(editor).unsetLink().run();
    }
    setLinkUrl("");
    setLinkOpen(false);
  }, [editor, linkUrl]);

  const handleLinkOpen = useCallback(() => {
    const existing = editor.getAttributes("link").href ?? "";
    setLinkUrl(existing);
    setLinkOpen(true);
  }, [editor]);

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: e, state }: { editor: Editor; state: any }) => {
        const { from, to } = state.selection;
        if (from === to) return false;
        if (e.isActive("codeBlock")) return false;
        return true;
      }}
      className="flex items-center gap-0.5 rounded-lg border bg-background p-1 shadow-lg"
    >
      <TooltipProvider delayDuration={300}>
        <ToolbarButton
          pressed={editor.isActive("bold")}
          onPressedChange={() => cmd(editor).toggleBold().run()}
          label="Bold"
          shortcut="⌘B"
        >
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          pressed={editor.isActive("italic")}
          onPressedChange={() => cmd(editor).toggleItalic().run()}
          label="Italic"
          shortcut="⌘I"
        >
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          pressed={editor.isActive("strike")}
          onPressedChange={() => cmd(editor).toggleStrike().run()}
          label="Strikethrough"
          shortcut="⌘⇧S"
        >
          <Strikethrough className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          pressed={editor.isActive("highlight")}
          onPressedChange={() => cmd(editor).toggleHighlight().run()}
          label="Highlight"
          shortcut="⌘⇧H"
        >
          <Highlighter className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          pressed={editor.isActive("code")}
          onPressedChange={() => cmd(editor).toggleCode().run()}
          label="Code"
          shortcut="⌘E"
        >
          <Code className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-0.5" />

        {/* Link popover */}
        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Toggle
                  size="sm"
                  pressed={editor.isActive("link")}
                  onPressedChange={handleLinkOpen}
                  aria-label="Link"
                >
                  <Link className="h-4 w-4" />
                </Toggle>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
              Link
              <kbd
                data-slot="kbd"
                className="ml-1.5 inline-flex h-5 items-center rounded bg-background/20 px-1 font-mono text-[10px]"
              >
                ⌘K
              </kbd>
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            className="w-72 p-3"
            side="top"
            align="start"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleLinkSubmit();
              }}
              className="flex gap-2"
            >
              <Input
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://..."
                className="h-8 text-sm"
                autoFocus
              />
              <Button type="submit" size="sm" className="h-8 px-3">
                OK
              </Button>
            </form>
          </PopoverContent>
        </Popover>

        <Separator orientation="vertical" className="h-6 mx-0.5" />

        {/* Color dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm font-medium hover:bg-muted transition-colors"
            >
              <span className="font-bold text-xs">A</span>
              <span className="text-[8px] ml-0.5">▾</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[120px]">
            {COLORS.map((color) => (
              <DropdownMenuItem
                key={color.value || "default"}
                onClick={() => {
                  if (color.value) {
                    cmd(editor).setColor(color.value).run();
                  } else {
                    cmd(editor).unsetColor().run();
                  }
                }}
              >
                <span
                  className="w-3 h-3 rounded-full border mr-2 shrink-0"
                  style={{
                    backgroundColor: color.value || "currentColor",
                  }}
                />
                {color.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Overflow menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm hover:bg-muted transition-colors"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => cmd(editor).toggleUnderline().run()}
            >
              <UnderlineIcon className="h-4 w-4 mr-2" />
              Underline
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    </BubbleMenu>
  );
}
