import { NewSessionSidebarItem } from "@/features/agent-sessions";
import { newSessionShortcut } from "./model/shortcut-descriptions";
import { useNewSessionSpace } from "./hooks/use-new-session-space";
import { useStartSessionInMainArea } from "./agent-session-peek-host";

/** "New session" of the main sidebar. */
export function NewSessionSidebarRow() {
  const space = useNewSessionSpace();
  const startSession = useStartSessionInMainArea();
  return (
    <NewSessionSidebarItem
      space={space}
      shortcut={newSessionShortcut}
      onStart={(scope) => void startSession(scope)}
    />
  );
}
