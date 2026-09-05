import type { GitSaveScope } from "./save-scope";
export interface PageSaveOwner {
  save(): Promise<void>;
  saveAll(scope?: GitSaveScope): Promise<void>;
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
) {
  const owner = owners.get(`${spacePath}\0${path}`)?.at(-1);
  if (!owner) throw new Error("Page save owner unavailable");
  await (all ? owner.saveAll(scope) : owner.save());
}

export function hasPageSaveOwner(spacePath: string, path: string) {
  return Boolean(owners.get(`${spacePath}\0${path}`)?.length);
}
