import { useMemo } from "react";
import { AlertTriangle, Paperclip } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import * as m from "@/paraglide/messages.js";

import { useAttachmentsActivation } from "../hooks/use-attachments-activation";
import { AttachmentIcon } from "./attachment-icon";
import { useAttachmentsCreate } from "../hooks/use-attachments-create";
import {
  attachmentsPresentationState,
  createAttachmentsPresentationDescriptor,
} from "../model/presentation";
import type { AttachmentOwnerRef } from "../model/types";
import { AttachmentsPeek } from "./attachments-peek";

function AttachmentsOwnerSurface({
  owner,
  readOnly,
}: {
  owner: AttachmentOwnerRef;
  readOnly: boolean;
}) {
  const { source, onActivate, peekTarget, closePeek } =
    useAttachmentsActivation(owner);
  const create = useAttachmentsCreate({
    owner,
    readOnly,
    refresh: source.refresh,
  });
  const presentation = defineCollectionPresentation({
    descriptor: createAttachmentsPresentationDescriptor({
      create,
      onActivate,
      renderLeading: (row) => <AttachmentIcon row={row} />,
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
        readOnly={readOnly}
        target={peekTarget}
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

function SourceError({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void | Promise<void>;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{m.attachments_load_error_title()}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={() => void onRetry()}>
          {m.attachments_retry()}
        </Button>
      </AlertAction>
    </Alert>
  );
}

function SourceRefreshDiagnostic({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void | Promise<void>;
}) {
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{m.attachments_refresh_error_title()}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={() => void onRetry()}>
          {m.attachments_retry()}
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function AttachmentsSurface(props: {
  owner: AttachmentOwnerRef;
  readOnly: boolean;
}) {
  return <AttachmentsOwnerSurface key={props.owner.ownerKey} {...props} />;
}
