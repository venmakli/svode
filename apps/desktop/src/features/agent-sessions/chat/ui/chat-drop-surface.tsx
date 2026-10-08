import type { KeyboardEventHandler, ReactNode } from "react";
import {
  ResourceDropOverlay,
  type ResourceDropOverlayState,
} from "@/features/space/resource-drag";
import { cn } from "@/shared/lib/utils";
import { ComposerDropProvider, useChatDrop } from "../hooks/use-chat-drop";
import * as m from "@/paraglide/messages.js";

/**
 * A session surface with its composer — timeline and field — that takes
 * files and sidebar resources dropped on it (Stage 10 `08` R5), with the
 * terminal's highlight: how many objects a release attaches, or why it
 * attaches nothing.
 */
export function ChatDropSurface({
  refusal = null,
  className = "h-full min-h-0",
  onKeyDown,
  children,
}: {
  /** Why the composer takes nothing now, as its own line says. */
  refusal?: string | null;
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  const { containerRef, receiverRef, overlay, handlers } = useChatDrop(refusal);
  return (
    <ComposerDropProvider value={receiverRef}>
      <div
        ref={containerRef}
        className={cn("relative", className)}
        onKeyDown={onKeyDown}
        {...handlers}
      >
        {children}
        <ResourceDropOverlay state={overlay} label={overlayLabel(overlay)} />
      </div>
    </ComposerDropProvider>
  );
}

function overlayLabel(state: ResourceDropOverlayState): string {
  if (!state) return "";
  switch (state.kind) {
    case "active":
      return state.count === 1
        ? m.sessions_chat_drop_attach()
        : m.sessions_chat_drop_attach_count({ count: state.count });
    case "refused":
      return state.reason;
    case "error":
      return state.reason ?? m.sessions_chat_drop_failed();
  }
}
