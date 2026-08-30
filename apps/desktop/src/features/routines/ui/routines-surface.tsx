import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { SystemCollectionPresentationCore } from "@/features/collection/system";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useRoutinesController } from "../hooks/use-routines-controller";
import type { RoutineSessionTarget } from "../model/types";
import { RoutineAutomaticConsent } from "./routine-automatic-consent";
import { RoutineAutomaticConsentNotice } from "./routine-automatic-consent-notice";

export function RoutinesSurface({
  owner,
  readOnly,
  onOpenSession,
}: ScopeSurfaceRenderContext & {
  readOnly: boolean;
  onOpenSession(target: RoutineSessionTarget): void;
}) {
  const controller = useRoutinesController(owner, onOpenSession, readOnly);
  const body =
    controller.collectionState.phase === "ready" ? (
      <SystemCollectionPresentationCore
        trailingActions={
          <>
            <RoutineAutomaticConsentNotice
              automaticError={controller.automaticConsent.error}
              loading={controller.automaticConsent.loading}
              recoveryError={controller.storageRecovery.error}
              recoveryPending={controller.storageRecovery.pending}
              readOnly={readOnly}
              storageResetPending={
                controller.automaticConsent.storageResetPending
              }
              onDismissReset={() => void controller.storageRecovery.dismiss()}
              onRetry={controller.automaticConsent.retry}
            />
            <RoutineAutomaticConsent
              enabled={controller.automaticConsent.enabled}
              error={controller.automaticConsent.error}
              loading={controller.automaticConsent.loading}
              ownerKind={controller.automaticConsent.ownerKind}
              pending={controller.automaticConsent.pending}
              readOnly={readOnly}
              onChange={(enabled) =>
                void controller.automaticConsent.setEnabled(enabled)
              }
            />
          </>
        }
        detailController={controller.detailController ?? undefined}
        instance={controller.instance}
        state={controller.collectionState}
      />
    ) : (
      <div className="px-6 py-3">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            {controller.collectionState.phase === "blocking_error"
              ? controller.collectionState.diagnostics.join(" ")
              : m.routines_catalog_unavailable()}
          </AlertDescription>
        </Alert>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-routines-surface>
      {body}
      {controller.overlays}
    </div>
  );
}
