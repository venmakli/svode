import type { ReactNode } from "react";

import { Tabs } from "@/components/ui/tabs";

import { CollectionHostFrame } from "../runtime/ui/collection-host-frame";
import type { PageCollectionDefinition } from "./page-collection-definition";
import {
  PageCollectionPresentation,
  type PageCollectionPresentationProps,
} from "./page-collection-presentation";

export function PersistedCollectionHost({
  actions,
  activePresentationId,
  definition,
  presentation,
  tabs,
  onActivePresentationChange,
}: {
  actions?: ReactNode;
  activePresentationId: string;
  definition: PageCollectionDefinition;
  presentation: Omit<PageCollectionPresentationProps, "descriptor"> | null;
  tabs: ReactNode;
  onActivePresentationChange(value: string): void;
}) {
  const descriptor = definition.presentations.find(
    (candidate) => candidate.id === activePresentationId,
  );
  if (!descriptor || !presentation) return null;

  return (
    <Tabs
      value={activePresentationId}
      onValueChange={onActivePresentationChange}
      className="gap-0"
      data-collection-definition="schema-backed"
    >
      <CollectionHostFrame tabs={tabs} actions={actions}>
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
