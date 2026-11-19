import { ArrowDown, ArrowUp } from "lucide-react";
import { useId } from "react";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGitTransfer } from "../hooks/use-git-transfer";
import type { GitTransfer } from "../model";
import { gitTransferLabel, gitTransferPercent } from "./git-transfer-copy";

/** A static arrow of the transfer direction; its tooltip names the file. */
export function GitTransferIcon({ transfer }: { transfer: GitTransfer }) {
  const label = gitTransferLabel(transfer);
  const Icon = transfer.direction === "upload" ? ArrowUp : ArrowDown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          role="img"
          aria-label={label}
          data-git-transfer={transfer.direction}
        >
          <Icon className="size-3! text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="[overflow-wrap:anywhere]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** The transfer of the repository with the progress of its current file. */
export function GitTransferProgress({ spacePath }: { spacePath: string }) {
  const transfer = useGitTransfer(spacePath);
  const labelId = useId();
  if (!transfer) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-git-transfer-progress={transfer.direction}
    >
      <p
        id={labelId}
        className="text-sm tabular-nums text-muted-foreground [overflow-wrap:anywhere]"
      >
        {gitTransferLabel(transfer)}
      </p>
      <Progress
        value={gitTransferPercent(transfer)}
        aria-labelledby={labelId}
      />
    </div>
  );
}
