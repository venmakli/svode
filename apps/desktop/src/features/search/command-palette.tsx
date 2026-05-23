import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
} from "@/components/ui/command";
import { useSpaceStore } from "@/stores/space";
import { useCommandPaletteStore } from "./store";
import { useSearch } from "./use-search";
import { useSelectResult } from "./use-select-result";
import { ResultItem } from "./result-item";
import { dedupKey } from "./utils";
import type { SearchItem } from "./types";
import { isTerminalKeyboardEvent } from "@/features/terminal";
import * as m from "@/paraglide/messages.js";

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const toggle = useCommandPaletteStore((s) => s.toggle);

  const activeRootPath = useSpaceStore((s) => s.activeRootPath);

  // ⌘P / Ctrl+P toggles the palette. Bound only inside a project (the /space
  // route is mounted) so the Home page doesn't intercept the shortcut.
  useEffect(() => {
    if (!activeRootPath) return;
    function onKey(e: KeyboardEvent) {
      if (isTerminalKeyboardEvent(e)) return;
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key.toLowerCase() === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeRootPath, toggle]);

  if (!open) return null;

  return (
    <CommandPaletteDialog
      activeRootPath={activeRootPath}
      open={open}
      setOpen={setOpen}
    />
  );
}

function CommandPaletteDialog({
  activeRootPath,
  open,
  setOpen,
}: {
  activeRootPath: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const search = useSearch(query, activeRootPath);
  const handleSelect = useSelectResult();

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
        <SearchResults search={search} onSelect={handleSelect} />
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

function SearchResults({
  search,
  onSelect,
}: {
  search: ReturnType<typeof useSearch>;
  onSelect: (item: SearchItem) => void;
}) {
  if (search.isEmpty) {
    if (search.recent.length === 0) {
      return <CommandEmpty>{m.search_empty_prompt()}</CommandEmpty>;
    }
    return (
      <CommandGroup heading={m.search_group_recent()}>
        {search.recent.map((item) => (
          <ResultItem key={dedupKey(item)} item={item} onSelect={onSelect} />
        ))}
      </CommandGroup>
    );
  }

  if (search.titles.length === 0 && search.contents.length === 0) {
    if (search.isLoading) return null;
    return <CommandEmpty>{m.search_no_results()}</CommandEmpty>;
  }

  return (
    <>
      {search.titles.length > 0 && (
        <CommandGroup heading={m.search_group_titles()}>
          {search.titles.map((item) => (
            <ResultItem key={dedupKey(item)} item={item} onSelect={onSelect} />
          ))}
        </CommandGroup>
      )}
      {search.contents.length > 0 && (
        <>
          {search.titles.length > 0 && <CommandSeparator />}
          <CommandGroup heading={m.search_group_contents()}>
            {search.contents.map((item) => (
              <ResultItem key={dedupKey(item)} item={item} onSelect={onSelect} />
            ))}
          </CommandGroup>
        </>
      )}
    </>
  );
}
