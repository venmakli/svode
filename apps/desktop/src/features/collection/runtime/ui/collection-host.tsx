import type { ReactNode } from "react";

import type { CollectionStateController } from "../hooks/use-collection-state";
import { readCollectionPresentationRuntime } from "../model/runtime";
import type {
  CollectionInstance,
  CollectionInteractionError,
} from "../model/types";
import { CollectionCreateControl } from "./create-action";
import { CollectionHostFrame } from "./collection-host-frame";
import { CollectionFixedTabs } from "./fixed-presentation-tabs";
import { CollectionPresentationShell } from "./presentation-shell";
import { CollectionQueryEditor } from "./query-editor";

type ReadyCollectionState = Extract<
  CollectionStateController,
  { phase: "ready" }
>;

export interface CollectionHostProps {
  contextualActions?: ReactNode;
  instance: CollectionInstance;
  onInteractionError?(error: CollectionInteractionError): void;
  state: ReadyCollectionState;
  trailingActions?: ReactNode;
}

export function CollectionHost({
  contextualActions,
  instance,
  onInteractionError,
  state,
  trailingActions,
}: CollectionHostProps) {
  const presentation = instance.presentations.find(
    (candidate) =>
      readCollectionPresentationRuntime(candidate).instance.descriptor.id ===
      state.activePresentationId,
  );

  if (!presentation || !state.activePresentationId) return null;

  const { descriptor } =
    readCollectionPresentationRuntime(presentation).instance;

  return (
    <CollectionHostFrame
      tabs={
        <CollectionFixedTabs
          presentations={instance.presentations}
          value={state.activePresentationId}
          onValueChange={state.setActivePresentationId}
        />
      }
      actions={
        <>
          <CollectionQueryEditor
            presentation={presentation}
            resetWarning={state.resetWarning}
            value={state.query}
            onChange={(query) => state.setQuery(descriptor.id, query)}
            onDismissResetWarning={() =>
              state.dismissResetWarning(descriptor.id)
            }
          />
          {contextualActions}
          {descriptor.create?.intents.length ? (
            <CollectionCreateControl
              key={`${instance.instanceKey}:${descriptor.id}:create`}
              capability={descriptor.create}
              onRejected={(targetId, message) =>
                onInteractionError?.({
                  instanceKey: instance.instanceKey,
                  kind: "create",
                  message,
                  presentationId: descriptor.id,
                  targetId,
                })
              }
            />
          ) : null}
          {trailingActions}
        </>
      }
    >
      <CollectionPresentationShell
        instanceKey={instance.instanceKey}
        presentation={presentation}
        query={state.query}
        onInteractionError={onInteractionError}
        onQueryChange={(query) => state.setQuery(descriptor.id, query)}
      />
    </CollectionHostFrame>
  );
}
