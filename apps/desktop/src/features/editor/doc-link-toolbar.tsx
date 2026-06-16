"use client";

import * as React from "react";

import type { TLinkElement } from "platejs";

import {
  type LinkFloatingToolbarState,
  FloatingLinkUrlInput,
  LinkPlugin,
  useFloatingLinkEdit,
  useFloatingLinkEditState,
  useFloatingLinkInsert,
  useFloatingLinkInsertState,
} from "@platejs/link/react";
import { upsertLink } from "@platejs/link";
import {
  type UseVirtualFloatingOptions,
  flip,
  offset,
} from "@platejs/floating";
import {
  ExternalLink,
  FileText,
  Link,
  Loader2,
  Search,
  Text,
  Unlink,
} from "lucide-react";
import { KEYS } from "platejs";
import {
  useEditorRef,
  useEditorSelection,
  useFormInputProps,
  usePluginOption,
} from "platejs/react";
import { invokeCommand as invoke } from "@/platform/native/invoke";

import { buttonVariants } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/shared/lib/utils";
import { useEditorStore } from "./model";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space";
import type { SearchItem } from "@/features/search";
import * as m from "@/paraglide/messages.js";
import {
  absoluteDocumentPath,
  findSpaceById,
  isDocLink,
  joinAbs,
  makeRelativeDocUrl,
  relativeDocumentPath,
  resolveRelativeDocPath,
  searchDocLinkTargets,
} from "./doc-link-utils";

type LinkMode = "document" | "url";

interface LinkResolveResult {
  targetSpaceId: string | null;
  targetSpacePath: string | null;
  targetPath: string | null;
  status: "ready" | "missing" | "broken" | "external";
  exists: boolean;
  spaceName: string;
}

interface LinkFixSuggestion {
  path: string;
  label: string;
  reason: string;
}

const popoverClassName =
  "z-50 w-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-hidden";

const inputClassName =
  "flex h-[28px] w-full rounded-md border-none bg-transparent px-1.5 py-1 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-transparent md:text-sm";

export function DocLinkFloatingToolbar({
  state,
}: {
  state?: LinkFloatingToolbarState;
}) {
  const activeCommentId = usePluginOption({ key: KEYS.comment }, "activeId");
  const activeSuggestionId = usePluginOption(
    { key: KEYS.suggestion },
    "activeId",
  );

  const floatingOptions: UseVirtualFloatingOptions = React.useMemo(
    () => ({
      middleware: [
        offset(8),
        flip({
          fallbackPlacements: ["bottom-end", "top-start", "top-end"],
          padding: 12,
        }),
      ],
      placement:
        activeSuggestionId || activeCommentId ? "top-start" : "bottom-start",
    }),
    [activeCommentId, activeSuggestionId],
  );

  const insertState = useFloatingLinkInsertState({
    ...state,
    floatingOptions: {
      ...floatingOptions,
      ...state?.floatingOptions,
    },
  });
  const {
    hidden,
    props: insertProps,
    ref: insertRef,
    textInputProps,
  } = useFloatingLinkInsert(insertState);

  const editState = useFloatingLinkEditState({
    ...state,
    floatingOptions: {
      ...floatingOptions,
      ...state?.floatingOptions,
    },
  });
  const {
    editButtonProps,
    props: editProps,
    ref: editRef,
    unlinkButtonProps,
  } = useFloatingLinkEdit(editState);
  const inputProps = useFormInputProps({
    preventDefaultOnEnterKeydown: true,
  });
  const [mode, setMode] = React.useState<LinkMode>("document");

  if (hidden) return null;

  const input = (
    <div className="flex w-[360px] flex-col gap-1" {...inputProps}>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(value) => {
          if (value === "document" || value === "url") setMode(value);
        }}
        variant="outline"
        size="sm"
        className="w-full"
      >
        <ToggleGroupItem value="document" className="flex-1">
          {m.doc_link_mode_document()}
        </ToggleGroupItem>
        <ToggleGroupItem value="url" className="flex-1">
          {m.doc_link_mode_url()}
        </ToggleGroupItem>
      </ToggleGroup>

      {mode === "document" ? (
        <DocLinkTargetPicker />
      ) : (
        <LegacyUrlInput textInputProps={textInputProps} />
      )}
    </div>
  );

  const editContent = editState.isEditing ? (
    input
  ) : (
    <DocLinkEditContent
      editButtonProps={editButtonProps}
      unlinkButtonProps={unlinkButtonProps}
    />
  );

  return (
    <>
      <div ref={insertRef} className={popoverClassName} {...insertProps}>
        {input}
      </div>

      <div ref={editRef} className={popoverClassName} {...editProps}>
        {editContent}
      </div>
    </>
  );
}

