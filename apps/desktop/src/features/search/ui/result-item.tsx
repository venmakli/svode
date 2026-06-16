import * as React from "react";
import { CommandItem } from "@/components/ui/command";
import { dedupKey, parentDir } from "../lib/utils";
import type { SearchItem } from "../model";

export function ResultItem({
  item,
  onSelect,
}: {
  item: SearchItem;
  onSelect: (item: SearchItem) => void;
}) {
  const context = `${item.spaceName} · ${parentDir(item.path)}`;
  return (
    <CommandItem
      value={dedupKey(item)}
      onSelect={() => onSelect(item)}
      className="flex flex-col items-stretch gap-0.5 py-2"
    >
      <div className="flex w-full items-center gap-2">
        <span className="shrink-0 text-base leading-none">{item.icon}</span>
        <span className="truncate flex-1 min-w-0">
          {item.title || item.path.split("/").pop()}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground truncate max-w-[40%]">
          {context}
        </span>
      </div>
      {item.snippet && (
        <div className="pl-6 text-xs text-muted-foreground line-clamp-1">
          {renderSnippet(item.snippet)}
        </div>
      )}
    </CommandItem>
  );
}

function renderSnippet(snippet: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /<mark>(.*?)<\/mark>/gs;
  let lastIdx = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(snippet)) !== null) {
    if (match.index > lastIdx) {
      parts.push(snippet.slice(lastIdx, match.index));
    }
    parts.push(
      <mark
        key={key++}
        className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5 text-foreground"
      >
        {match[1]}
      </mark>,
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < snippet.length) {
    parts.push(snippet.slice(lastIdx));
  }
  return parts;
}
