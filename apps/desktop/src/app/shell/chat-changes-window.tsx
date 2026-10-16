import { useState, type ReactNode } from "react";
import {
  ChatChangesOpenerContext,
  type ChatFileChangesTarget,
} from "@/features/agent-sessions";
import { ChangesWindow } from "@/features/changes";
import { useSpace } from "@/features/space";

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
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  // A project file belongs to that project; a file of a nested Space, to
  // the active project the Space lives in.
  const projectPath =
    target && rootSpaces.some((space) => space.id === target.spaceId)
      ? target.spacePath
      : (activeRootPath ?? target?.spacePath);
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
            projectPath,
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
