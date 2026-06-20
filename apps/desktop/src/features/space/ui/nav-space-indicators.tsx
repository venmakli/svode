import { CloudOff } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SidebarMenuItem, SidebarMenuSub } from "@/components/ui/sidebar";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";
import type { LfsState } from "../model";

export function TreeLoadingRows() {
  return (
    <SidebarMenuSub className="ml-4 border-l-0 pl-2">
      {[0, 1, 2].map((index) => (
        <SidebarMenuItem key={index}>
          <div className="flex h-7 items-center gap-2 rounded-md px-2">
            <Skeleton className="size-4" />
            <Skeleton
              className={cn(
                "h-3",
                index === 0 && "w-24",
                index === 1 && "w-32",
                index === 2 && "w-20",
              )}
            />
          </div>
        </SidebarMenuItem>
      ))}
    </SidebarMenuSub>
  );
}

export function LfsIndicatorIcon({ lfsState }: { lfsState: LfsState }) {
  if (lfsState !== "missing-creds") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <CloudOff className="text-destructive" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {m.storage_lfs_banner_missing_remote_title()}
      </TooltipContent>
    </Tooltip>
  );
}
