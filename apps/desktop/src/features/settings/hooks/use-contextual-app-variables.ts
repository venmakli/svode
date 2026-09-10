import { useEffect, useRef, useState } from "react";
import {
  sameSource,
  sourceKey,
  ownerKey,
  type AppVariablesContext,
  type AppVariableReference,
  type VariableSource,
} from "../model/app-variables";
import {
  canSaveVariableDraft,
  createVariableDraft,
  editVariableDraft,
  variableDraftInput,
  type VariableDraft,
} from "../model/app-variable-draft";
import { useAppVariables } from "./use-app-variables";
interface ReferenceEditor {
  referenceName: string;
  entryName: string;
  originalSource: VariableSource;
  bindingRevision: string;
  mode: "value" | "binding";
  draft: VariableDraft;
  savedEntry?: VariableSource;
}
type EditorError = "save" | "partial" | "stale" | "collision" | null;
export function useContextualAppVariables(context: AppVariablesContext) {
  const variables = useAppVariables(context, false);
  const [editor, setEditor] = useState<ReferenceEditor | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<EditorError>(null);
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);
  const lifecycleRef = useRef(0);
  useEffect(
    () => () => {
      lifecycleRef.current += 1;
    },
    [],
  );
  const entries = variables.catalog?.entries ?? [];
  const references = [...(variables.catalog?.context ?? [])].sort(
    (a, b) =>
      Number(a.resolved) - Number(b.resolved) ||
      a.referenceName.localeCompare(b.referenceName),
  );
  const entry = editor
    ? entries.find(
        (item) =>
          sameSource(item.source, {
            owner: editor.draft.owner,
            name: editor.draft.name,
          }) &&
          (!editor.draft.keep || item.mode === editor.draft.keep),
      )
    : undefined;
  const collision =
    editor && !editor.draft.editing && !editor.savedEntry ? entry : undefined;
  const currentReference = references.find(
    (item) => item.referenceName === editor?.referenceName,
  );
  const stale = Boolean(
    editor &&
    (!currentReference ||
      editor.bindingRevision !== variables.catalog?.bindingRevision ||
      (editor.mode === "value" &&
        !editor.savedEntry &&
        (editor.draft.editing
          ? !entry ||
            entry.identity !== editor.draft.identity ||
            entry.revision !== editor.draft.revision ||
            !sameSource(currentReference.source, editor.originalSource)
          : variables.catalog?.owners.find(
              (o) => ownerKey(o.owner) === ownerKey(editor.draft.owner),
            )?.revision !== editor.draft.revision))),
  );
  function begin(
    reference: AppVariableReference,
    mode: ReferenceEditor["mode"],
    override = false,
  ) {
    if (busyRef.current || !variables.catalog) return;
    const entry = !override
      ? entries.find((e) => sameSource(e.source, reference.source))
      : undefined;
    setEditor({
      referenceName: reference.referenceName,
      entryName: sourceKey(reference.source),
      originalSource: reference.source,
      bindingRevision: variables.catalog.bindingRevision,
      mode,
      draft: entry
        ? editVariableDraft(entry)
        : createVariableDraft(reference.referenceName, variables.catalog),
    });
    setError(null);
    setSaved(false);
  }
  function cancel() {
    if (!busyRef.current) {
      setEditor(null);
      setError(null);
    }
  }
  async function submit() {
    if (!editor || busyRef.current || stale || variables.loadError) return;
    if (
      editor.mode === "value" &&
      !editor.savedEntry &&
      (!canSaveVariableDraft(editor.draft) || collision)
    )
      return;
    const lifecycle = lifecycleRef.current;
    const current = () => lifecycle === lifecycleRef.current;
    busyRef.current = true;
    setPending(true);
    setError(null);
    setSaved(false);
    let savedEntry = editor.savedEntry;
    try {
      const latest = await variables.refresh();
      if (!current()) return;
      const reference = latest.context?.find(
        (r) => r.referenceName === editor.referenceName,
      );
      if (
        !reference ||
        latest.bindingRevision !== editor.bindingRevision ||
        (!sameSource(reference.source, editor.originalSource) &&
          editor.draft.editing)
      ) {
        setError("stale");
        return;
      }
      if (editor.mode === "value" && !savedEntry) {
        if (
          !editor.draft.editing &&
          latest.entries.some((e) =>
            sameSource(e.source, {
              owner: editor.draft.owner,
              name: editor.draft.name,
            }),
          )
        ) {
          setError("collision");
          return;
        }
        await variables.save(variableDraftInput(editor.draft));
        if (!current()) return;
        savedEntry = { owner: editor.draft.owner, name: editor.draft.name };
        setEditor({ ...editor, savedEntry });
      }
      if (editor.mode === "binding" || !editor.draft.editing) {
        const source =
          savedEntry ??
          entries.find((e) => sourceKey(e.source) === editor.entryName)
            ?.source ??
          null;
        if (!source && editor.entryName !== "inherit")
          throw new Error("Source missing");
        await variables.bind(
          editor.referenceName,
          source,
          editor.bindingRevision,
        );
        if (!current()) return;
      }
      setEditor(null);
      setSaved(true);
      return true;
    } catch {
      if (current()) {
        setError(savedEntry ? "partial" : "save");
        await variables.refresh().catch(() => undefined);
      }
    } finally {
      busyRef.current = false;
      if (current()) setPending(false);
    }
  }
  return {
    ...variables,
    references,
    editor,
    pending: pending || variables.pending,
    error,
    saved,
    collision,
    entry,
    stale,
    begin,
    cancel,
    submit,
    async reviewLatest() {
      if (!editor || busyRef.current) return;
      const lifecycle = lifecycleRef.current;
      busyRef.current = true;
      setPending(true);
      try {
        const latest = await variables.refresh();
        if (lifecycle !== lifecycleRef.current) return;
        const reference = latest.context?.find(
          (r) => r.referenceName === editor.referenceName,
        );
        const target = latest.owners.find(
          (o) => ownerKey(o.owner) === ownerKey(editor.draft.owner),
        );
        const entry = latest.entries.find(
          (e) =>
            sameSource(e.source, {
              owner: editor.draft.owner,
              name: editor.draft.name,
            }) &&
            (!editor.draft.keep || e.mode === editor.draft.keep),
        );
        if (
          !reference ||
          !target?.revision ||
          (editor.draft.editing &&
            (!entry ||
              entry.identity !== editor.draft.identity ||
              !sameSource(reference.source, editor.originalSource)))
        ) {
          setError("stale");
          return;
        }
        setEditor({
          ...editor,
          bindingRevision: latest.bindingRevision,
          originalSource: reference.source,
          draft: { ...editor.draft, revision: target.revision },
        });
        setError(null);
      } catch {
        if (lifecycle === lifecycleRef.current) setError("save");
      } finally {
        busyRef.current = false;
        if (lifecycle === lifecycleRef.current) setPending(false);
      }
    },
    updateDraft(draft: VariableDraft) {
      if (editor && !busyRef.current && !editor.savedEntry) {
        setEditor({ ...editor, draft });
        setError(null);
      }
    },
    selectEntry(entryName: string) {
      if (editor && !busyRef.current) {
        setEditor({ ...editor, entryName });
        setError(null);
      }
    },
    useCollision() {
      if (editor && collision && !busyRef.current) {
        setEditor({
          ...editor,
          mode: "binding",
          entryName: sourceKey(collision.source),
        });
        setError(null);
      }
    },
  };
}
