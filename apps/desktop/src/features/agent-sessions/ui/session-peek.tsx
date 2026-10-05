import { useEffect, useRef, useState } from "react";
import { PortalContext } from "@ariakit/react";
import { Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { usePeekStackEntry } from "@/shared/hooks/use-peek-stack-entry";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type {
  AgentSession,
  AgentSessionTarget,
  NewSessionDraftTarget,
} from "../model";
import { keepLayerOpenOnEscape } from "@/shared/lib/escape-key";
import {
  AGENT_SESSION_CONTENT_ATTRIBUTE,
  isInsideAgentSessionContent,
} from "../lib/session-content";
import { NewSessionDraft } from "../chat/ui/new-session-draft";
import type { StartedSession } from "../chat/hooks/use-new-session-draft";
import { AgentSessionContent } from "./session-view";
import * as m from "@/paraglide/messages.js";

interface AgentSessionPeekProps {
  target: AgentSessionTarget | null;
  /** A new session draft shown instead of a session. */
  draft?: NewSessionDraftTarget | null;
  /** The draft's first send created this session; the peek now shows it. */
  onDraftStarted?: (started: StartedSession) => void;
  /** "New session in terminal" from the draft. */
  onOpenNewSessionTerminal?: (spacePath: string) => void;
  onOpenAgentSettings?: () => void;
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

/** Session in the Page Peek pattern: a wide temporary panel over the context. */
export function AgentSessionPeek({
  target,
  draft = null,
  onDraftStarted,
  onOpenNewSessionTerminal,
  onOpenAgentSettings,
  focusTerminal = false,
  onOpenChange,
  onExpand,
  onOpenRoutine,
}: AgentSessionPeekProps) {
  // Keep the last content while the sheet animates out.
  const current = target ?? draft;
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);
  const shownTarget = shown && "sessionId" in shown ? shown : null;
  const shownDraft = shown && "draftId" in shown ? shown : null;
  const open = Boolean(current);
  const expandingRef = useRef(false);
  const [expanding, setExpanding] = useState(false);
  // The composer's `@` and `/` searches render inside the sheet, whose
  // scroll lock otherwise swallows the wheel outside it.
  const [content, setContent] = useState<HTMLElement | null>(null);
  usePeekStackEntry(open, () => onOpenChange(false));
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={setContent}
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none"
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
        onEscapeKeyDown={(event) => {
          // Esc inside the session belongs to the agent, e.g. to interrupt a turn.
          if (isInsideAgentSessionContent(event.target))
            keepLayerOpenOnEscape(event);
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
        <PortalContext.Provider value={content}>
          {shownDraft && (
            <div
              {...{ [AGENT_SESSION_CONTENT_ATTRIBUTE]: "" }}
              className="flex h-full min-h-0 flex-col"
            >
              <NewSessionDraft
                key={shownDraft.draftId}
                spacePath={shownDraft.spacePath}
                onStarted={(started) => onDraftStarted?.(started)}
                onOpenTerminal={(spacePath) =>
                  onOpenNewSessionTerminal?.(spacePath)
                }
                onOpenAgentSettings={() => onOpenAgentSettings?.()}
                actions={
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
                }
              />
            </div>
          )}
          {shownTarget && (
            <AgentSessionContent
              key={`${shownTarget.sessionId}\n${shownTarget.launchId ?? ""}`}
              target={shownTarget}
              focusTerminal={focusTerminal}
              onOpenRoutine={onOpenRoutine}
              onOpenAgentSettings={onOpenAgentSettings}
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
        </PortalContext.Provider>
      </SheetContent>
    </Sheet>
  );
}
