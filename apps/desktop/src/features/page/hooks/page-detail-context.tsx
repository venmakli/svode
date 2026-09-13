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
import { normalizeSchema, type PageSchemaResult } from "@/features/properties";
import { getPageSchema } from "@/features/properties/api";
import { useSpaceTreeSync } from "@/features/space";
import { createPage, readPage } from "../page-api";
import {
  isPageTreeMetaField,
  usePageFieldSave,
  type SavePageFieldOptions,
} from "../field-save";
import { humanizeOwnerPath, isReadmeMissingError } from "../lib/readme-state";
import { applyPageTitleOutcome, type Page, type PageCover } from "../model";
import { propertyFieldSavePolicy } from "../property-field-save";
import {
  usePageTitleOutcomeEffect,
  useRetargetPage,
} from "./use-page-navigation";
import { handleError } from "../lib/errors";
import { useReadmeWrites } from "./use-readme-writes";
import { useOptionalPageSurfaceSession } from "./page-surface-context";

export type ReadmeStatus = "loading" | "ready" | "missing" | "error";

export interface PagePathHandoff {
  previousPath: string;
  path: string;
}

export interface PageDetailContextValue {
  page: Page | null;
  setPage: React.Dispatch<React.SetStateAction<Page | null>>;
  schemaResult: PageSchemaResult | null;
  status: ReadmeStatus;
  error: string | null;
  writeError: string | null;
  retryWrites: () => Promise<void>;
  metadataDrafts: ReadonlyMap<string, { value: unknown }>;
  fallbackTitle: string;
  fallbackIcon: string | null;
  reload: () => Promise<void>;
  createReadme: () => Promise<Page>;
  updateField: (
    field: string,
    value: unknown,
    options?: SavePageFieldOptions,
  ) => Promise<void>;
  updateCover: (cover: PageCover | null) => Promise<void>;
  spacePath: string;
  projectPath: string | null;
  spaceId: string;
  readmePath: string;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  pathHandoff: PagePathHandoff | null;
}

const PageDetailContext = createContext<PageDetailContextValue | null>(null);

