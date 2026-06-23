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
import { isDocLink } from "../lib/doc-link-utils";
import { useDocLinkNavigation } from "../hooks/use-doc-link-navigation";

export function DocLinkElement(props: PlateElementProps<TLinkElement>) {
  const { element, editor, children } = props;
  const url = element.url as string | undefined;
  const isDoc = isDocLink(url);
  const docLink = useDocLinkNavigation(url);

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
    await docLink.openDocLink();
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
        docLink.isBroken && "opacity-50 line-through",
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
  if (docLink.resolvedPath) {
    return (
      <>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{pill}</TooltipTrigger>
            <TooltipContent side="bottom">{docLink.tooltipPath}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <GhostCloneDialog
          open={docLink.cloneTarget !== null}
          spaceName={docLink.cloneTarget?.spaceName ?? ""}
          cloning={docLink.isCloning}
          onOpenChange={docLink.onCloneDialogOpenChange}
          onConfirm={docLink.handleCloneMissing}
        />
      </>
    );
  }

  return pill;
}
