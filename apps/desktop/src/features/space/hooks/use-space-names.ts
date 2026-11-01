import { useMemo } from "react";

import { useSpace, type SpacePublicState } from "../model/public-space";

/** The name of a Space of the open project by its path; null when unknown. */
export type SpaceNameResolver = (spacePath: string) => string | null;

type SpaceNameSource = Pick<
  SpacePublicState,
  "activeRootName" | "activeRootPath" | "spaces"
>;

/**
 * The names of the project root and its child Spaces as the Space store
 * holds them, so a rename of a Space shows at once in everything that names
 * it by its path.
 */
export function spaceNameResolver({
  activeRootName,
  activeRootPath,
  spaces,
}: SpaceNameSource): SpaceNameResolver {
  const names = new Map<string, string>();
  if (activeRootPath && activeRootName) {
    names.set(spacePathKey(activeRootPath), activeRootName);
  }
  for (const space of spaces) names.set(spacePathKey(space.path), space.name);
  return (spacePath) => names.get(spacePathKey(spacePath)) ?? null;
}

export function useSpaceNames(): SpaceNameResolver {
  const { activeRootName, activeRootPath, spaces } = useSpace((state) => ({
    activeRootName: state.activeRootName,
    activeRootPath: state.activeRootPath,
    spaces: state.spaces,
  }));
  return useMemo(
    () => spaceNameResolver({ activeRootName, activeRootPath, spaces }),
    [activeRootName, activeRootPath, spaces],
  );
}

function spacePathKey(path: string) {
  return path.replace(/[\\/]+$/, "");
}
