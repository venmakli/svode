import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import { toast } from "sonner";
import {
  useResourceDropTarget,
  type DroppedResources,
} from "@/features/space/resource-drag";
import type { LogicalPoint } from "@/platform/native/file-drop";
import {
  droppedPathAttachments,
  droppedResourceAttachment,
} from "../api/attachments";
import type { Attachment } from "../model/attachments";
import * as m from "@/paraglide/messages.js";

/** The composer field of a session surface, as a drop on the surface reaches it. */
export interface ComposerDropReceiver {
  /**
   * Inserts badges at `point` over the field, else at its caret, or at the
   * end of the draft when it did not have focus; the field takes focus.
   */
  insert(attachments: Attachment[], point: LogicalPoint): void;
}

const ComposerDropContext =
  createContext<RefObject<ComposerDropReceiver | null> | null>(null);

export const ComposerDropProvider = ComposerDropContext.Provider;

/** The composer field takes the drops of the surface around it while mounted. */
export function useComposerDropReceiver(receiver: ComposerDropReceiver | null) {
  const receiverRef = useContext(ComposerDropContext);
  useEffect(() => {
    if (!receiverRef || !receiver) return;
    receiverRef.current = receiver;
    return () => {
      if (receiverRef.current === receiver) receiverRef.current = null;
    };
  }, [receiver, receiverRef]);
}

/**
 * Drops on a session surface (Stage 10 `08` R5): files and folders of the
 * OS and sidebar resources become badges of the draft. A known refusal
 * leaves the draft as it is; so does a dropped object that is not there,
 * named in a refusal line as a paste names it.
 */
export function useChatDrop(refusal: string | null) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const receiverRef = useRef<ComposerDropReceiver | null>(null);
  const onDrop = useCallback(
    async (dropped: DroppedResources, point: LogicalPoint) => {
      const result =
        dropped.kind === "paths"
          ? await droppedPathAttachments(dropped.paths)
          : await droppedResourceAttachment(dropped.resource);
      if (!result.ok) {
        toast.error(
          m.sessions_chat_drop_unavailable({
            name: result.unavailable.join(", "),
          }),
        );
        return;
      }
      const receiver = receiverRef.current;
      if (!receiver) throw new Error("The composer went before the drop was read");
      receiver.insert(result.attachments, point);
    },
    [],
  );
  const { overlay, handlers } = useResourceDropTarget({
    containerRef,
    enabled: true,
    refusal,
    onDrop,
  });
  return { containerRef, receiverRef, overlay, handlers };
}
