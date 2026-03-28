import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
} from "react";
import { FileText } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import * as m from "@/paraglide/messages.js";
import type { TreeNode } from "@/types/workspace";

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

/** Extract [[Title]] mentions from message text, return matched doc items.
 *  Accepts TreeNode[] (flattens internally) or flat DocItem[]. */
export function extractMentions(
  text: string,
  docItems: TreeNode[] | DocItem[],
): DocItem[] {
  // Flatten if tree nodes (have children property)
  const flat: DocItem[] =
    docItems.length > 0 && "children" in docItems[0]
      ? flattenTree(docItems as TreeNode[])
      : (docItems as DocItem[]);
  const mentionPattern = /\[\[([^\]]+)\]\]/g;
  const mentions: DocItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text)) !== null) {
    const title = match[1].trim();
    if (!title) continue;
    const doc = flat.find(
      (d) => d.title === title || d.path === title,
    );
    if (doc && !mentions.some((m) => m.path === doc.path)) {
      mentions.push(doc);
    }
  }
  return mentions;
}

interface UseMentionDropdownResult {
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
 * Hook to manage [[-mention dropdown state for a textarea.
 * Returns filtered items, selection state, and handlers.
 */
export function useMentionDropdown(
  currentValue: string,
  cursorPosition: number,
): UseMentionDropdownResult {
  const { activeWorkspaceId, fileTrees } = useWorkspaceStore();
  const tree = activeWorkspaceId ? fileTrees[activeWorkspaceId] ?? [] : [];
  const allDocs = flattenTree(tree);

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [triggerStart, setTriggerStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Detect [[ trigger in text
  const handleInputChange = useCallback(
    (value: string, cursorPos: number) => {
      // Look backwards from cursor for [[
      const before = value.slice(0, cursorPos);
      const triggerIdx = before.lastIndexOf("[[");

      if (triggerIdx === -1) {
        setIsOpen(false);
        return;
      }

      // Check there's no ]] between trigger and cursor (mention already completed)
      const afterTrigger = before.slice(triggerIdx + 2);
      if (afterTrigger.includes("]]")) {
        setIsOpen(false);
        return;
      }

      // Check the trigger is not preceded by ] (which would be ]][ pattern)
      if (triggerIdx > 0 && value[triggerIdx - 1] === "]") {
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

  // Handle selection: replace [[query with [[Title]]
  const handleSelect = useCallback(
    (item: DocItem): string => {
      const before = currentValue.slice(0, triggerStart);
      const after = currentValue.slice(cursorPosition);
      const newValue = `${before}[[${item.title}]]${after}`;
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
          // Selection will be handled by the component
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

/** Dropdown UI for document mentions. */
export function MentionDropdown({
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
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        {m.editor_doc_link_no_results()}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-48 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
    >
      {items.map((item, index) => (
        <button
          key={item.path}
          type="button"
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            index === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent/50"
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // Don't steal focus from textarea
            onSelect(item);
          }}
        >
          <span className="flex-shrink-0 text-muted-foreground">
            {item.icon ? (
              <span className="text-sm">{item.icon}</span>
            ) : (
              <FileText className="h-4 w-4" />
            )}
          </span>
          <span className="truncate">{item.title}</span>
        </button>
      ))}
    </div>
  );
}
