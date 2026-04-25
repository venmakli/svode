import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
} from "react";
import { FileText } from "lucide-react";
import { useSpaceStore } from "@/stores/space";
import * as m from "@/paraglide/messages.js";
import type { TreeNode } from "@/types/space";

interface DocItem {
  title: string;
  path: string;
  icon: string | null;
}

/** Flatten tree into a flat list of documents. */
function flattenTree(nodes: TreeNode[]): DocItem[] {
  const items: DocItem[] = [];
  for (const node of nodes) {
    items.push({ title: node.title, path: node.path, icon: node.icon });
    if (node.children.length > 0) {
      items.push(...flattenTree(node.children));
    }
  }
  return items;
}

/** Simple fuzzy match: all query words must appear in the target (case-insensitive). */
function fuzzyMatch(target: string, query: string): boolean {
  const lower = target.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => lower.includes(word));
}

interface UseSlashMenuResult {
  isOpen: boolean;
  query: string;
  items: DocItem[];
  selectedIndex: number;
  handleInputChange: (value: string, cursorPos: number) => void;
  handleSelect: (item: DocItem) => string;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  close: () => void;
}

/**
 * Hook to manage /-slash menu state for a textarea.
 * Returns filtered document items, selection state, and handlers.
 */
export function useSlashMenu(
  currentValue: string,
  cursorPosition: number,
): UseSlashMenuResult {
  const { activeSpaceId, fileTrees } = useSpaceStore();
  const tree = activeSpaceId ? fileTrees[activeSpaceId] ?? [] : [];
  const allDocs = flattenTree(tree);

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Detect / trigger in text
  const handleInputChange = useCallback(
    (value: string, cursorPos: number) => {
      const before = value.slice(0, cursorPos);

      // Find the last / that could be a trigger
      const triggerIdx = before.lastIndexOf("/");

      if (triggerIdx === -1) {
        setIsOpen(false);
        return;
      }

      // / must be at start or preceded by whitespace
      if (triggerIdx > 0 && !/\s/.test(value[triggerIdx - 1])) {
        setIsOpen(false);
        return;
      }

      const afterTrigger = before.slice(triggerIdx + 1);

      // Close if there's a space with no query content (user moved on)
      if (afterTrigger.includes("\n")) {
        setIsOpen(false);
        return;
      }

      setTriggerStart(triggerIdx);
      setQuery(afterTrigger);
      setIsOpen(true);
      setSelectedIndex(0);
    },
    [],
  );

  // Filter docs by query
  const items = query
    ? allDocs.filter(
        (d) => fuzzyMatch(d.title, query) || fuzzyMatch(d.path, query),
      )
    : allDocs;

  // Handle selection: remove /query from text (doc is added as chip separately)
  const handleSelect = useCallback(
    (item: DocItem): string => {
      const before = currentValue.slice(0, triggerStart);
      const after = currentValue.slice(cursorPosition);
      const newValue = `${before}${after}`;
      setIsOpen(false);
      return newValue;
    },
    [currentValue, cursorPosition, triggerStart],
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isOpen || items.length === 0) return false;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          return true;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          return true;
        default:
          return false;
      }
    },
    [isOpen, items.length],
  );

  const close = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    query,
    items,
    selectedIndex,
    handleInputChange,
    handleSelect,
    handleKeyDown,
    close,
  };
}

/** Dropdown UI for slash menu — styled to match Plate InlineCombobox. */
export function SlashMenuDropdown({
  items,
  selectedIndex,
  onSelect,
}: {
  items: DocItem[];
  selectedIndex: number;
  onSelect: (item: DocItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector("[data-active-item=true]") as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div className="max-h-[288px] w-[300px] rounded-md bg-popover shadow-md">
        <div className="mx-1 flex h-[28px] select-none items-center rounded-sm px-2 text-muted-foreground text-sm">
          {m.chat_slash_no_results()}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-[288px] w-[300px] overflow-y-auto rounded-md bg-popover shadow-md"
    >
      <div className="py-1.5">
        <div className="mt-1.5 mb-2 px-3 font-medium text-muted-foreground text-xs">
          {m.chat_slash_group_documents()}
        </div>
        {items.map((item, index) => (
          <button
            key={item.path}
            type="button"
            data-active-item={index === selectedIndex}
            className={
              "mx-1 flex h-[28px] w-[calc(100%-8px)] cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-left text-foreground text-sm outline-none transition-colors" +
              (index === selectedIndex
                ? " bg-accent text-accent-foreground"
                : " hover:bg-accent hover:text-accent-foreground")
            }
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
          >
            <span className="flex-shrink-0 text-muted-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
              {item.icon ? (
                <span className="text-sm">{item.icon}</span>
              ) : (
                <FileText />
              )}
            </span>
            <span className="truncate">{item.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

