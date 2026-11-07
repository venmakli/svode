import type { TLinkElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import * as React from "react";
import { getLinkAttributes } from "@platejs/link";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { PlateElement } from "platejs/react";
import { FileText } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { GhostCloneDialog } from "./ghost-clone-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacKeyboardPlatform } from "@/shared/lib/keyboard-shortcuts";
import { isPageLink, isProjectFileLink } from "../lib/page-link-utils";
import { usePageLinkNavigation } from "../hooks/use-page-link-navigation";

/** ⌘-click on macOS, Ctrl-click elsewhere: the gesture that opens a link. */
function isLinkOpenClick(event: React.MouseEvent): boolean {
  return isMacKeyboardPlatform() ? event.metaKey : event.ctrlKey;
}

/**
 * A click the browser would turn into a new window or a download: it never
 * gets the path of a project file (DF-317 R2).
 */
function isBrowserLinkClick(event: React.MouseEvent): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export function PageLinkElement(props: PlateElementProps<TLinkElement>) {
  const { element, editor, children } = props;
  const url = element.url as string | undefined;
  const isDoc = isPageLink(url);
  const pageLink = usePageLinkNavigation(url);

  const suggestionData = editor
    .getApi(SuggestionPlugin)
    ?.suggestion?.suggestionData?.(element) as { type?: string } | undefined;

  // External link or link to a project file — standard rendering. A project
  // file opens with the neutral opening of an artifact, never in the browser.
  if (!isDoc) {
    const isFile = isProjectFileLink(url);
    const handleFileClick = (e: React.MouseEvent) => {
      if (!isBrowserLinkClick(e)) return;
      e.preventDefault();
      if (e.button === 0 && isLinkOpenClick(e)) {
        e.stopPropagation();
        void pageLink.openLink();
      }
    };
    const link = (
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
          ...(isFile
            ? { onClick: handleFileClick, onAuxClick: handleFileClick }
            : {}),
        }}
      >
        {children}
      </PlateElement>
    );
    if (!isFile) return link;
    return (
      <>
        {link}
        <GhostCloneDialog
          open={pageLink.cloneTarget !== null}
          spaceName={pageLink.cloneTarget?.spaceName ?? ""}
          cloning={pageLink.isCloning}
          onOpenChange={pageLink.onCloneDialogOpenChange}
          onConfirm={pageLink.handleCloneMissing}
        />
      </>
    );
  }

  // Doc link — pill rendering
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await pageLink.openLink();
  };

  const content = (
    <>
      <span contentEditable={false} className="inline-flex items-center">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </span>
      {children}
    </>
  );

  // The hint trigger is a span inside the element: PlateElement renders only
  // its attributes, so a trigger slotted onto it loses the pointer handlers.
  const pill = (
    <PlateElement
      {...props}
      as="span"
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5",
        "text-accent-foreground text-sm font-medium",
        "cursor-pointer hover:bg-accent/80 transition-colors",
        "no-underline",
        pageLink.isBroken && "opacity-50 line-through",
        suggestionData?.type === "remove" && "bg-red-100 text-red-700",
        suggestionData?.type === "insert" && "bg-emerald-100 text-emerald-700",
      )}
      attributes={{
        ...props.attributes,
        onClick: handleClick,
      }}
    >
      {pageLink.resolvedPath ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1">{content}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{pageLink.tooltipPath}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        content
      )}
    </PlateElement>
  );

  if (pageLink.resolvedPath) {
    return (
      <>
        {pill}
        <GhostCloneDialog
          open={pageLink.cloneTarget !== null}
          spaceName={pageLink.cloneTarget?.spaceName ?? ""}
          cloning={pageLink.isCloning}
          onOpenChange={pageLink.onCloneDialogOpenChange}
          onConfirm={pageLink.handleCloneMissing}
        />
      </>
    );
  }

  return pill;
}
