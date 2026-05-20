import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Copy,
  Database,
  FileText,
  FolderOpen,
  MoreVertical,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSpaceStore } from "@/stores/space";
import type { Entry } from "@/features/editor/types";
import { handleError } from "../lib/errors";
import * as m from "@/paraglide/messages.js";

export interface EntryDetailState {
  form: "leaf" | "folder" | "nestedCollection";
  subpageCount: number;
  otherFileCount: number;
}

interface EntryDetailActionsProps {
  entry: Entry;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onConverted?: (entry: Entry, nested: boolean) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
}

export function EntryDetailActions({
  entry,
  spacePath,
  projectPath,
  spaceId,
  onConverted,
  onDuplicateEntry,
  onDeleteEntry,
}: EntryDetailActionsProps) {
  const refreshTree = useSpaceStore((state) => state.refreshTree);
  const [state, setState] = useState<EntryDetailState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    void invoke<EntryDetailState>("get_entry_detail_state", {
      space: spacePath,
      path: entry.path,
    })
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState(inferEntryDetailState(entry.path));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, spacePath]);

  const form = state?.form ?? inferEntryDetailState(entry.path).form;
  const leafDisabledReason = useMemo(() => {
    if (!state || form !== "folder") return null;
    const blocked = state.subpageCount > 0 || state.otherFileCount > 0;
    if (!blocked) return null;
    return m.entry_convert_leaf_blocked({
      subpages: state.subpageCount,
      files: state.otherFileCount,
    });
  }, [form, state]);

  async function refreshDetail(path: string) {
    await refreshTree(spaceId);
    const [nextEntry, nextState] = await Promise.all([
      invoke<Entry>("read_entry", { space: spacePath, path }),
      invoke<EntryDetailState>("get_entry_detail_state", {
        space: spacePath,
        path,
      }).catch(() => null),
    ]);
    if (nextState) setState(nextState);
    return nextEntry;
  }

  async function convertToFolder() {
    const next = await invoke<Entry>("convert_entry_to_folder", {
      space: spacePath,
      entryId: entry.meta.id,
      projectPath: projectPath ?? null,
    });
    await refreshTree(spaceId);
    setState({ form: "folder", subpageCount: 0, otherFileCount: 0 });
    onConverted?.(next, false);
  }

  async function convertToLeaf() {
    if (leafDisabledReason) return;
    const next = await invoke<Entry>("convert_entry_to_leaf", {
      space: spacePath,
      entryId: entry.meta.id,
      projectPath: projectPath ?? null,
    });
    await refreshTree(spaceId);
    setState({ form: "leaf", subpageCount: 0, otherFileCount: 0 });
    onConverted?.(next, false);
  }

  async function convertToNestedCollection() {
    await invoke("convert_entry_to_nested_collection", {
      space: spacePath,
      entryId: entry.meta.id,
      projectPath: projectPath ?? null,
    });
    const next = await refreshDetail(entry.path);
    onConverted?.(next, true);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <MoreVertical />
          <span className="sr-only">{m.entry_actions()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {form === "leaf" ? (
          <DropdownMenuItem
            onClick={() => void convertToFolder().catch(handleError)}
          >
            <FolderOpen data-icon="inline-start" />
            {m.entry_convert_to_folder()}
          </DropdownMenuItem>
        ) : null}
        {form === "folder" ? (
          <>
            <DropdownMenuItem
              disabled={Boolean(leafDisabledReason)}
              title={leafDisabledReason ?? undefined}
              onSelect={(event) => {
                if (leafDisabledReason) {
                  event.preventDefault();
                  return;
                }
                void convertToLeaf().catch(handleError);
              }}
            >
              <FileText data-icon="inline-start" />
              {m.entry_convert_to_leaf()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void convertToNestedCollection().catch(handleError)
              }
            >
              <Database data-icon="inline-start" />
              {m.entry_convert_to_nested_collection()}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem onClick={() => onDuplicateEntry(entry)}>
          <Copy data-icon="inline-start" />
          {m.collection_duplicate_entry()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onDeleteEntry(entry)}
        >
          <Trash2 data-icon="inline-start" />
          {m.entry_delete_row()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function inferEntryDetailState(path: string): EntryDetailState {
  return path.toLowerCase().endsWith("/readme.md")
    ? { form: "folder", subpageCount: 0, otherFileCount: 0 }
    : { form: "leaf", subpageCount: 0, otherFileCount: 0 };
}
