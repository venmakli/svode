import * as React from "react";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { useSpaceStore } from "@/stores/space";
import { useLayoutStore } from "@/stores/layout";
import { useCommandPaletteStore } from "./store";
import { useSearch } from "./use-search";
import type { SearchItem } from "./types";
import * as m from "@/paraglide/messages.js";

function dedupKey(item: SearchItem): string {
  return `${item.spaceId ?? ""}::${item.path}`;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx) + "/";
}

function joinAbs(spacePath: string, rel: string): string {
  if (!rel) return spacePath;
  if (spacePath.endsWith("/")) return spacePath + rel;
  return spacePath + "/" + rel;
}

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const toggle = useCommandPaletteStore((s) => s.toggle);

  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const activeRootPath = useSpaceStore((s) => s.activeRootPath);
  const spaces = useSpaceStore((s) => s.spaces);
  const openSpace = useSpaceStore((s) => s.openSpace);
  const clearActiveSpace = useSpaceStore((s) => s.clearActiveSpace);
  const openDocument = useLayoutStore((s) => s.openDocument);

  const [query, setQuery] = useState("");

  // Reset query when palette closes.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Hotkey: ⌘P / Ctrl+P toggles the palette. Only active when activeRootPath
  // is set — i.e. we're inside a project (the /space route is mounted).
  useEffect(() => {
    if (!activeRootPath) return;
    function onKey(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key.toLowerCase() === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeRootPath, toggle]);

  const search = useSearch(query, activeRootPath);

  const handleSelect = useCallback(
    (item: SearchItem) => {
      // Refetch SpaceInfo.status from in-memory cache (per spec §Q4).
      // spaceId === null → root; otherwise look up child space by id.
      const targetSpace =
        item.spaceId === null
          ? null
          : spaces.find((s) => s.id === item.spaceId);

      if (item.spaceId !== null) {
        if (!targetSpace) {
          toast.error(m.search_space_unavailable({ name: item.spaceName }));
          return;
        }
        if (targetSpace.status !== "ready") {
          toast.error(m.search_space_unavailable({ name: item.spaceName }));
          return;
        }
      }

      const absPath = joinAbs(item.spacePath, item.path);
      const targetSpaceId =
        item.spaceId === null ? activeRootId : item.spaceId;

      // Switch active child space if different. null = root → clear active.
      if (item.spaceId === null) {
        clearActiveSpace();
      } else if (item.spaceId !== useSpaceStore.getState().activeSpaceId) {
        void openSpace(item.spaceId);
      }

      openDocument(absPath, targetSpaceId ?? undefined);
      setOpen(false);
    },
    [
      spaces,
      activeRootId,
      clearActiveSpace,
      openSpace,
      openDocument,
      setOpen,
    ],
  );

  const showProgress =
    search.totalSpaces > 1 &&
    search.indexedSpaces < search.totalSpaces &&
    !search.isEmpty;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={m.search_dialog_title()}
      description={m.search_dialog_description()}
      shouldFilter={false}
    >
      <CommandInput
        placeholder={m.search_placeholder()}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {search.isEmpty ? (
          search.recent.length === 0 ? (
            <CommandEmpty>{m.search_empty_prompt()}</CommandEmpty>
          ) : (
            <CommandGroup heading={m.search_group_recent()}>
              {search.recent.map((item) => (
                <ResultItem
                  key={dedupKey(item)}
                  item={item}
                  onSelect={handleSelect}
                />
              ))}
            </CommandGroup>
          )
        ) : search.titles.length === 0 && search.contents.length === 0 ? (
          search.isLoading ? null : (
            <CommandEmpty>{m.search_no_results()}</CommandEmpty>
          )
        ) : (
          <>
            {search.titles.length > 0 && (
              <CommandGroup heading={m.search_group_titles()}>
                {search.titles.map((item) => (
                  <ResultItem
                    key={dedupKey(item)}
                    item={item}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            )}
            {search.contents.length > 0 && (
              <>
                {search.titles.length > 0 && <CommandSeparator />}
                <CommandGroup heading={m.search_group_contents()}>
                  {search.contents.map((item) => (
                    <ResultItem
                      key={dedupKey(item)}
                      item={item}
                      onSelect={handleSelect}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>
      {showProgress && (
        <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          {m.search_indexing_progress({
            done: search.indexedSpaces,
            total: search.totalSpaces,
          })}
        </div>
      )}
    </CommandDialog>
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

function ResultItem({
  item,
  onSelect,
}: {
  item: SearchItem;
  onSelect: (item: SearchItem) => void;
}) {
  const dir = parentDir(item.path);
  const context = `${item.spaceName} · ${dir}`;
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
