import { useCallback, useEffect, useState } from "react";

import type { CollectionActivationContext } from "@/features/collection";
import type { ScopeOpenItem } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

import {
  currentAttachmentItem,
  reconcileAttachmentPeek,
} from "../model/activation";
import type {
  AttachmentActivationRequest,
  AttachmentOwnerRef,
  AttachmentItem,
  AttachmentsSnapshot,
} from "../model/types";
import { useAttachmentsOpenFolder } from "./use-attachments-open-folder";
import { useAttachmentsSource } from "./use-attachments-source";

export function useAttachmentsActivation(
  owner: AttachmentOwnerRef,
  /** A folder the open request of the surface addresses, by its path. */
  openItem?: ScopeOpenItem,
) {
  const [peekTarget, setPeekTarget] =
    useState<AttachmentActivationRequest | null>(null);
  const reconcile = useCallback((snapshot: AttachmentsSnapshot) => {
    setPeekTarget((current) => reconcileAttachmentPeek(current, snapshot));
  }, []);
  const source = useAttachmentsSource(owner, reconcile);
  const { retainPeekTarget } = source;
  const peekItem = peekTarget?.item;
  useEffect(
    () => (peekItem ? retainPeekTarget(peekItem) : undefined),
    [peekItem, retainPeekTarget],
  );
  const onActivate = useCallback(
    (item: AttachmentItem, activation: CollectionActivationContext) => {
      if (source.state.phase !== "ready")
        throw new Error(m.attachments_source_stale());
      const snapshot = source.inventory();
      if (!snapshot) throw new Error(m.attachments_source_stale());
      const current = currentAttachmentItem(snapshot, item);
      if (!current) throw new Error(m.attachments_source_stale());
      setPeekTarget({
        activation,
        mode: "peek",
        ownerSession:
          current.kind === "app" ||
          current.kind === "collection" ||
          current.kind === "page"
            ? { key: current.key, kind: current.kind }
            : undefined,
        owner: snapshot.owner,
        item: current,
        sourceGeneration: snapshot.generation,
      });
    },
    [source],
  );
  useAttachmentsOpenFolder(openItem, source, setPeekTarget);
  const retargetPeek = useCallback((path: string) => {
    setPeekTarget((current) => {
      if (!current || current.item.path === path) return current;
      const folder = /\/readme\.md$/i.test(path);
      return {
        ...current,
        item: {
          ...current.item,
          key: `page:${path}`,
          path,
          contentPath: path,
          ownerPath: folder ? path.slice(0, path.lastIndexOf("/")) : null,
          sourceShape: folder ? "directory" : "file",
        },
      };
    });
  }, []);
  return {
    source,
    onActivate,
    peekTarget,
    closePeek: () => setPeekTarget(null),
    retargetPeek,
  };
}
