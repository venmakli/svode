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
import { createEntry, readEntry } from "../entry-api";
import {
  isEntryTreeMetaField,
  useEntryFieldSave,
  type SaveEntryFieldOptions,
} from "../field-save";
import { humanizeOwnerPath, isReadmeMissingError } from "../lib/readme-state";
import { applyEntryTitleOutcome, type Entry, type EntryCover } from "../model";
import { propertyFieldSavePolicy } from "../property-field-save";
import {
  useEntryTitleOutcomeEffect,
  useRetargetEntryDocument,
} from "./use-entry-selection";
import { handleError } from "../lib/errors";
import { useOptionalPageSurfaceSession } from "./page-surface-context";

export type ReadmeStatus = "loading" | "ready" | "missing" | "error";

export interface EntryPathHandoff {
  previousPath: string;
  path: string;
}

export interface EntryDetailContextValue {
  entry: Entry | null;
  setEntry: React.Dispatch<React.SetStateAction<Entry | null>>;
  schemaResult: EntrySchemaResult | null;
  status: ReadmeStatus;
  error: string | null;
  fallbackTitle: string;
  fallbackIcon: string | null;
  reload: () => Promise<void>;
  createReadme: () => Promise<Entry>;
  updateField: (
    field: string,
    value: unknown,
    options?: SaveEntryFieldOptions,
  ) => Promise<void>;
  updateCover: (cover: EntryCover | null) => Promise<void>;
  spacePath: string;
  projectPath: string | null;
  spaceId: string;
  readmePath: string;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  pathHandoff: EntryPathHandoff | null;
}

const EntryDetailContext = createContext<EntryDetailContextValue | null>(null);

export interface EntryDetailProviderProps {
  children: ReactNode;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  readmePath: string;
  ownerPath: string;
  fallbackTitle?: string;
  fallbackIcon?: string | null;
  onOpenPath: (path: string, spaceId?: string | null) => void;
}

export function EntryDetailProvider({
  children,
  spacePath,
  projectPath = null,
  spaceId,
  readmePath,
  ownerPath,
  fallbackTitle,
  fallbackIcon = null,
  onOpenPath,
}: EntryDetailProviderProps) {
  const resolvedFallbackTitle =
    fallbackTitle?.trim() || humanizeOwnerPath(ownerPath);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );
  const [status, setStatus] = useState<ReadmeStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pathHandoff, setPathHandoff] = useState<EntryPathHandoff | null>(null);
  const reloadSequenceRef = useRef(0);
  const adoptedReadmePathRef = useRef<string | null>(null);
  const retargetDocument = useRetargetEntryDocument();
  const pageSurface = useOptionalPageSurfaceSession();
  const {
    patchEntryTreeMeta,
    reloadTreeParent,
    reloadTreePathParent,
    reloadTreePathParents,
  } = useSpaceTreeSync();
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (current: Entry) => Entry) => {
      setEntry((current) =>
        current?.path === entryPath ? update(current) : current,
      );
    },
    [],
  );
  const { flush: flushMetadata, save: saveField } = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
    deferTitlePathAdoption: true,
    onSaved: (updated, context) => {
      const pathChanged = updated.path !== context.previousEntry.path;
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          context.previousEntry.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
      }
      if (context.field === "title" && pathChanged) {
        void reloadTreePathParents(spaceId, [
          context.previousEntry.path,
          updated.path,
        ]).catch(handleError);
      }
    },
    recoverFromError: pageSurface
      ? (saveError, _context, retry) =>
          pageSurface.recoverWriteError(saveError, retry)
      : undefined,
  });

  useEffect(() => {
    if (!pageSurface) return;
    return pageSurface.registerPersistence("metadata", flushMetadata);
  }, [flushMetadata, pageSurface]);

  useEntryTitleOutcomeEffect({
    scopePath: spacePath,
    path: entry?.path ?? readmePath,
    onOutcome: (titleOutcome) => {
      setEntry((current) =>
        current ? applyEntryTitleOutcome(current, titleOutcome.entry) : current,
      );
      if (titleOutcome.previousPath === titleOutcome.entry.path) return;
      adoptedReadmePathRef.current = titleOutcome.entry.path;
      setPathHandoff({
        previousPath: titleOutcome.previousPath,
        path: titleOutcome.entry.path,
      });
      retargetDocument(
        titleOutcome.previousPath,
        titleOutcome.entry.path,
        spaceId,
      );
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
    if (adoptedReadmePathRef.current === readmePath) {
      adoptedReadmePathRef.current = null;
      return () => {
        reloadSequenceRef.current += 1;
      };
    }
    queueMicrotask(() => void reload());
    return () => {
      reloadSequenceRef.current += 1;
    };
  }, [readmePath, reload]);

  const createReadme = useCallback(async () => {
    try {
      const created = await createEntry({
        spacePath,
        parentPath: ownerPath === "." ? "" : ownerPath,
        title: resolvedFallbackTitle,
        asReadme: true,
        projectPath,
      });
      const nextEntry = created;
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
    resolvedFallbackTitle,
    reloadTreeParent,
    reloadTreePathParent,
    spaceId,
    spacePath,
  ]);

  const updateField = useCallback(
    async (
      field: string,
      value: unknown,
      options: SaveEntryFieldOptions = {},
    ) => {
      if (pageSurface?.readOnly) return;
      const target = entry ?? (await createReadme());
      const column = schemaResult?.schema.columns.find(
        (item) => item.name === field,
      );
      const save = async () => {
        await saveField(target, field, value, {
          flush: options.flush ?? !entry,
          policy:
            options.policy ??
            (column ? propertyFieldSavePolicy(column) : undefined),
        });
      };
      if (field === "title" && options.flush && pageSurface) {
        await pageSurface.runMutation(save);
        return;
      }
      await save();
    },
    [createReadme, entry, pageSurface, saveField, schemaResult],
  );

  const value = useMemo<EntryDetailContextValue>(
    () => ({
      entry,
      setEntry,
      schemaResult,
      status,
      error,
      fallbackTitle: resolvedFallbackTitle,
      fallbackIcon,
      reload,
      createReadme,
      updateField,
      updateCover: (cover) => updateField("cover", cover),
      spacePath,
      projectPath,
      spaceId,
      readmePath,
      onOpenPath,
      pathHandoff,
    }),
    [
      createReadme,
      entry,
      error,
      fallbackIcon,
      onOpenPath,
      pathHandoff,
      projectPath,
      readmePath,
      reload,
      resolvedFallbackTitle,
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
