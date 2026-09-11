import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as m from "@/paraglide/messages.js";
import type { AssetsS3Config } from "@/features/space";
import {
  checkS3Bindings,
  getS3Bindings,
  listenAppVariablesChanged,
  type S3BindingState,
  type S3SecretBindings,
} from "../api";
import {
  canSaveVariableDraft,
  createVariableDraft,
  editVariableDraft,
  variableDraftInput,
  type VariableDraft,
} from "../model/app-variable-draft";
import {
  sameSource,
  ownerKey,
  type VariableSource,
} from "../model/app-variables";
import { useAppVariables } from "./use-app-variables";

export type S3TestState = "idle" | "testing" | "ok" | "fail";
type Role = keyof S3SecretBindings;
interface SecretEditor {
  role: Role;
  draft: VariableDraft;
}
const emptyBindings: S3SecretBindings = {
  accessKey: { owner: { scope: "project" }, name: "" },
  secretKey: { owner: { scope: "project" }, name: "" },
};

export function useStorageS3({
  open,
  projectPath,
  spaceId,
  target,
  enabled,
}: {
  open: boolean;
  projectPath: string;
  spaceId: string | null;
  target: AssetsS3Config;
  enabled: boolean;
}) {
  const scope = useMemo(
    () => ({ projectPath, spaceId }),
    [projectPath, spaceId],
  );
  const variables = useAppVariables(undefined, false, open, scope);
  const owner = JSON.stringify([open, projectPath, spaceId]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const generation = useRef(0);
  const checkGeneration = useRef(0);
  const busy = useRef(false);
  const [loadedOwner, setLoadedOwner] = useState<string | null>(null);
  const [bindings, setBindings] = useState<S3SecretBindings>(emptyBindings);
  const [saved, setSaved] = useState<S3BindingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<SecretEditor | null>(null);
  const [pending, setPending] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [testState, setTestState] = useState<S3TestState>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const refreshSavedRef = useRef<() => Promise<void>>(async () => {});
  const requestKey = JSON.stringify([owner, target, bindings]);
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  const invalidateCheck = useCallback(() => {
    checkGeneration.current += 1;
    setTestState("idle");
    setTestError(null);
  }, []);

  useEffect(invalidateCheck, [requestKey, variables.catalog, invalidateCheck]);

  useEffect(() => {
    const lifecycle = ++generation.current;
    let unlisten: (() => void) | undefined;
    let readVersion = 0;
    let initialized = false;
    const current = () =>
      generation.current === lifecycle && ownerRef.current === owner;
    setLoadedOwner(null);
    setSaved(null);
    setBindings(emptyBindings);
    setEditor(null);
    setEditorError(null);
    setPending(false);
    setLoadError(null);
    busy.current = false;
    if (!open || !projectPath) return;
    async function refresh() {
      const version = ++readVersion;
      try {
        const next = await getS3Bindings({ projectPath, spaceId });
        if (!current() || version !== readVersion) return;
        if (!initialized) {
          setBindings(next.bindings ?? emptyBindings);
          initialized = true;
        }
        setSaved(next);
        setLoadedOwner(owner);
        setLoadError(null);
      } catch (error) {
        if (current() && version === readVersion)
          setLoadError(errorText(error));
      }
    }
    refreshSavedRef.current = refresh;
    void refresh();
    void listenAppVariablesChanged(() => {
      if (!current()) return;
      invalidateCheck();
      void refresh();
    })
      .then((stop) => {
        if (current()) unlisten = stop;
        else stop();
      })
      .catch(() => {
        if (current()) setLoadError(m.toast_error());
      });
    return () => {
      refreshSavedRef.current = async () => {};
      generation.current += 1;
      checkGeneration.current += 1;
      unlisten?.();
    };
  }, [open, projectPath, spaceId, owner, invalidateCheck]);

  const entries = variables.catalog?.entries ?? [];
  const loaded = open && loadedOwner === owner && variables.catalog !== null;
  const available = (source: VariableSource) =>
    entries.some(
      (entry) =>
        sameSource(entry.source, source) &&
        entry.kind === "secret" &&
        entry.hasValue &&
        !entry.collision,
    );
  const pairAvailable =
    available(bindings.accessKey) && available(bindings.secretKey);
  const collision =
    editor &&
    !editor.draft.editing &&
    entries.some((entry) =>
      sameSource(entry.source, {
        owner: editor.draft.owner,
        name: editor.draft.name,
      }),
    );
  const editedEntry = editor
    ? entries.find(
        (entry) =>
          sameSource(entry.source, {
            owner: editor.draft.owner,
            name: editor.draft.name,
          }) &&
          (!editor.draft.keep || entry.mode === editor.draft.keep),
      )
    : undefined;
  const draftOwner = editor
    ? variables.catalog?.owners.find(
        (owner) => ownerKey(owner.owner) === ownerKey(editor.draft.owner),
      )
    : undefined;
  const stale =
    editor &&
    (editor.draft.editing
      ? editedEntry?.kind !== "secret" ||
        editedEntry.identity !== editor.draft.identity ||
        editedEntry.revision !== editor.draft.revision
      : draftOwner?.revision !== editor.draft.revision);
  const canSave =
    enabled &&
    loaded &&
    !loadError &&
    !variables.loadError &&
    !editor &&
    !pending &&
    !variables.pending &&
    pairAvailable &&
    Boolean(target.endpoint && target.bucket && target.region && target.prefix);
  const canTest = canSave && testState !== "testing";

  function begin(role: Role, editing: boolean) {
    if (
      busy.current ||
      variables.pending ||
      !loaded ||
      !enabled ||
      variables.loadError ||
      loadError
    )
      return;
    const entry = entries.find(
      (item) =>
        sameSource(item.source, bindings[role]) && item.kind === "secret",
    );
    if (editing && entry?.kind !== "secret") return;
    const draft =
      editing && entry
        ? editVariableDraft(entry)
        : {
            ...createVariableDraft(
              entry ? "" : bindings[role].name,
              variables.catalog ?? undefined,
            ),
            kind: "secret" as const,
          };
    setEditor({ role, draft });
    setEditorError(null);
  }
  function cancel() {
    if (busy.current) return false;
    setEditor(null);
    setEditorError(null);
    return true;
  }
  async function submit() {
    if (
      !editor ||
      busy.current ||
      variables.pending ||
      collision ||
      stale ||
      variables.loadError ||
      !canSaveVariableDraft(editor.draft)
    )
      return false;
    const lifecycle = generation.current;
    const current = () =>
      generation.current === lifecycle && ownerRef.current === owner;
    busy.current = true;
    setPending(true);
    setEditorError(null);
    invalidateCheck();
    try {
      await variables.save({
        ...variableDraftInput(editor.draft),
      });
      if (!current()) return false;
      setBindings((pair) => ({
        ...pair,
        [editor.role]: { owner: editor.draft.owner, name: editor.draft.name },
      }));
      setEditor(null);
      return true;
    } catch (error) {
      if (current()) setEditorError(errorText(error));
      return false;
    } finally {
      if (current()) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  async function test() {
    if (!canTest) return;
    const version = ++checkGeneration.current;
    const current = () =>
      version === checkGeneration.current &&
      requestKeyRef.current === requestKey;
    setTestState("testing");
    setTestError(null);
    try {
      await checkS3Bindings({ projectPath, spaceId, target, bindings });
      if (current()) setTestState("ok");
    } catch (error) {
      if (current()) {
        setTestState("fail");
        setTestError(errorText(error));
      }
    }
  }
  return {
    bindings,
    saved,
    loaded,
    loadError,
    variables,
    entries,
    editor,
    pending: pending || variables.pending,
    editorError,
    collision,
    stale,
    editedEntry,
    collisionAlternatives: editor
      ? entries.filter((entry) =>
          sameSource(entry.source, {
            owner: editor.draft.owner,
            name: editor.draft.name,
          }),
        )
      : [],
    testState,
    testError,
    canSave,
    canTest,
    begin,
    cancel,
    submit,
    test,
    invalidateCheck,
    async reviewLatest() {
      if (!editor || busy.current) return;
      const lifecycle = generation.current;
      const draft = editor.draft;
      busy.current = true;
      setPending(true);
      try {
        const latest = await variables.refresh();
        if (generation.current !== lifecycle) return;
        const entry = latest.entries.find(
          (item) =>
            sameSource(item.source, { owner: draft.owner, name: draft.name }) &&
            (!draft.keep || item.mode === draft.keep),
        );
        const owner = latest.owners.find(
          (owner) => ownerKey(owner.owner) === ownerKey(draft.owner),
        );
        if (
          !owner?.revision ||
          (draft.editing
            ? !entry ||
              entry.kind !== "secret" ||
              entry.identity !== draft.identity
            : Boolean(entry))
        )
          throw new Error(m.storage_s3_secret_changed());
        setEditor({
          ...editor,
          draft: {
            ...draft,
            revision: entry?.revision ?? owner.revision,
            preservesSecret: entry?.hasValue ?? false,
          },
        });
        setEditorError(null);
      } catch (error) {
        if (generation.current === lifecycle) setEditorError(errorText(error));
      } finally {
        if (generation.current === lifecycle) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    canSubmit: Boolean(
      editor &&
      !pending &&
      !variables.pending &&
      !collision &&
      !stale &&
      !variables.loadError &&
      canSaveVariableDraft(editor.draft),
    ),
    select(role: Role, source: VariableSource) {
      if (busy.current || editor || !enabled) return;
      invalidateCheck();
      setBindings((pair) => ({ ...pair, [role]: source }));
    },
    updateDraft(draft: VariableDraft) {
      if (!editor || busy.current) return;
      setEditor({ ...editor, draft: { ...draft, kind: "secret" } });
      setEditorError(null);
    },
    retry() {
      void refreshSavedRef.current();
      void variables.refresh().catch(() => undefined);
    },
  };
}

function errorText(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : m.toast_error();
}
