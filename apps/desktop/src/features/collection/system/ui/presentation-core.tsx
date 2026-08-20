import type { ReactNode } from "react";

import { CollectionPresentationToolbar } from "../../ui/presentation-core";
import type { SystemCollectionStateController } from "../hooks/use-system-collection-state";
import { readSystemCollectionPresentationRuntime } from "../model/runtime";
import type {
  SystemCollectionDetailController,
  SystemCollectionInstance,
  SystemCollectionInteractionError,
} from "../model/types";
import { SystemCollectionCreateActionButton } from "./create-action";
import { SystemCollectionFixedTabs } from "./fixed-presentation-tabs";
import { SystemCollectionPresentationShell } from "./presentation-shell";
import { SystemCollectionQueryEditor } from "./query-editor";

type ReadySystemCollectionState = Extract<
  SystemCollectionStateController,
  { phase: "ready" }
>;

export interface SystemCollectionPresentationCoreProps {
  contextualActions?: ReactNode;
  detailController?: SystemCollectionDetailController;
  instance: SystemCollectionInstance;
  onInteractionError?(error: SystemCollectionInteractionError): void;
  state: ReadySystemCollectionState;
  trailingActions?: ReactNode;
}

export function SystemCollectionPresentationCore({
  contextualActions,
  detailController,
  instance,
  onInteractionError,
  state,
  trailingActions,
}: SystemCollectionPresentationCoreProps) {
  const presentation = instance.presentations.find(
    (candidate) =>
      readSystemCollectionPresentationRuntime(candidate).instance.descriptor
        .id === state.activePresentationId,
  );

  if (!presentation || !state.activePresentationId) return null;

  const { descriptor } =
    readSystemCollectionPresentationRuntime(presentation).instance;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-system-collection-presentation-core
    >
      <CollectionPresentationToolbar
        tabs={
          <SystemCollectionFixedTabs
            presentations={instance.presentations}
            value={state.activePresentationId}
            onValueChange={state.setActivePresentationId}
          />
        }
        actions={
          <>
            <SystemCollectionQueryEditor
              presentation={presentation}
              resetWarning={state.resetWarning}
              value={state.query}
              onChange={(query) => state.setQuery(descriptor.id, query)}
              onDismissResetWarning={() =>
                state.dismissResetWarning(descriptor.id)
              }
            />
            {contextualActions}
            {descriptor.create ? (
              <SystemCollectionCreateActionButton
                key={`${instance.instanceKey}:${descriptor.create.id}`}
                action={descriptor.create}
                onRejected={(message) =>
                  onInteractionError?.({
                    instanceKey: instance.instanceKey,
                    kind: "create",
                    message,
                    presentationId: descriptor.id,
                    targetId: descriptor.create?.id,
                  })
                }
              />
            ) : null}
            {trailingActions}
          </>
        }
      />
      <SystemCollectionPresentationShell
        detailController={detailController}
        instanceKey={instance.instanceKey}
        presentation={presentation}
        query={state.query}
        onInteractionError={onInteractionError}
        onQueryChange={(query) => state.setQuery(descriptor.id, query)}
      />
    </div>
  );
}
