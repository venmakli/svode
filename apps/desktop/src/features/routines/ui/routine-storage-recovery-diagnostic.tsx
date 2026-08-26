import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

export function RoutineStorageRecoveryDiagnostic({
  error,
  pending,
  onAcknowledge,
}: {
  error: string | null;
  pending: boolean;
  onAcknowledge(): void;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <span className="flex flex-col gap-1">
        <strong>{m.routines_storage_recovery_title()}</strong>
        <span>{m.routines_storage_recovery_description()}</span>
        {error ? <span className="text-destructive">{error}</span> : null}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onAcknowledge}
      >
        {pending
          ? m.routines_storage_recovery_acknowledging()
          : m.routines_storage_recovery_acknowledge()}
      </Button>
    </div>
  );
}
