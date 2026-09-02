import type { ReactNode } from "react";

import { Tabs } from "@/components/ui/tabs";

import type { CollectionStateController } from "../runtime/hooks/use-collection-state";
import { readCollectionPresentationRuntime } from "../runtime/model/runtime";
import type {
  CollectionInstance,
  CollectionInteractionError,
} from "../runtime/model/types";
import { CollectionCreateControl } from "../runtime/ui/create-action";
import { CollectionFixedTabs } from "../runtime/ui/fixed-presentation-tabs";
import { CollectionPresentationShell } from "../runtime/ui/presentation-shell";
import { CollectionQueryEditor } from "../runtime/ui/query-editor";
import type { PageCollectionDefinition } from "../persisted/page-collection-definition";
import {
  PageCollectionPresentation,
  type PageCollectionPresentationProps,
} from "../persisted/page-collection-presentation";
import { CollectionHostFrame } from "./collection-host-frame";

type ReadyCollectionState = Extract<
  CollectionStateController,
  { phase: "ready" }
>;

export interface FixedCollectionHostProps {
  contextualActions?: ReactNode;
  instance: CollectionInstance;
  onInteractionError?(error: CollectionInteractionError): void;
  state: ReadyCollectionState;
  trailingActions?: ReactNode;
}

export interface SchemaBackedCollectionHostProps {
  actions?: ReactNode;
  activePresentationId: string;
  definition: PageCollectionDefinition;
  presentation: Omit<PageCollectionPresentationProps, "descriptor"> | null;
  tabs: ReactNode;
  onActivePresentationChange(value: string): void;
}

export type CollectionHostProps =
  | FixedCollectionHostProps
  | SchemaBackedCollectionHostProps;

export function CollectionHost(props: CollectionHostProps) {
  return "instance" in props ? (
    <FixedCollectionHostContent {...props} />
  ) : (
    <SchemaBackedCollectionHostContent {...props} />
  );
}

function FixedCollectionHostContent({
  contextualActions,
  instance,
  onInteractionError,
  state,
  trailingActions,
}: FixedCollectionHostProps) {
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
      definition="fixed"
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

function SchemaBackedCollectionHostContent({
  actions,
  activePresentationId,
  definition,
  presentation,
  tabs,
  onActivePresentationChange,
}: SchemaBackedCollectionHostProps) {
  const descriptor = definition.presentations.find(
    (candidate) => candidate.id === activePresentationId,
  );
  if (!descriptor || !presentation) return null;

  return (
    <Tabs
      value={activePresentationId}
      onValueChange={onActivePresentationChange}
      className="gap-0"
    >
      <CollectionHostFrame
        definition="schema-backed"
        tabs={tabs}
        actions={actions}
      >
        <div
          className="flex-none"
          data-collection-presentation={descriptor.id}
          data-collection-presentation-kind={descriptor.layout.kind}
        >
          <PageCollectionPresentation
            {...presentation}
            descriptor={descriptor}
          />
        </div>
      </CollectionHostFrame>
    </Tabs>
  );
}
