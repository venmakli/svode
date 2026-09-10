import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppVariables } from "./use-app-variables";
import {
  createVariableDraft,
  editVariableDraft,
  canSaveVariableDraft,
  variableDraftInput,
  type VariableDraft,
} from "../model/app-variable-draft";
import {
  ownerKey,
  sameSource,
  type AppVariableEntry,
  type VariableScope,
} from "../model/app-variables";
import type { SettingsLeaveGuard } from "../model/settings-destination";

export function useVariableCatalogEditor(
  scope?: VariableScope,
  registerLeaveGuard?: (guard: SettingsLeaveGuard) => () => void,
) {
  const variables = useAppVariables(undefined, false, true, scope);
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const [error, setError] = useState(false);
  const [working, setWorking] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [removing, setRemoving] = useState<AppVariableEntry | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useLayoutEffect(
    () => registerLeaveGuard?.(() => !busy.current),
    [registerLeaveGuard],
  );
  const catalog = variables.catalog;
  const currentEntry = draft
    ? catalog?.entries.find(
        (e) =>
          sameSource(e.source, { owner: draft.owner, name: draft.name }) &&
          (!draft.keep || e.mode === draft.keep),
      )
    : undefined;
  const collision = Boolean(draft && !draft.editing && currentEntry);
  const stale = Boolean(
    draft &&
    (draft.editing
      ? !currentEntry ||
        currentEntry.identity !== draft.identity ||
        currentEntry.revision !== draft.revision
      : catalog?.owners.find((o) => ownerKey(o.owner) === ownerKey(draft.owner))
          ?.revision !== draft.revision),
  );
  async function perform(operation: () => Promise<void>) {
    if (busy.current) return false;
    busy.current = true;
    setWorking(true);
    const lifecycle = generation.current;
    setError(false);
    try {
      await operation();
      return lifecycle === generation.current;
    } catch {
      if (lifecycle === generation.current) {
        setError(true);
        await variables.refresh().catch(() => undefined);
      }
      return false;
    } finally {
      busy.current = false;
      if (lifecycle === generation.current) setWorking(false);
    }
  }
  return {
    ...variables,
    pending: working || variables.pending,
    draft,
    removing,
    error,
    reviewed,
    currentEntry,
    collision,
    stale,
    canSave: Boolean(
      draft &&
      canSaveVariableDraft(draft) &&
      !collision &&
      !stale &&
      !variables.loadError,
    ),
    begin(entry?: AppVariableEntry, override = false) {
      if (busy.current || !catalog) return;
      setDraft(
        entry && !override
          ? editVariableDraft(entry)
          : createVariableDraft(entry?.name, catalog),
      );
      setError(false);
      setReviewed(false);
    },
    updateDraft(next: VariableDraft) {
      if (!busy.current) {
        setDraft(next);
        setError(false);
      }
    },
    cancel() {
      if (!busy.current) {
        setDraft(null);
        setError(false);
      }
    },
    requestRemove(entry: AppVariableEntry | null) {
      if (!busy.current) setRemoving(entry);
    },
    async remove() {
      if (removing && (await perform(() => variables.remove(removing))))
        setRemoving(null);
    },
    async save() {
      if (
        draft &&
        !stale &&
        !collision &&
        canSaveVariableDraft(draft) &&
        (await perform(() => variables.save(variableDraftInput(draft))))
      )
        setDraft(null);
    },
    async reviewLatest() {
      if (!draft) return;
      const lifecycle = generation.current;
      await perform(async () => {
        const latest = await variables.refresh();
        if (lifecycle !== generation.current) return;
        const target = latest.owners.find(
          (o) => ownerKey(o.owner) === ownerKey(draft.owner),
        );
        const entry = latest.entries.find(
          (e) =>
            sameSource(e.source, { owner: draft.owner, name: draft.name }) &&
            (!draft.keep || e.mode === draft.keep),
        );
        if (
          !target?.revision ||
          (draft.editing && (!entry || entry.identity !== draft.identity)) ||
          (!draft.editing && entry)
        )
          throw new Error("Source changed");
        setDraft({ ...draft, revision: target.revision });
        setReviewed(true);
      });
    },
    async recover(owner: Parameters<typeof variables.recover>[0]) {
      await perform(() => variables.recover(owner));
    },
  };
}
