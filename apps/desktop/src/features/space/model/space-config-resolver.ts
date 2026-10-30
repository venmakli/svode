import type { SpaceInfo } from "./types";

/** Opens the Changes of the config file of a project or space in conflict. */
export type SpaceConfigResolver = (space: SpaceInfo) => void;

let resolver: SpaceConfigResolver | null = null;

/** The app shell owns the Changes window a config conflict is resolved in. */
export function registerSpaceConfigResolver(next: SpaceConfigResolver) {
  resolver = next;
  return () => {
    if (resolver === next) resolver = null;
  };
}

export function spaceConfigResolver(space: SpaceInfo) {
  if (!resolver) return undefined;
  return () => resolver?.(space);
}
