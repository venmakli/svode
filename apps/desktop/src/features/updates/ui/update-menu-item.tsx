import { Download, RefreshCw } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";
import { useDogfoodUpdates } from "../hooks/use-dogfood-updates";

export function DogfoodUpdateMenuItem() {
  const updates = useDogfoodUpdates();
  const canDownload = Boolean(updates.update) && !updates.checking;

  return (
    <DropdownMenuItem
      disabled={updates.checking || !updates.canCheck}
      onSelect={() => {
        if (canDownload) void updates.openUpdate();
        else void updates.check();
      }}
    >
      {canDownload ? (
        <Download />
      ) : (
        <RefreshCw className={cn(updates.checking && "animate-spin")} />
      )}
      {updates.checking
        ? m.updates_status_checking()
        : canDownload
          ? m.updates_download_update()
          : m.updates_status_check()}
    </DropdownMenuItem>
  );
}
