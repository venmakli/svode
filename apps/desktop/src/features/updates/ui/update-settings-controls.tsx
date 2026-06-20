import { RefreshCw } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/shared/lib/utils";
import { useDogfoodUpdateCheck } from "../hooks/use-dogfood-update-check";

interface DogfoodUpdateSettingsControlsProps {
  version: string;
  buildCommit: string;
}

type DogfoodUpdateStatus = ReturnType<typeof useDogfoodUpdateCheck>["status"];
type DogfoodUpdateKind = NonNullable<
  ReturnType<typeof useDogfoodUpdateCheck>["update"]
>["item"]["kind"];

export function DogfoodUpdateSettingsControls({
  version,
  buildCommit,
}: DogfoodUpdateSettingsControlsProps) {
  const updates = useDogfoodUpdateCheck({
    currentVersion: version,
    currentBuildCommit: buildCommit,
  });
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
          onClick={() => void updates.check({ silent: false, force: true })}
          disabled={updates.checking || !version}
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
            onClick={() => void updates.openUpdate(availableUpdate)}
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
