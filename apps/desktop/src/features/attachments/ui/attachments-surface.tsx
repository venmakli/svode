import { DirectoryPeekTable } from "./directory-peek-table";
import { attachmentHierarchy } from "./attachment-hierarchy";
import { useMemo } from "react";
import { AlertTriangle, Paperclip } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  CollectionHost,
  defineCollectionPresentation,
  useCollectionState,
  type CollectionInstance,
} from "@/features/collection";
import type { ScopeOpenItem } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useAttachmentsActivation } from "../hooks/use-attachments-activation";
import { AttachmentIcon } from "./attachment-icon";
import { useAttachmentsCreate } from "../hooks/use-attachments-create";
import {
  attachmentsPresentationState,
  createAttachmentsPresentationDescriptor,
} from "../model/presentation";
import type {
  AttachmentOwnerRef,
  AttachmentOwnerPeekRenderer,
} from "../model/types";
import { AttachmentsPeek } from "./attachments-peek";
import {
  SourceError,
  SourceRefreshDiagnostic,
} from "./attachments-source-states";

interface AttachmentsSurfaceProps {
  owner: AttachmentOwnerRef;
  readOnly: boolean;
  renderOwnerPeek: AttachmentOwnerPeekRenderer;
  /** A folder the open request of the surface addresses. */
  openItem?: ScopeOpenItem;
}

function AttachmentsOwnerSurface({
  owner,
  readOnly,
  renderOwnerPeek,
  openItem,
}: AttachmentsSurfaceProps) {
  const { source, onActivate, peekTarget, closePeek, retargetPeek } =
    useAttachmentsActivation(owner, openItem);
  const create = useAttachmentsCreate({
    owner,
    readOnly,
    refresh: source.refresh,
  });
  const presentation = defineCollectionPresentation({
    descriptor: createAttachmentsPresentationDescriptor({
      create,
      hierarchy: attachmentHierarchy(source),
      onActivate,
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
      sourceEmpty: <AttachmentsEmpty />,
    }),
  });
  const instance = useMemo<CollectionInstance>(
    () => ({
      defaultPresentationId: "all",
      instanceKey: `attachments:${owner.ownerKey}`,
      presentations: [presentation],
      stateScope: "session",
    }),
    [owner.ownerKey, presentation],
  );
  const collectionState = useCollectionState(instance);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-attachments-surface>
      {collectionState.phase === "ready" ? (
        <CollectionHost instance={instance} state={collectionState} />
      ) : (
        <div className="px-6 py-3">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>
              {collectionState.diagnostics.join(" ")}
            </AlertDescription>
          </Alert>
        </div>
      )}
      <AttachmentsPeek
        owner={owner}
        renderOwnerPeek={renderOwnerPeek}
        readOnly={readOnly}
        target={peekTarget}
        onContentPathChange={retargetPeek}
        directoryContent={
          peekTarget?.item.kind === "directory" && peekTarget.item.ownerPath ? (
            <DirectoryPeekTable
              key={peekTarget.item.ownerPath}
              path={peekTarget.item.ownerPath}
              ownerKey={owner.ownerKey}
              source={source}
              origin={peekTarget.activation}
              onActivate={onActivate}
            />
          ) : undefined
        }
        onOpenChange={(open) => {
          if (!open) closePeek();
        }}
      />
    </div>
  );
}

function AttachmentsEmpty() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Paperclip />
        </EmptyMedia>
        <EmptyTitle>{m.attachments_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.attachments_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function AttachmentsSurface(props: AttachmentsSurfaceProps) {
  return <AttachmentsOwnerSurface key={props.owner.ownerKey} {...props} />;
}
