import { useEffect, useState } from "react";
import { ChangesWindow, fileChangesTarget } from "@/features/changes";
import { useSpace, type SpaceInfo } from "@/features/space";
import {
  registerSpaceConfigResolver,
  SPACE_CONFIG_PATH,
} from "@/features/space/app-shell";

/**
 * The Changes window of a config file in conflict, opened by "Resolve" of
 * the config warning on a home page or in Settings.
 */
export function SpaceConfigChanges() {
  const [space, setSpace] = useState<SpaceInfo | null>(null);
  const [open, setOpen] = useState(false);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  useEffect(
    () =>
      registerSpaceConfigResolver((next) => {
        setSpace(next);
        setOpen(true);
      }),
    [],
  );
  if (!space) return null;
  return (
    <ChangesWindow
      target={fileChangesTarget({
        spacePath: space.path,
        projectPath: activeRootPath ?? space.path,
        path: SPACE_CONFIG_PATH,
      })}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
