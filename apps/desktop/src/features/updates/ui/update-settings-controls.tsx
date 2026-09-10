import { RefreshCw } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/shared/lib/utils";
import { useDogfoodUpdates } from "../hooks/use-dogfood-updates";

type DogfoodUpdateStatus = ReturnType<typeof useDogfoodUpdates>["status"];
type DogfoodUpdateKind = NonNullable<
  ReturnType<typeof useDogfoodUpdates>["update"]
>["item"]["kind"];

export function DogfoodUpdateSettingsControls() {
  const updates = useDogfoodUpdates();
  const availableUpdate = updates.update;

  return (
    <>
      <div className="flex flex-col gap-1">
        <Label>{m.updates_status_label()}</Label>
        <p className="text-sm text-muted-foreground">
          {availableUpdate
            ? updateStatusText(availableUpdate.item.kind)
            : updateFallbackText(updates.status)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void updates.check()}
          disabled={updates.checking || !updates.canCheck}
        >
          <RefreshCw
            data-icon="inline-start"
            className={cn(updates.checking && "animate-spin")}
          />
          {updates.checking
            ? m.updates_status_checking()
            : m.updates_status_check()}
        </Button>
        {availableUpdate && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void updates.openUpdate()}
          >
            {m.updates_download()}
          </Button>
        )}
      </div>
    </>
  );
}

function updateFallbackText(status: DogfoodUpdateStatus): string {
  if (status === "current") return m.updates_status_current();
  if (status === "error") return m.updates_status_failed();
  return m.updates_status_manual();
}

function updateStatusText(kind: DogfoodUpdateKind): string {
  if (kind === "ci-build") return m.updates_status_ci_available();
  return m.updates_status_release_available();
}
