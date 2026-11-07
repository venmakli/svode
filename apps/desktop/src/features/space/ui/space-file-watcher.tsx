import { useAgentContentRelocation } from "../hooks/use-agent-content-relocation";
import { useProjectSpacesFollow } from "../hooks/use-project-spaces-follow";
import { useSpaceFileWatch } from "../hooks/use-space-file-watch";

export function SpaceFileWatcher() {
  useSpaceFileWatch();
  useAgentContentRelocation();
  useProjectSpacesFollow();
  return null;
}
