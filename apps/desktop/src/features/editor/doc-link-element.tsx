import type { TLinkElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import { getLinkAttributes } from "@platejs/link";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { PlateElement } from "platejs/react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useEditorStore } from "@/stores/editor";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Check if a URL is an internal document link (relative .md path). */
function isDocLink(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
    return false;
  }
  // Strip anchor fragment before checking extension
  const pathPart = url.split("#")[0];
  return pathPart.endsWith(".md");
}

/**
 * Resolve a relative link URL to an absolute workspace path,
 * given the current document's path.
 */
function resolveDocPath(currentDoc: string, relativeUrl: string): string {
  const url = relativeUrl.split("#")[0]; // strip anchor
  const parts = currentDoc.split("/");
  parts.pop(); // remove filename → directory

  for (const segment of url.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }

  return parts.join("/");
}

export function DocLinkElement(props: PlateElementProps<TLinkElement>) {
  const { element, editor, children } = props;
  const { openDocument } = useLayoutStore();
  const activeDocument = useLayoutStore((s) => s.activeDocument);
  const brokenLinks = useEditorStore((s) => s.brokenLinks);
  const url = element.url as string | undefined;
  const isDoc = isDocLink(url);

  const suggestionData = editor
    .getApi(SuggestionPlugin)
    .suggestion.suggestionData(element) as
    | { type?: string }
    | undefined;

  // External link — standard rendering
  if (!isDoc) {
    return (
      <PlateElement
        {...props}
        as="a"
        className={cn(
          "font-medium text-primary underline decoration-primary underline-offset-4",
          suggestionData?.type === "remove" && "bg-red-100 text-red-700",
          suggestionData?.type === "insert" && "bg-emerald-100 text-emerald-700",
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
  const resolvedPath = activeDocument && url ? resolveDocPath(activeDocument, url) : url;
  const isBroken = resolvedPath ? brokenLinks.has(resolvedPath) : false;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (resolvedPath && !isBroken) {
      openDocument(resolvedPath);
    }
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
        isBroken && "opacity-50 line-through cursor-not-allowed",
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
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{pill}</TooltipTrigger>
          <TooltipContent side="bottom">{resolvedPath}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return pill;
}
