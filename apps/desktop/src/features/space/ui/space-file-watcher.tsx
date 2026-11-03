import { useAgentContentRelocation } from "../hooks/use-agent-content-relocation";
import { useSpaceFileWatch } from "../hooks/use-space-file-watch";

export function SpaceFileWatcher() {
  useSpaceFileWatch();
  useAgentContentRelocation();
  return null;
}
