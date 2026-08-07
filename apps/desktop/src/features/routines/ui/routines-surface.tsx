import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { SystemCollectionPresentationCore } from "@/features/collection/system";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useRoutinesController } from "../hooks/use-routines-controller";

export function RoutinesSurface({ owner }: ScopeSurfaceRenderContext) {
  const controller = useRoutinesController(owner);
  const body =
    controller.collectionState.phase === "ready" ? (
      <SystemCollectionPresentationCore
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
