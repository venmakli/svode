import { useMemo } from "react";
import { useSpace } from "@/features/space";
import { useAgentSessions } from "../hooks";
import { SessionsList } from "./sessions-list";
import { SessionTerminalPane } from "./session-terminal-pane";

interface AgentSessionsScreenProps {
  onOpenAppSettings?: () => void;
}

export function AgentSessionsScreen({
  onOpenAppSettings,
}: AgentSessionsScreenProps) {
  const { activeRootName, activeRootPath, spaces } = useSpace();
  const sessions = useAgentSessions(activeRootPath);
  const spaceNames = useMemo(() => {
    const names = new Map<string, string>();
    spaces.forEach((space) => {
      names.set(space.id, space.name);
      names.set(space.path, space.name);
    });
    return names;
  }, [spaces]);

  return (
    <div className="flex h-full min-h-0 bg-background">
      <SessionsList
        controller={sessions}
        rootName={activeRootName}
        spaceNames={spaceNames}
        onOpenAppSettings={onOpenAppSettings}
      />
      <SessionTerminalPane
        controller={sessions}
        rootName={activeRootName}
        spaceNames={spaceNames}
      />
    </div>
  );
}