function LegacyUrlInput({
  textInputProps,
}: {
  textInputProps: React.InputHTMLAttributes<HTMLInputElement>;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center">
        <div className="flex items-center pr-1 pl-2 text-muted-foreground">
          <Link className="size-4" />
        </div>
        <FloatingLinkUrlInput
          className={inputClassName}
          placeholder={m.doc_link_url_placeholder()}
          data-plate-focus
        />
      </div>
      <Separator className="my-1" />
      <div className="flex items-center">
        <div className="flex items-center pr-1 pl-2 text-muted-foreground">
          <Text className="size-4" />
        </div>
        <input
          className={inputClassName}
          placeholder={m.doc_link_text_placeholder()}
          data-plate-focus
          {...textInputProps}
        />
      </div>
    </div>
  );
}

function DocLinkTargetPicker() {
  const editor = useEditorRef();
  const activeDocument = useEntrySelectionStore((s) => s.activeDocument);
  const activeDocumentSpaceId = useEntrySelectionStore((s) => s.activeDocumentSpaceId);
  const activeRootPath = useSpaceStore((s) => s.activeRootPath);
  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const rootSpaces = useSpaceStore((s) => s.rootSpaces);
  const spaces = useSpaceStore((s) => s.spaces);
  const fileTrees = useSpaceStore((s) => s.fileTrees);
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<SearchItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const sourceSpaceId =
    activeDocumentSpaceId === activeRootId ? null : activeDocumentSpaceId;
  const sourceSpace =
    sourceSpaceId === null ? null : findSpaceById(rootSpaces, spaces, sourceSpaceId);
  const localCurrentSpace = React.useMemo(
    () =>
      sourceSpaceId !== null && sourceSpace
        ? {
            spaceId: sourceSpaceId,
            spacePath: sourceSpace.path,
            spaceName: sourceSpace.name,
            tree: fileTrees[sourceSpaceId] ?? [],
          }
        : null,
    [fileTrees, sourceSpace, sourceSpaceId],
  );

  React.useEffect(() => {
    if (!activeRootPath) {
      setItems([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchDocLinkTargets(activeRootPath, sourceSpaceId, query, localCurrentSpace)
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        .catch((err) => {
          console.error("doc link search failed:", err);
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeRootPath, sourceSpaceId, query, localCurrentSpace]);

  const currentSpace = findSpaceById(rootSpaces, spaces, activeDocumentSpaceId);
  const currentSpacePath = currentSpace?.path ?? activeRootPath ?? "";
  const sourceAbs =
    activeDocument && currentSpacePath
      ? absoluteDocumentPath(activeDocument, currentSpacePath)
      : null;

  async function selectItem(item: SearchItem) {
    if (!sourceAbs) return;
    const targetAbs = joinAbs(item.spacePath, item.path);
    const url = await makeRelativeDocUrl(sourceAbs, targetAbs);
    applyLinkUrl(editor, url, item.title);
  }

  return (
    <Command shouldFilter={false} className="h-[260px] rounded-md border">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={m.editor_doc_link_search()}
      />
      <CommandList>
        <CommandEmpty>
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {m.common_loading()}
            </span>
          ) : (
            m.editor_doc_link_no_results()
          )}
        </CommandEmpty>
        <CommandGroup>
          {items.map((item) => (
            <CommandItem
              key={`${item.spaceId ?? "root"}:${item.path}`}
              value={`${item.title} ${item.path} ${item.spaceName}`}
              onSelect={() => selectItem(item)}
              className="items-center gap-2 py-1.5"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col justify-center leading-none">
                <span className="truncate text-sm font-medium leading-4">
                  {item.title}
                </span>
                <span className="truncate text-[11px] leading-3 text-muted-foreground">
                  {item.spaceId === sourceSpaceId ||
                  (item.spaceId === null && sourceSpaceId === null)
                    ? item.path
                    : `${item.spaceName} · ${item.path}`}
                </span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function DocLinkEditContent({
  editButtonProps,
  unlinkButtonProps,
}: {
  editButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  unlinkButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const editor = useEditorRef();
  const selection = useEditorSelection();
  const activeDocument = useEntrySelectionStore((s) => s.activeDocument);
  const activeDocumentSpaceId = useEntrySelectionStore((s) => s.activeDocumentSpaceId);
  const activeRootPath = useSpaceStore((s) => s.activeRootPath);
  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const rootSpaces = useSpaceStore((s) => s.rootSpaces);
  const spaces = useSpaceStore((s) => s.spaces);
  const brokenLinks = useEditorStore((s) => s.brokenLinks);

  const entry = React.useMemo(
    () =>
      editor.api.node<TLinkElement>({
        match: { type: editor.getType(KEYS.link) },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, selection],
  );
  const link = entry?.[0];
  const url = typeof link?.url === "string" ? link.url : "";
  const currentSpace = findSpaceById(rootSpaces, spaces, activeDocumentSpaceId);
  const currentSpacePath = currentSpace?.path ?? activeRootPath ?? "";
  const sourceSpaceId =
    activeDocumentSpaceId === activeRootId ? null : activeDocumentSpaceId;
  const activeRel =
    activeDocument && currentSpacePath
      ? relativeDocumentPath(activeDocument, currentSpacePath)
      : activeDocument;
  const resolvedPath =
    activeRel && url ? resolveRelativeDocPath(activeRel, url) : url;
  const isBroken =
    isDocLink(url) &&
    (brokenLinks.has(url) ||
      (resolvedPath ? brokenLinks.has(resolvedPath) : false));

  if (isBroken && activeRootPath && activeRel) {
    return (
      <BrokenLinkRepair
        editButtonProps={editButtonProps}
        unlinkButtonProps={unlinkButtonProps}
        projectPath={activeRootPath}
        sourceSpaceId={sourceSpaceId}
        sourceSpacePath={currentSpacePath}
        sourcePath={activeRel}
        url={url}
      />
    );
  }

  return (
    <div className="box-content flex items-center">
      <button
        className={buttonVariants({ size: "sm", variant: "ghost" })}
        type="button"
        {...editButtonProps}
      >
        {m.doc_link_edit_link()}
      </button>
      <Separator orientation="vertical" />
      <LinkOpenButton />
      <Separator orientation="vertical" />
      <button
        className={buttonVariants({ size: "sm", variant: "ghost" })}
        type="button"
        {...unlinkButtonProps}
      >
        <Unlink width={18} />
      </button>
    </div>
  );
}

function BrokenLinkRepair({
  editButtonProps,
  unlinkButtonProps,
  projectPath,
  sourceSpaceId,
  sourceSpacePath,
  sourcePath,
  url,
}: {
  editButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  unlinkButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  projectPath: string;
  sourceSpaceId: string | null;
  sourceSpacePath: string;
  sourcePath: string;
  url: string;
}) {
  const editor = useEditorRef();
  const [resolved, setResolved] = React.useState<LinkResolveResult | null>(
    null,
  );
  const [suggestions, setSuggestions] = React.useState<LinkFixSuggestion[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    invoke<LinkResolveResult>("resolve_doc_link", {
      projectPath,
      sourceSpaceId,
      sourcePath,
      url,
    })
      .then((next) => {
        if (cancelled) return;
        setResolved(next);
        if (!next.targetPath) return [];
        return invoke<LinkFixSuggestion[]>("suggest_link_fix", {
          projectPath,
          targetSpaceId: next.targetSpaceId,
          brokenPath: next.targetPath,
        });
      })
      .then((next) => {
        if (!cancelled && next) setSuggestions(next.slice(0, 3));
      })
      .catch((err) => {
        console.error("suggest_link_fix failed:", err);
        if (!cancelled) setSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, sourceSpaceId, sourcePath, url]);

  async function applySuggestion(path: string) {
    if (!resolved?.targetSpacePath) return;
    const sourceAbs = joinAbs(sourceSpacePath || projectPath, sourcePath);
    const targetAbs = joinAbs(resolved.targetSpacePath, path);
    applyLinkUrl(editor, await makeRelativeDocUrl(sourceAbs, targetAbs));
  }

  return (
    <div className="flex w-[300px] flex-col gap-1 p-1">
      <div className="px-2 py-1 text-sm font-medium">
        {m.doc_link_file_missing()}
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.path}
              type="button"
              className={cn(
                "flex flex-col rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              onClick={() => applySuggestion(suggestion.path)}
            >
              <span className="truncate font-medium">{suggestion.label}</span>
              <span className="truncate text-xs text-muted-foreground">
                {suggestion.reason}
              </span>
            </button>
          ))}
          <Separator className="my-1" />
        </div>
      )}
      <div className="flex items-center">
        <button
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          type="button"
          {...editButtonProps}
        >
          {m.doc_link_edit_link()}
        </button>
        <Separator orientation="vertical" />
        <button
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          type="button"
          {...unlinkButtonProps}
        >
          <Unlink width={18} />
        </button>
      </div>
    </div>
  );
}

function LinkOpenButton() {
  const editor = useEditorRef();
  const selection = useEditorSelection();

  const attributes = React.useMemo(
    () => {
      const entry = editor.api.node<TLinkElement>({
        match: { type: editor.getType(KEYS.link) },
      });
      if (!entry) {
        return {};
      }
      const [element] = entry;
      return {
        href: element.url,
        onMouseOver: (e: React.MouseEvent) => {
          e.stopPropagation();
        },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, selection],
  );

  return (
    <a
      {...attributes}
      className={buttonVariants({ size: "sm", variant: "ghost" })}
      aria-label={m.doc_link_open_link()}
      target="_blank"
    >
      <ExternalLink width={18} />
    </a>
  );
}

function applyLinkUrl(
  editor: ReturnType<typeof useEditorRef>,
  url: string,
  title?: string,
) {
  const entry = editor.api.node<TLinkElement>({
    match: { type: editor.getType(KEYS.link) },
  });
  if (entry) {
    const [, path] = entry;
    editor.tf.setNodes({ url }, { at: path });
  } else {
    upsertLink(editor, {
      url,
      text: title,
      skipValidation: true,
    });
  }
  editor.getApi(LinkPlugin).floatingLink.hide();
  editor.tf.focus();
}
