import type { ReactNode } from "react";

import { CollectionPresentationToolbar } from "../../ui/presentation-core";
import type { CollectionCoreStateController } from "../hooks/use-collection-core-state";
import { readCollectionCorePresentationRuntime } from "../model/runtime";
import type {
  CollectionCoreInstance,
  CollectionCoreInteractionError,
} from "../model/types";
import { CollectionCoreCreateActionButton } from "./create-action";
import { CollectionCoreFixedTabs } from "./fixed-presentation-tabs";
import { CollectionCorePresentationShell } from "./presentation-shell";
import { CollectionCoreQueryEditor } from "./query-editor";

type ReadyCollectionCoreState = Extract<
  CollectionCoreStateController,
  { phase: "ready" }
>;

export interface CollectionCorePresentationCoreProps {
  contextualActions?: ReactNode;
  instance: CollectionCoreInstance;
  onInteractionError?(error: CollectionCoreInteractionError): void;
  state: ReadyCollectionCoreState;
  trailingActions?: ReactNode;
}

export function CollectionCorePresentationCore({
  contextualActions,
  instance,
  onInteractionError,
  state,
  trailingActions,
}: CollectionCorePresentationCoreProps) {
  const presentation = instance.presentations.find(
    (candidate) =>
      readCollectionCorePresentationRuntime(candidate).instance.descriptor
        .id === state.activePresentationId,
  );

  if (!presentation || !state.activePresentationId) return null;

  const { descriptor } =
    readCollectionCorePresentationRuntime(presentation).instance;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-collection-core-presentation-core
    >
      <CollectionPresentationToolbar
        tabs={
          <CollectionCoreFixedTabs
            presentations={instance.presentations}
            value={state.activePresentationId}
            onValueChange={state.setActivePresentationId}
          />
        }
        actions={
          <>
            <CollectionCoreQueryEditor
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
              <CollectionCoreCreateActionButton
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
      <CollectionCorePresentationShell
        instanceKey={instance.instanceKey}
        presentation={presentation}
        query={state.query}
        onInteractionError={onInteractionError}
        onQueryChange={(query) => state.setQuery(descriptor.id, query)}
      />
    </div>
  );
}
