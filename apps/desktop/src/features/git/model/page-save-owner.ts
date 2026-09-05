export interface PageSaveOwner {
  save(): Promise<void>;
  saveAll(): Promise<void>;
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
) {
  const owner = owners.get(`${spacePath}\0${path}`)?.at(-1);
  if (!owner) throw new Error("Page save owner unavailable");
  await (all ? owner.saveAll() : owner.save());
}
