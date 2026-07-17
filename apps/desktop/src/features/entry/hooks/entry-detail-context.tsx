import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { normalizeSchema, type EntrySchemaResult } from "@/features/properties";
import { getEntrySchema } from "@/features/properties/api";
import { useSpaceTreeSync } from "@/features/space";
import { createEntry, readEntry, renameEntry } from "../entry-api";
import { isEntryTreeMetaField, useEntryFieldSave } from "../field-save";
import { humanizeOwnerPath, isReadmeMissingError } from "../lib/readme-state";
import type { Entry, EntryCover } from "../model";
import { propertyFieldSavePolicy } from "../property-field-save";

export type ReadmeStatus = "loading" | "ready" | "missing" | "error";

export interface EntryDetailContextValue {
  entry: Entry | null;
  setEntry: React.Dispatch<React.SetStateAction<Entry | null>>;
  schemaResult: EntrySchemaResult | null;
  status: ReadmeStatus;
  error: string | null;
  fallbackTitle: string;
  reload: () => Promise<void>;
  createReadme: () => Promise<Entry>;
  updateField: (field: string, value: unknown) => Promise<void>;
  updateCover: (cover: EntryCover | null) => Promise<void>;
  spacePath: string;
  projectPath: string | null;
  spaceId: string;
  readmePath: string;
  onOpenPath: (path: string, spaceId?: string | null) => void;
}

const EntryDetailContext = createContext<EntryDetailContextValue | null>(null);

export interface EntryDetailProviderProps {
  children: ReactNode;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  readmePath: string;
  ownerPath: string;
  onOpenPath: (path: string, spaceId?: string | null) => void;
}

export function EntryDetailProvider({
  children,
  spacePath,
  projectPath = null,
  spaceId,
  readmePath,
  ownerPath,
  onOpenPath,
}: EntryDetailProviderProps) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );
  const [status, setStatus] = useState<ReadmeStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const reloadSequenceRef = useRef(0);
  const { patchEntryTreeMeta, reloadTreeParent, reloadTreePathParent } =
    useSpaceTreeSync();
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (current: Entry) => Entry) => {
      setEntry((current) =>
        current?.path === entryPath ? update(current) : current,
      );
    },
    [],
  );
  const saveField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
    onSaved: (updated, context) => {
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          updated.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
      }
    },
  });

  const loadSchema = useCallback(async () => {
    const nextSchema = await getEntrySchema({
      spacePath,
      filePath: readmePath,
    }).catch(() => null);
    return nextSchema
      ? { ...nextSchema, schema: normalizeSchema(nextSchema.schema) }
      : null;
  }, [readmePath, spacePath]);

  const reload = useCallback(async () => {
    const sequence = reloadSequenceRef.current + 1;
    reloadSequenceRef.current = sequence;
    setEntry(null);
    setSchemaResult(null);
    setStatus("loading");
    setError(null);
    try {
      const nextEntry = await readEntry({ spacePath, path: readmePath });
      const nextSchema = await loadSchema();
      if (sequence !== reloadSequenceRef.current) return;
      setEntry(nextEntry);
      setSchemaResult(nextSchema);
      setStatus("ready");
    } catch (nextError) {
      if (sequence !== reloadSequenceRef.current) return;
      if (isReadmeMissingError(nextError, readmePath)) {
        setStatus("missing");
      } else {
        setError(String(nextError));
        setStatus("error");
      }
    }
  }, [loadSchema, readmePath, spacePath]);

  useEffect(() => {
    queueMicrotask(() => void reload());
    return () => {
      reloadSequenceRef.current += 1;
    };
  }, [reload]);

  const createReadme = useCallback(async () => {
    try {
      const created = await createEntry({
        spacePath,
        parentPath: ownerPath === "." ? "" : ownerPath,
        title: humanizeOwnerPath(ownerPath),
        projectPath,
      });
      let nextEntry = created;
      if (created.path.toLowerCase() !== readmePath.toLowerCase()) {
        await renameEntry({
          spacePath,
          from: created.path,
          to: readmePath,
          projectPath,
        });
        nextEntry = await readEntry({ spacePath, path: readmePath });
      }
      const nextSchema = await loadSchema();
      setEntry(nextEntry);
      setSchemaResult(nextSchema);
      setError(null);
      setStatus("ready");
      await reloadTreePathParent(spaceId, readmePath);
      await reloadTreeParent(spaceId, ownerPath === "." ? "" : ownerPath);
      return nextEntry;
    } catch (createError) {
      setError(String(createError));
      setStatus("error");
      throw createError;
    }
  }, [
    loadSchema,
    ownerPath,
    projectPath,
    readmePath,
    reloadTreeParent,
    reloadTreePathParent,
    spaceId,
    spacePath,
  ]);

  const updateField = useCallback(
    async (field: string, value: unknown) => {
      const target = entry ?? (await createReadme());
      const column = schemaResult?.schema.columns.find(
        (item) => item.name === field,
      );
      await saveField(target, field, value, {
        flush: !entry,
        policy: column ? propertyFieldSavePolicy(column) : undefined,
      });
    },
    [createReadme, entry, saveField, schemaResult],
  );

  const value = useMemo<EntryDetailContextValue>(
    () => ({
      entry,
      setEntry,
      schemaResult,
      status,
      error,
      fallbackTitle: humanizeOwnerPath(ownerPath),
      reload,
      createReadme,
      updateField,
      updateCover: (cover) => updateField("cover", cover),
      spacePath,
      projectPath,
      spaceId,
      readmePath,
      onOpenPath,
    }),
    [
      createReadme,
      entry,
      error,
      onOpenPath,
      ownerPath,
      projectPath,
      readmePath,
      reload,
      schemaResult,
      spaceId,
      spacePath,
      status,
      updateField,
    ],
  );

  return (
    <EntryDetailContext.Provider value={value}>
      {children}
    </EntryDetailContext.Provider>
  );
}

export function useEntryDetailContext() {
  const context = useContext(EntryDetailContext);
  if (!context) {
    throw new Error("Entry detail components require EntryDetailProvider");
  }
  return context;
}

export function useOptionalEntryDetailContext() {
  return useContext(EntryDetailContext);
}
