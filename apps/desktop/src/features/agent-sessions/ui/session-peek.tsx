import { useEffect, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type { AgentSession, AgentSessionTarget } from "../model";
import {
  AGENT_SESSION_CONTENT_ATTRIBUTE,
  AgentSessionContent,
} from "./session-view";
import * as m from "@/paraglide/messages.js";

interface AgentSessionPeekProps {
  target: AgentSessionTarget | null;
  /** Focus goes to the terminal instead of the peek chrome. */
  focusTerminal?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the session in the main area; resolves false when a guard kept the stack. */
  onExpand: (
    target: AgentSessionTarget,
    session: AgentSession | null,
  ) => Promise<boolean>;
  onOpenRoutine(routine: RoutineLaunchLink): void;
}

function isInsideSessionContent(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(`[${AGENT_SESSION_CONTENT_ATTRIBUTE}]`) !== null
  );
}

/** Session in the Page Peek pattern: a wide temporary panel over the context. */
export function AgentSessionPeek({
  target,
  focusTerminal = false,
  onOpenChange,
  onExpand,
  onOpenRoutine,
}: AgentSessionPeekProps) {
  // Keep the last target while the sheet animates out.
  const [shownTarget, setShownTarget] = useState(target);
  if (target && target !== shownTarget) setShownTarget(target);
  const expandingRef = useRef(false);
  const [expanding, setExpanding] = useState(false);
  useEffect(() => {
    if (target) expandingRef.current = false;
  }, [target]);

  const expand = async (session: AgentSession | null) => {
    if (!shownTarget || expandingRef.current) return;
    expandingRef.current = true;
    setExpanding(true);
    try {
      if (!(await onExpand(shownTarget, session))) expandingRef.current = false;
    } finally {
      setExpanding(false);
    }
  };

  return (
    <Sheet open={Boolean(target)} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none"
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
        onEscapeKeyDown={(event) => {
          // Esc inside the session belongs to the agent, e.g. to interrupt a turn.
          if (isInsideSessionContent(event.target)) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          // The terminal takes focus itself once it is attached.
          if (focusTerminal) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // Expanding hands focus to the main area instead of the opener.
          if (expandingRef.current) event.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{m.sessions_peek_title()}</SheetTitle>
        {shownTarget && (
          <AgentSessionContent
            key={`${shownTarget.sessionId}\n${shownTarget.launchId ?? ""}`}
            target={shownTarget}
            focusTerminal={focusTerminal}
            onOpenRoutine={onOpenRoutine}
            renderActions={(menu, view) => (
              <>
                {menu}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={expanding}
                  onClick={() => void expand(view.session)}
                >
                  <Maximize2 data-icon="inline-start" />
                  {m.attachments_full_page()}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenChange(false)}
                >
                  <X />
                  <span className="sr-only">
                    {m.sessions_action_close_peek()}
                  </span>
                </Button>
              </>
            )}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
