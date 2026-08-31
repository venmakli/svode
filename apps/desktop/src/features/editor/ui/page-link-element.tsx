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
import { isPageLink } from "../lib/page-link-utils";
import { usePageLinkNavigation } from "../hooks/use-page-link-navigation";

export function PageLinkElement(props: PlateElementProps<TLinkElement>) {
  const { element, editor, children } = props;
  const url = element.url as string | undefined;
  const isDoc = isPageLink(url);
  const pageLink = usePageLinkNavigation(url);

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
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await pageLink.openPageLink();
  };

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
      <span contentEditable={false} className="inline-flex items-center">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </span>
      {children}
    </PlateElement>
  );

  // Wrap in tooltip showing the resolved path
  if (pageLink.resolvedPath) {
    return (
      <>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{pill}</TooltipTrigger>
            <TooltipContent side="bottom">{pageLink.tooltipPath}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
