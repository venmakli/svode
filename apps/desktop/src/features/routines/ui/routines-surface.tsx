import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { CollectionHost } from "@/features/collection";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useRoutinesController } from "../hooks/use-routines-controller";
import type {
  RoutineAgentActorTarget,
  RoutineSessionTarget,
} from "../model/types";
import { RoutineAutomaticConsent } from "./routine-automatic-consent";
import { RoutineAutomaticConsentNotice } from "./routine-automatic-consent-notice";

export function RoutinesSurface({
  owner,
  openItem,
  mainItem,
  onExpandItem,
  ownerName,
  readOnly,
  onOpenAgentActor,
  onOpenAgentSettings,
  onOpenSession,
}: ScopeSurfaceRenderContext & {
  /** The name of the owner, as its header says it. */
  ownerName?: string;
  readOnly: boolean;
  /** Opens an Agent Actor in its editor, where a refused launch is fixed. */
  onOpenAgentActor?(target: RoutineAgentActorTarget): void;
  onOpenAgentSettings?(): void;
  onOpenSession(target: RoutineSessionTarget): void;
}) {
  const controller = useRoutinesController(
    owner,
    onOpenSession,
    readOnly,
    openItem,
    {
      mainItem,
      onExpandItem,
      onOpenAgentActor,
      onOpenAgentSettings,
      ownerName,
    },
  );
  const unavailable = (
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
  if (controller.main) {
    return (
      <div className="flex min-h-full flex-col" data-routines-surface>
        {controller.collectionState.phase === "blocking_error"
          ? unavailable
          : controller.main}
        {controller.overlays}
      </div>
    );
  }
  const body =
    controller.collectionState.phase === "ready" ? (
      <CollectionHost
        contextualActions={
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
        instance={controller.instance}
        state={controller.collectionState}
      />
    ) : (
      unavailable
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-routines-surface>
      {body}
      {controller.overlays}
    </div>
  );
}
