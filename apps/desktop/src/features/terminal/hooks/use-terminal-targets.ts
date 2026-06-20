import { useMemo } from "react";
import { useSpaceStore } from "@/features/space";
import {
  buildProjectTerminalTarget,
  buildSpaceTerminalTargets,
} from "@/features/terminal/lib/targets";

export function useTerminalTargets() {
  const activeRootId = useSpaceStore((state) => state.activeRootId);
  const activeRootName = useSpaceStore((state) => state.activeRootName);
  const activeRootPath = useSpaceStore((state) => state.activeRootPath);
  const spaces = useSpaceStore((state) => state.spaces);

  const projectTarget = useMemo(
    () =>
      buildProjectTerminalTarget({
        id: activeRootId,
        name: activeRootName,
        path: activeRootPath,
      }),
    [activeRootId, activeRootName, activeRootPath],
  );
  const spaceTargets = useMemo(
    () => buildSpaceTerminalTargets(spaces),
    [spaces],
  );

  return { projectTarget, spaceTargets };
}
