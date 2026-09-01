import { useCallback, useMemo, useState } from "react";
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
  type CollectionActivationContext,
  type CollectionInstance,
} from "@/features/collection";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import { useAttachmentsSource } from "../hooks/use-attachments-source";
import {
  attachmentsPresentationState,
  createAttachmentsPresentationDescriptor,
} from "../model/presentation";
import type {
  AttachmentActivationRequest,
  AttachmentRow,
  AttachmentsSnapshot,
} from "../model/types";
import { AttachmentsPeek } from "./attachments-peek";

export function AttachmentsSurface({
  owner,
  readOnly,
}: ScopeSurfaceRenderContext & { readOnly: boolean }) {
  const [peekTarget, setPeekTarget] =
    useState<AttachmentActivationRequest | null>(null);
  const reconcilePeek = useCallback((snapshot: AttachmentsSnapshot) => {
    setPeekTarget((current) => {
      if (!current || current.sourceGeneration === snapshot.generation) {
        return current;
      }
      const row = snapshot.rows.find(
        (candidate) =>
          candidate.key === current.row.key &&
          candidate.path === current.row.path,
      );
      return row
        ? { ...current, row, sourceGeneration: snapshot.generation }
        : null;
    });
  }, []);
  const source = useAttachmentsSource(owner, reconcilePeek);
  const onActivate = useCallback(
    (row: AttachmentRow, activation: CollectionActivationContext) => {
      if (source.state.phase !== "ready") {
        throw new Error(m.attachments_source_stale());
      }
      const current = source.state.snapshot.rows.find(
        (candidate) => candidate.key === row.key && candidate.path === row.path,
      );
      if (!current) throw new Error(m.attachments_source_stale());
      setPeekTarget({
        activation,
        mode: "peek",
        owner: source.state.snapshot.owner,
        row: current,
        sourceGeneration: source.state.snapshot.generation,
      });
    },
    [source.state],
  );
  const presentation = defineCollectionPresentation({
    descriptor: createAttachmentsPresentationDescriptor({ onActivate }),
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
          if (!open) setPeekTarget(null);
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