export interface PageDetailProviderProps {
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

export function PageDetailProvider({
  children,
  spacePath,
  projectPath = null,
  spaceId,
  readmePath,
  ownerPath,
  fallbackTitle,
  fallbackIcon = null,
  onOpenPath,
}: PageDetailProviderProps) {
  const resolvedFallbackTitle =
    fallbackTitle?.trim() || humanizeOwnerPath(ownerPath);
  const [page, setPage] = useState<Page | null>(null);
  const [schemaResult, setSchemaResult] = useState<PageSchemaResult | null>(
    null,
  );
  const [status, setStatus] = useState<ReadmeStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pathHandoff, setPathHandoff] = useState<PagePathHandoff | null>(null);
  const reloadSequenceRef = useRef(0);
  const adoptedReadmePathRef = useRef<string | null>(null);
  const retargetPage = useRetargetPage();
  const pageSurface = useOptionalPageSurfaceSession();
  const {
    patchPageTreeMeta,
    reloadTreeParent,
    reloadTreePathParent,
    reloadTreePathParents,
  } = useSpaceTreeSync();
  const activeSpaceRef = useRef(spacePath);
  useEffect(() => {
    activeSpaceRef.current = spacePath;
  }, [spacePath]);
  const applyPageUpdate = useCallback(
    (pagePath: string, update: (current: Page) => Page) => {
      if (activeSpaceRef.current !== spacePath) return;
      setPage((current) =>
        current?.path === pagePath ? update(current) : current,
      );
    },
    [spacePath],
  );
  const { flush: flushMetadata, save: saveField } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
    deferTitlePathAdoption: true,
    onSaved: (updated, context) => {
      const pathChanged = updated.path !== context.previousPage.path;
      if (isPageTreeMetaField(context.field)) {
        patchPageTreeMeta(
          spaceId,
          context.previousPage.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
      }
      if (context.field === "title" && pathChanged) {
        void reloadTreePathParents(spaceId, [
          context.previousPage.path,
          updated.path,
        ]).catch(handleError);
      }
    },
  });

  usePageTitleOutcomeEffect({
    scopePath: spacePath,
    path: page?.path ?? readmePath,
    onOutcome: (titleOutcome) => {
      setPage((current) =>
        current ? applyPageTitleOutcome(current, titleOutcome.page) : current,
      );
      if (titleOutcome.previousPath === titleOutcome.page.path) return;
      adoptedReadmePathRef.current = titleOutcome.page.path;
      setPathHandoff({
        previousPath: titleOutcome.previousPath,
        path: titleOutcome.page.path,
      });
      retargetPage(titleOutcome.previousPath, titleOutcome.page.path, spaceId);
    },
  });

  const loadSchema = useCallback(async () => {
    const nextSchema = await getPageSchema({
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
    setPage(null);
    setSchemaResult(null);
    setStatus("loading");
    setError(null);
    try {
      const nextPage = await readPage({ spacePath, path: readmePath });
      const nextSchema = await loadSchema();
      if (sequence !== reloadSequenceRef.current) return;
      setPage(nextPage);
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

  const create = useCallback(async () => {
    const sequence = reloadSequenceRef.current;
    let nextPage: Page;
    try {
      nextPage = await readPage({ spacePath, path: readmePath });
    } catch (readError) {
      if (!isReadmeMissingError(readError, readmePath)) throw readError;
      try {
        nextPage = await createPage({
          spacePath,
          parentPath: ownerPath === "." ? "" : ownerPath,
          title: resolvedFallbackTitle,
          asReadme: true,
          projectPath,
        });
      } catch (createError) {
        // Another writer or a partially successful create may have made the head.
        nextPage = await readPage({ spacePath, path: readmePath }).catch(() => {
          throw createError;
        });
      }
    }
    if (sequence !== reloadSequenceRef.current)
      throw new Error("Page target changed");
    setPage(nextPage);
    setError(null);
    setStatus("ready");
    void loadSchema().then((nextSchema) => {
      if (sequence === reloadSequenceRef.current) setSchemaResult(nextSchema);
    });
    void reloadTreePathParent(spaceId, readmePath).catch(handleError);
    void reloadTreeParent(spaceId, ownerPath === "." ? "" : ownerPath).catch(
      handleError,
    );
    return nextPage;
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

  const save = useCallback(
    async (
      target: Page,
      field: string,
      fieldValue: unknown,
      options: SavePageFieldOptions,
    ) => {
      const column = schemaResult?.schema.columns.find(
        (item) => item.name === field,
      );
      await saveField(target, field, fieldValue, {
        ...options,
        policy:
          options.policy ??
          (column ? propertyFieldSavePolicy(column) : undefined),
      });
    },
    [saveField, schemaResult],
  );
  const writes = useReadmeWrites({
    targetKey: `${spacePath}:${readmePath}`,
    page,
    canWrite:
      !pageSurface?.readOnly && (status === "missing" || status === "ready"),
    create,
    save,
    flushFields: flushMetadata,
  });
  const {
    createReadme: ensureReadme,
    updateField: writeField,
    flush,
    retry,
    drafts,
    writeError,
  } = writes;
  const createReadme = useCallback(async () => {
    try {
      return await ensureReadme();
    } catch (writeError) {
      await pageSurface?.recoverWriteError(writeError, retry);
      throw writeError;
    }
  }, [ensureReadme, pageSurface, retry]);
  const retryWrites = useCallback(async () => {
    try {
      await retry();
    } catch (writeError) {
      await pageSurface?.recoverWriteError(writeError, retry);
      throw writeError;
    }
  }, [pageSurface, retry]);
  const updateField = useCallback(
    async (
      field: string,
      fieldValue: unknown,
      options: SavePageFieldOptions = {},
    ) => {
      if (field === "title" && options.flush && pageSurface) {
        await pageSurface.runMutation(() =>
          writeField(field, fieldValue, options),
        );
      } else {
        try {
          await writeField(field, fieldValue, options);
        } catch (writeError) {
          await pageSurface?.recoverWriteError(writeError, retry);
          throw writeError;
        }
      }
    },
    [pageSurface, retry, writeField],
  );
  useEffect(
    () => pageSurface?.registerPersistence("metadata", flush, retry),
    [flush, pageSurface, retry],
  );

  const value = useMemo<PageDetailContextValue>(
    () => ({
      page,
      setPage,
      writeError,
      retryWrites,
      metadataDrafts: drafts,
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
      page,
      drafts,
      retryWrites,
      writeError,
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
    <PageDetailContext.Provider value={value}>
      {children}
    </PageDetailContext.Provider>
  );
}

export function usePageDetailContext() {
  const context = useContext(PageDetailContext);
  if (!context) {
    throw new Error("Page detail components require PageDetailProvider");
  }
  return context;
}

export function useOptionalPageDetailContext() {
  return useContext(PageDetailContext);
}
