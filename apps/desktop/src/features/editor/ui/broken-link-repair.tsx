import type * as React from "react";

import { Unlink } from "lucide-react";
import { useEditorRef } from "platejs/react";

import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import { useBrokenDocLinkRepair } from "../hooks/use-broken-doc-link-repair";
import { applyLinkUrl } from "../lib/doc-link-editor-actions";

interface BrokenLinkRepairProps {
  editButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  unlinkButtonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  projectPath: string;
  sourceSpaceId: string | null;
  sourceSpacePath: string;
  sourcePath: string;
  url: string;
}

export function BrokenLinkRepair({
  editButtonProps,
  unlinkButtonProps,
  projectPath,
  sourceSpaceId,
  sourceSpacePath,
  sourcePath,
  url,
}: BrokenLinkRepairProps) {
  const editor = useEditorRef();
  const { makeSuggestionUrl, suggestions } = useBrokenDocLinkRepair({
    projectPath,
    sourcePath,
    sourceSpaceId,
    url,
  });

  async function applySuggestion(path: string) {
    const nextUrl = await makeSuggestionUrl(path, sourceSpacePath);
    if (!nextUrl) return;
    applyLinkUrl(editor, nextUrl);
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
