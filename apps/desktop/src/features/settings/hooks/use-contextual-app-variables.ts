import { useEffect, useRef, useState } from "react";
import type { AppVariablesContext, AppVariableReference } from "../model";
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
  mode: "value" | "binding";
  draft: VariableDraft;
  savedEntry?: string;
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
  const collision =
    editor && !editor.draft.editing && !editor.savedEntry
      ? entries.find((entry) => entry.name === editor.draft.name)
      : undefined;
  const entry = editor
    ? entries.find((item) => item.name === editor.draft.name)
    : undefined;
  const currentReference = references.find(
    (item) => item.referenceName === editor?.referenceName,
  );
  const stale = Boolean(
    editor &&
    (!currentReference ||
      (editor.mode === "value" &&
        editor.draft.editing &&
        (!entry || currentReference.entryName !== editor.entryName))),
  );

  function begin(
    reference: AppVariableReference,
    mode: ReferenceEditor["mode"],
  ) {
    if (busyRef.current) return;
    const entry = entries.find((item) => item.name === reference.entryName);
    setEditor({
      referenceName: reference.referenceName,
      entryName: reference.entryName,
      mode,
      draft: entry
        ? editVariableDraft(entry)
        : createVariableDraft(reference.referenceName),
    });
    setError(null);
    setSaved(false);
  }

  function cancel() {
    if (busyRef.current) return;
    setEditor(null);
    setError(null);
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
        (item) => item.referenceName === editor.referenceName,
      );
      const actualEntry = latest.entries.find(
        (item) => item.name === editor.draft.name,
      );
      if (
        !reference ||
        (editor.mode === "value" &&
          editor.draft.editing &&
          (!actualEntry ||
            reference.entryName !== editor.entryName ||
            actualEntry.kind !== entry?.kind ||
            actualEntry.hasValue !== entry?.hasValue))
      ) {
        setError("stale");
        return;
      }
      if (editor.mode === "value" && !savedEntry) {
        if (!editor.draft.editing && actualEntry) {
          setError("collision");
          return;
        }
        await variables.save(variableDraftInput(editor.draft));
        if (!current()) return;
        savedEntry = editor.draft.name;
        setEditor({ ...editor, savedEntry });
      }
      if (editor.mode === "binding" || !editor.draft.editing) {
        await variables.bind(
          editor.referenceName,
          savedEntry ?? editor.entryName,
        );
        if (!current()) return;
      }
      setEditor(null);
      setSaved(true);
      return true;
    } catch {
      if (current()) setError(savedEntry ? "partial" : "save");
    } finally {
      busyRef.current = false;
      if (current()) setPending(false);
    }
  }

  return {
    ...variables,
    references,
    editor,
    pending,
    error,
    saved,
    collision,
    entry,
    stale,
    begin,
    cancel,
    submit,
    updateDraft(draft: VariableDraft) {
      if (!editor || busyRef.current || editor.savedEntry) return;
      setEditor({ ...editor, draft });
      setError(null);
    },
    selectEntry(entryName: string) {
      if (!editor || busyRef.current) return;
      setEditor({ ...editor, entryName });
      setError(null);
    },
    useCollision() {
      if (!editor || !collision || busyRef.current) return;
      setEditor({ ...editor, mode: "binding", entryName: collision.name });
      setError(null);
    },
  };
}
