import {
  CloudDownload,
  CloudOff,
  CloudUpload,
  TriangleAlert,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SidebarMenuItem, SidebarMenuSub } from "@/components/ui/sidebar";
import * as m from "@/paraglide/messages.js";
import {
  GitTransferIcon,
  lfsUnsentHint,
  useGitTransfer,
} from "@/features/git/sidebar";
import { cn } from "@/shared/lib/utils";
import type { LfsMissing, LfsState, LfsUnsent } from "../model";
import { lfsMissingDescription } from "./lfs-missing-copy";

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

/**
 * The LFS place of a Space row: one icon, a running transfer before no
 * access before files not sent before files left without content.
 */
export function LfsIndicatorIcon({
  lfsState,
  lfsMissing,
  lfsUnsent,
  spacePath,
}: {
  lfsState: LfsState;
  lfsMissing: LfsMissing | null;
  lfsUnsent: LfsUnsent | null;
  spacePath: string;
}) {
  const transfer = useGitTransfer(spacePath);
  if (transfer) return <GitTransferIcon transfer={transfer} />;
  if (lfsState === "missing-creds") {
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
  // Colleagues wait for the files not sent; not those not downloaded.
  if (lfsUnsent) {
    return <LfsUnsentIcon unsent={lfsUnsent} />;
  }
  if (lfsState === "ready" && lfsMissing) {
    return <LfsMissingIcon missing={lfsMissing} />;
  }
  return null;
}

/** A calm static cloud with an arrow up: files whose content is still to send. */
function LfsUnsentIcon({ unsent }: { unsent: LfsUnsent }) {
  const label = lfsUnsentHint(unsent);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          role="img"
          aria-label={label}
          data-lfs-unsent=""
        >
          <CloudUpload className="size-3! text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="[overflow-wrap:anywhere]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A calm static cloud: not every LFS file is on this device, and why. */
function LfsMissingIcon({ missing }: { missing: LfsMissing }) {
  const label = lfsMissingDescription(missing);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          role="img"
          aria-label={label}
          data-lfs-missing=""
        >
          <CloudDownload className="size-3! text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="[overflow-wrap:anywhere]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A space whose config cannot be read; its home and Settings tell why. */
export function SpaceConfigWarningIcon() {
  const label = m.space_config_unreadable_space_title();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" role="img" aria-label={label}>
          <TriangleAlert className="text-warning" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
