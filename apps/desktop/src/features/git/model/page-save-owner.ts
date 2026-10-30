import { gitSaveScopeContainsPath, type GitSaveScope } from "./save-scope";

/**
 * An explicit commit this window refuses before any write: a Page in its area
 * holds a draft in an open source conflict, so the file on disk is not the
 * text the user sees.
 */
export interface GitCommitRefusal {
  path: string;
  title: string;
  /** Opens the source conflict recovery of the Page. */
  chooseVersion(): void;
}

/** A Page whose editor holds a draft in an open source conflict. */
export interface PageSourceConflictOwner {
  title: string;
  chooseVersion(): void;
}

export interface PageSaveOwner {
  save(): Promise<GitCommitRefusal | null>;
  saveAll(scope?: GitSaveScope): Promise<GitCommitRefusal | null>;
  sourceConflict(): PageSourceConflictOwner | null;
}

const owners = new Map<string, PageSaveOwner[]>();

export function registerPageSaveOwner(
  spacePath: string,
  path: string,
  owner: PageSaveOwner,
) {
  const key = `${spacePath}\0${path}`;
  const entries = owners.get(key) ?? [];
  entries.push(owner);
  owners.set(key, entries);
  return () => {
    const remaining = (owners.get(key) ?? []).filter(
      (entry) => entry !== owner,
    );
    if (remaining.length) owners.set(key, remaining);
    else owners.delete(key);
  };
}

export async function dispatchPageSave(
  spacePath: string,
  path: string,
  all: boolean,
  scope?: GitSaveScope,
): Promise<GitCommitRefusal | null> {
  const owner = owners.get(`${spacePath}\0${path}`)?.at(-1);
  if (!owner) throw new Error("Page save owner unavailable");
  return all ? owner.saveAll(scope) : owner.save();
}

export function hasPageSaveOwner(spacePath: string, path: string) {
  return Boolean(owners.get(`${spacePath}\0${path}`)?.length);
}

/**
 * The refusal of an explicit commit of `scope` in `spacePath`, decided before
 * any write: the Page first by path among those of the area whose editor in
 * this window holds a draft in an open source conflict. The area is matched
 * on the file system, so a Page of a Space inside `spacePath` counts too.
 */
export function explicitCommitRefusal(
  spacePath: string,
  scope: GitSaveScope,
): GitCommitRefusal | null {
  const root = fileSystemPath(spacePath);
  let refusal: GitCommitRefusal | null = null;
  for (const [key, entries] of owners) {
    const [ownerSpace, ownerPath] = key.split("\0");
    const file = `${fileSystemPath(ownerSpace)}/${ownerPath.replaceAll("\\", "/")}`;
    if (!file.startsWith(`${root}/`)) continue;
    const path = file.slice(root.length + 1);
    if (!gitSaveScopeContainsPath(scope, path)) continue;
    if (refusal && refusal.path <= path) continue;
    for (const owner of entries) {
      const conflict = owner.sourceConflict();
      if (!conflict) continue;
      refusal = { path, ...conflict };
      break;
    }
  }
  return refusal;
}

function fileSystemPath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}
