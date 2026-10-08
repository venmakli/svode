import { useState, type ReactNode } from "react";
import {
  ChatChangesOpenerContext,
  type ChatFileChangesTarget,
} from "@/features/agent-sessions";
import { ChangesWindow } from "@/features/changes";

/**
 * Opens the "Changes" window of a file the agent changed in a chat turn
 * (Stage 10 `08` R2): the same window as the changes control, scoped to
 * that one file.
 */
export function ChatChangesWindowProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<ChatFileChangesTarget | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <ChatChangesOpenerContext.Provider
      value={(next) => {
        setTarget(next);
        setOpen(true);
      }}
    >
      {children}
      {target && (
        <ChangesWindow
          target={{
            kind: "page",
            sourceShape: "file",
            spacePath: target.spacePath,
            path: target.path,
            name: target.name,
          }}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </ChatChangesOpenerContext.Provider>
  );
}
