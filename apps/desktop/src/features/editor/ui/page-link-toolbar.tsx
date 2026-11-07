"use client";

import * as React from "react";

import type { TLinkElement } from "platejs";

import {
  type LinkFloatingToolbarState,
  FloatingLinkUrlInput,
  useFloatingLinkEdit,
  useFloatingLinkEditState,
  useFloatingLinkInsert,
  useFloatingLinkInsertState,
} from "@platejs/link/react";
import {
  type UseVirtualFloatingOptions,
  flip,
  offset,
} from "@platejs/floating";
import { ExternalLink, Link, Text, Unlink } from "lucide-react";
import { KEYS } from "platejs";
import {
  useEditorRef,
  useEditorSelection,
  useFormInputProps,
  usePluginOption,
} from "platejs/react";

import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as m from "@/paraglide/messages.js";
import {
  isBrokenPageLink,
  isProjectFileLink,
  relativeDocumentPath,
} from "../lib/page-link-utils";
import { usePageLinkOpener } from "../hooks/use-page-link-navigation";
import { useEditorDocumentContext } from "../hooks/use-resolved-asset-url";
import { BrokenLinksPlugin } from "../plate/broken-links-plugin";
import { BrokenLinkRepair } from "./broken-link-repair";
import { GhostCloneDialog } from "./ghost-clone-dialog";
import { PageLinkTargetPicker } from "./page-link-target-picker";

type LinkMode = "page" | "url";

const popoverClassName =
  "z-50 w-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-hidden";

const inputClassName =
  "flex h-[28px] w-full rounded-md border-none bg-transparent px-1.5 py-1 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-transparent md:text-sm";

export function PageLinkFloatingToolbar({
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
  const [mode, setMode] = React.useState<LinkMode>("page");
  // Owned by the toolbar root, which stays mounted while the popover hides,
  // so the clone dialog of a missing Space outlives the popover.
  const linkOpener = usePageLinkOpener();
  const cloneDialog = (
    <GhostCloneDialog
      open={linkOpener.cloneTarget !== null}
      spaceName={linkOpener.cloneTarget?.spaceName ?? ""}
      cloning={linkOpener.isCloning}
      onOpenChange={linkOpener.onCloneDialogOpenChange}
      onConfirm={linkOpener.handleCloneMissing}
    />
  );

  const input = (
    <div className="flex w-[360px] flex-col gap-1" {...inputProps}>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(value) => {
          if (value === "page" || value === "url") setMode(value);
        }}
        variant="outline"
        size="sm"
        className="w-full"
      >
        <ToggleGroupItem value="page" className="flex-1">
          {m.page_link_mode_page()}
        </ToggleGroupItem>
        <ToggleGroupItem value="url" className="flex-1">
          {m.page_link_mode_url()}
        </ToggleGroupItem>
      </ToggleGroup>

      {mode === "page" ? (
        <PageLinkTargetPicker />
      ) : (
        <LegacyUrlInput textInputProps={textInputProps} />
      )}
    </div>
  );

  const editContent = editState.isEditing ? (
    input
  ) : (
    <PageLinkEditContent
      editButtonProps={editButtonProps}
      unlinkButtonProps={unlinkButtonProps}
      onOpenFileLink={linkOpener.openLink}
    />
  );

  return (
    <>
      {hidden ? null : (
        <>
          <div ref={insertRef} className={popoverClassName} {...insertProps}>
            {input}
          </div>

          <div ref={editRef} className={popoverClassName} {...editProps}>
            {editContent}
          </div>
        </>
      )}
      {cloneDialog}
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
          placeholder={m.page_link_url_placeholder()}
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
          placeholder={m.page_link_text_placeholder()}
          data-plate-focus
          {...textInputProps}
        />
      </div>
    </div>
  );
}

function PageLinkEditContent({
  editButtonProps,
  unlinkButtonProps,
  onOpenFileLink,
}: {
  editButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  unlinkButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  onOpenFileLink: (url: string) => Promise<void>;
}) {
  const editor = useEditorRef();
  const selection = useEditorSelection();
  const editorDocument = useEditorDocumentContext();
  const brokenLinks = usePluginOption(BrokenLinksPlugin, "brokenLinks");
  const projectPath = editorDocument?.projectPath ?? null;
  const activeDocument = editorDocument?.documentPath ?? null;
  const currentSpacePath = editorDocument?.spacePath ?? "";
  const sourceSpaceId = editorDocument?.sourceSpaceId ?? null;

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
  const activeRel =
    activeDocument && currentSpacePath
      ? relativeDocumentPath(activeDocument, currentSpacePath)
      : activeDocument;
  const isBroken = isBrokenPageLink(brokenLinks, url, activeRel);

  if (isBroken && projectPath && activeRel) {
    return (
      <BrokenLinkRepair
        editButtonProps={editButtonProps}
        unlinkButtonProps={unlinkButtonProps}
        projectPath={projectPath}
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
        {m.page_link_edit_link()}
      </button>
      <Separator orientation="vertical" />
      {isProjectFileLink(url) ? (
        <button
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          type="button"
          aria-label={m.page_link_open_link()}
          onClick={() => void onOpenFileLink(url)}
        >
          <ExternalLink width={18} />
        </button>
      ) : (
        <LinkOpenButton />
      )}
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
      aria-label={m.page_link_open_link()}
      target="_blank"
    >
      <ExternalLink width={18} />
    </a>
  );
}
