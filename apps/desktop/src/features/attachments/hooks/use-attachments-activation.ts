import { useCallback, useState } from "react";

import type { CollectionActivationContext } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import {
  currentAttachmentRow,
  reconcileAttachmentPeek,
} from "../model/activation";
import type {
  AttachmentActivationRequest,
  AttachmentOwnerRef,
  AttachmentRow,
  AttachmentsSnapshot,
} from "../model/types";
import { useAttachmentsSource } from "./use-attachments-source";

export function useAttachmentsActivation(owner: AttachmentOwnerRef) {
  const [peekTarget, setPeekTarget] =
    useState<AttachmentActivationRequest | null>(null);
  const reconcile = useCallback((snapshot: AttachmentsSnapshot) => {
    setPeekTarget((current) => reconcileAttachmentPeek(current, snapshot));
  }, []);
  const source = useAttachmentsSource(owner, reconcile);
  const onActivate = useCallback(
    (row: AttachmentRow, activation: CollectionActivationContext) => {
      if (source.state.phase !== "ready")
        throw new Error(m.attachments_source_stale());
      const snapshot = source.state.snapshot;
      const current = currentAttachmentRow(snapshot, row);
      if (!current) throw new Error(m.attachments_source_stale());
      setPeekTarget({
        activation,
        mode: "peek",
        owner: snapshot.owner,
        row: current,
        sourceGeneration: snapshot.generation,
      });
    },
    [source.state],
  );
  return {
    source,
    onActivate,
    peekTarget,
    closePeek: () => setPeekTarget(null),
  };
}
