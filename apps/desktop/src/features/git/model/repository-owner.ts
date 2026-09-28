import type { RepositoryAccessTarget } from "./repository-access-consumer";

export interface RepositoryOwnerContext {
  projectName: string | null;
  projectPath: string | null;
  spaces: readonly { name: string; path: string }[];
}

export interface RepositoryOwner {
  displayName: string;
  displayPath: string;
  /** The Project or Space path whose Git settings show this repository. */
  settingsPath: string | null;
}

/**
 * Names the Project or Space that owns a repository location. A repository
 * outside the project and its registered Spaces is named by its path.
 */
export function repositoryOwner(
  repositoryPath: string,
  context: RepositoryOwnerContext,
): RepositoryOwner {
  return (
    knownRepositoryOwner(repositoryPath, context) ?? {
      displayName: basename(repositoryPath),
      displayPath: repositoryPath,
      settingsPath: context.projectPath,
    }
  );
}

/** The Project or Space at exactly this location, if there is one. */
function knownRepositoryOwner(
  repositoryPath: string,
  context: RepositoryOwnerContext,
): RepositoryOwner | null {
  const key = pathKey(repositoryPath);
  if (context.projectPath && pathKey(context.projectPath) === key) {
    return {
      displayName: context.projectName || basename(repositoryPath),
      displayPath: repositoryPath,
      settingsPath: context.projectPath,
    };
  }
  const space = context.spaces.find((space) => pathKey(space.path) === key);
  if (space) {
    return {
      displayName: space.name || basename(repositoryPath),
      displayPath: repositoryPath,
      settingsPath: space.path,
    };
  }
  return null;
}

/**
 * A target at a Project or Space location is named by that owner, whatever
 * label its consumer gave it; other targets keep the consumer's identity.
 */
export function ownedRepositoryAccessTarget(
  target: RepositoryAccessTarget,
  context: RepositoryOwnerContext,
): RepositoryAccessTarget {
  const owner = knownRepositoryOwner(target.repositoryPath, context);
  if (!owner) return target;
  return {
    ...target,
    displayName: owner.displayName,
    displayPath: owner.displayPath,
    openSettings:
      target.openSettings ?? repositorySettingsOpener(owner.settingsPath),
  };
}

type RepositorySettingsOpener = (settingsPath: string) => void;

let settingsOpener: RepositorySettingsOpener | null = null;

/** The app shell opens Git settings for a Project or Space path. */
export function registerRepositorySettingsOpener(
  opener: RepositorySettingsOpener,
) {
  settingsOpener = opener;
  return () => {
    if (settingsOpener === opener) settingsOpener = null;
  };
}

export function repositorySettingsOpener(settingsPath: string | null) {
  if (!settingsOpener || !settingsPath) return undefined;
  return () => settingsOpener?.(settingsPath);
}

function pathKey(path: string) {
  return path.replace(/[\\/]+$/, "");
}

function basename(path: string) {
  const key = pathKey(path);
  return key.split(/[\\/]/).pop() || key;
}
