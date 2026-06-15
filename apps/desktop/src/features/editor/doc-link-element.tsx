import type { TLinkElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import * as React from "react";
import { getLinkAttributes } from "@platejs/link";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { PlateElement } from "platejs/react";
import { FileText } from "lucide-react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { toast } from "sonner";
import { cn } from "@/shared/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useEditorStore } from "@/stores/editor";
import { useSpaceStore } from "@/stores/space";
import { GhostCloneDialog } from "@/features/space/ghost-clone-dialog";
import * as m from "@/paraglide/messages.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  absoluteDocumentPath,
  findSpaceById,
  isDocLink,
  relativeDocumentPath,
  resolveRelativeDocPath,
} from "./doc-link-utils";

interface LinkResolveResult {
  targetSpaceId: string | null;
  targetSpacePath: string | null;
  targetPath: string | null;
  status: "ready" | "missing" | "broken" | "external";
  exists: boolean;
  spaceName: string;
}

export function DocLinkElement(props: PlateElementProps<TLinkElement>) {
  const { element, editor, children } = props;
  const { openDocument } = useLayoutStore();
  const activeDocument = useLayoutStore((s) => s.activeDocument);
  const activeDocumentSpaceId = useLayoutStore((s) => s.activeDocumentSpaceId);
  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const activeRootPath = useSpaceStore((s) => s.activeRootPath);
  const rootSpaces = useSpaceStore((s) => s.rootSpaces);
  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId);
  const openSpace = useSpaceStore((s) => s.openSpace);
  const clearActiveSpace = useSpaceStore((s) => s.clearActiveSpace);
  const loadSpaces = useSpaceStore((s) => s.loadSpaces);
  const brokenLinks = useEditorStore((s) => s.brokenLinks);
  const [cloneTarget, setCloneTarget] =
    React.useState<LinkResolveResult | null>(null);
  const [isCloning, setIsCloning] = React.useState(false);
  const url = element.url as string | undefined;
  const isDoc = isDocLink(url);

  const suggestionData = editor
    .getApi(SuggestionPlugin)
    ?.suggestion?.suggestionData?.(element) as { type?: string } | undefined;

  // External link — standard rendering
  if (!isDoc) {
    return (
      <PlateElement
        {...props}
        as="a"
        className={cn(
          "font-medium text-primary underline decoration-primary underline-offset-4",
          suggestionData?.type === "remove" && "bg-red-100 text-red-700",
          suggestionData?.type === "insert" &&
            "bg-emerald-100 text-emerald-700",
        )}
        attributes={{
          ...props.attributes,
          ...getLinkAttributes(editor, element),
          onMouseOver: (e: React.MouseEvent) => {
            e.stopPropagation();
          },
        }}
      >
        {children}
      </PlateElement>
    );
  }

  // Doc link — pill rendering
  const currentSpace = findSpaceById(rootSpaces, spaces, activeDocumentSpaceId);
  const currentSpacePath = currentSpace?.path ?? activeRootPath ?? "";
  const activeRel =
    activeDocument && currentSpacePath
      ? relativeDocumentPath(activeDocument, currentSpacePath)
      : activeDocument;
  const activeAbs =
    activeDocument && currentSpacePath
      ? absoluteDocumentPath(activeDocument, currentSpacePath)
      : activeDocument;
  const resolvedPath =
    activeRel && url ? resolveRelativeDocPath(activeRel, url) : url;
  const sourceSpaceId =
    activeDocumentSpaceId === activeRootId ? null : activeDocumentSpaceId;
  const isBroken =
    !!url &&
    (brokenLinks.has(url) ||
      (resolvedPath ? brokenLinks.has(resolvedPath) : false));

  async function openResolvedLink(resolved: LinkResolveResult) {
    if (!resolved.targetPath) return;
    if (resolved.targetSpaceId === null) {
      clearActiveSpace();
      openDocument(resolved.targetPath, activeRootId ?? undefined);
      return;
    }
    if (resolved.targetSpaceId !== activeSpaceId) {
      await openSpace(resolved.targetSpaceId);
    }
    openDocument(resolved.targetPath, resolved.targetSpaceId);
  }

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!url || !activeRel || !activeRootPath) {
      if (resolvedPath && !isBroken) openDocument(resolvedPath);
      return;
    }

    try {
      const resolved = await invoke<LinkResolveResult>("resolve_doc_link", {
        projectPath: activeRootPath,
        sourceSpaceId,
        sourcePath: activeRel,
        url,
      });
      if (resolved.status === "ready" && resolved.exists) {
        await openResolvedLink(resolved);
      } else if (resolved.status === "missing") {
        setCloneTarget(resolved);
      } else if (resolved.status === "broken") {
        toast.error(m.doc_link_space_unavailable({ name: resolved.spaceName }));
      }
    } catch (err) {
      console.error("resolve_doc_link failed:", err);
      if (resolvedPath && !isBroken) {
        openDocument(resolvedPath);
      }
    }
  };

  async function handleCloneMissing() {
    if (!cloneTarget || !activeRootPath) return;
    setIsCloning(true);
    try {
      await invoke("clone_missing_space", {
        projectPath: activeRootPath,
        spaceId: cloneTarget.targetSpaceId,
      });
      await loadSpaces(activeRootPath);
      await openResolvedLink({ ...cloneTarget, status: "ready", exists: true });
      setCloneTarget(null);
    } catch (err) {
      console.error("clone_missing_space failed:", err);
      toast.error(m.doc_link_clone_missing_failed());
    } finally {
      setIsCloning(false);
    }
  }

  const pill = (
    <PlateElement
      {...props}
      as="span"
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5",
        "text-accent-foreground text-sm font-medium",
        "cursor-pointer hover:bg-accent/80 transition-colors",
        "no-underline",
        isBroken && "opacity-50 line-through",
        suggestionData?.type === "remove" && "bg-red-100 text-red-700",
        suggestionData?.type === "insert" && "bg-emerald-100 text-emerald-700",
      )}
      attributes={{
        ...props.attributes,
        onClick: handleClick,
      }}
    >
      <span contentEditable={false} className="inline-flex items-center">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </span>
      {children}
    </PlateElement>
  );

  // Wrap in tooltip showing the resolved path
  if (resolvedPath) {
    return (
      <>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{pill}</TooltipTrigger>
            <TooltipContent side="bottom">
              {activeAbs && url
                ? resolveRelativeDocPath(activeAbs, url)
                : resolvedPath}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <GhostCloneDialog
          open={cloneTarget !== null}
          spaceName={cloneTarget?.spaceName ?? ""}
          cloning={isCloning}
          onOpenChange={(open) => {
            if (!open && !isCloning) setCloneTarget(null);
          }}
          onConfirm={handleCloneMissing}
        />
      </>
    );
  }

  return pill;
}
