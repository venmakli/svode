import { useMemo } from "react";
import { useSpace } from "@/features/space";
import {
  buildProjectTerminalTarget,
  buildSpaceTerminalTargets,
} from "@/features/terminal/lib/targets";

export function useTerminalTargets() {
  const activeRootId = useSpace((state) => state.activeRootId);
  const activeRootName = useSpace((state) => state.activeRootName);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const spaces = useSpace((state) => state.spaces);

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
