import { useMemo } from "react";

import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  CollectionHost,
  defineCollectionPresentation,
  useCollectionState,
  type CollectionActivationContext,
  type CollectionInstance,
} from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import {
  useAttachmentsFolderSource,
  type AttachmentsFolder,
} from "../hooks/use-attachments-folder-source";
import {
  attachmentsPresentationState,
  createAttachmentsPresentationDescriptor,
} from "../model/presentation";
import type { AttachmentItem } from "../model/types";
import { attachmentHierarchy } from "./attachment-hierarchy";
import { AttachmentIcon } from "./attachment-icon";
import {
  SourceError,
  SourceRefreshDiagnostic,
} from "./attachments-source-states";

/**
 * A read-only folder of another feature with the Attachments mechanics: the
 * same host, Table, Properties and folder expansion, without creation. A
 * folder item expands; a file item goes to `onOpenFile`.
 */
export function AttachmentsFolderTable({
  folder,
  onOpenFile,
}: {
  folder: AttachmentsFolder;
  onOpenFile(item: AttachmentItem, context: CollectionActivationContext): void;
}) {
  const source = useAttachmentsFolderSource(folder);
  const presentation = defineCollectionPresentation({
    descriptor: createAttachmentsPresentationDescriptor({
      hierarchy: attachmentHierarchy(source),
      onActivate: (item, context) => {
        if (item.sourceShape === "directory" && item.ownerPath) {
          source.toggle(item.ownerPath);
          return;
        }
        onOpenFile(item, context);
      },
      renderLeading: (item) => <AttachmentIcon item={item} />,
    }),
    state: attachmentsPresentationState(source.state, {
      blockingError: (
        <SourceError
          message={
            source.state.phase === "blocking_error" ? source.state.message : ""
          }
          onRetry={source.refresh}
        />
      ),
      diagnostic:
        source.state.phase === "ready" && source.state.refreshError ? (
          <SourceRefreshDiagnostic
            message={source.state.refreshError}
            onRetry={source.refresh}
          />
        ) : undefined,
      sourceEmpty: (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.attachments_branch_empty()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ),
    }),
  });
  const instance = useMemo<CollectionInstance>(
    () => ({
      defaultPresentationId: "all",
      instanceKey: `attachments-folder:${folder.key}`,
      presentations: [presentation],
      stateScope: "session",
    }),
    [folder.key, presentation],
  );
  const collectionState = useCollectionState(instance);

  return collectionState.phase === "ready" ? (
    <CollectionHost instance={instance} state={collectionState} />
  ) : null;
}
