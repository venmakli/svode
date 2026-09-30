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
import { toast } from "sonner";
import { normalizeSchema, type PageSchemaResult } from "@/features/properties";
import { getPageSchema } from "@/features/properties/api";
import { useSignalUserEdit } from "@/features/navigation";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { createPage, readPage } from "../page-api";
import {
  isPageTreeMetaField,
  usePageFieldSave,
  type SavePageFieldOptions,
} from "../field-save";
import { humanizeOwnerPath, isReadmeMissingError } from "../lib/readme-state";
import { applyPageTitleOutcome, type Page, type PageCover } from "../model";
import { pageNameConflictFromError } from "../model/page-name";
import { propertyFieldSavePolicy } from "../property-field-save";
import {
  usePageTitleOutcomeEffect,
  useRetargetPage,
} from "./use-page-navigation";
import { handleError } from "../lib/errors";
import { useReadmeWrites } from "./use-readme-writes";
import { useOptionalPageSurfaceSession } from "./page-surface-context";
import { usePageDetailRefresh } from "./use-page-detail-refresh";
import { usePageName } from "./use-page-name";

export type ReadmeStatus = "loading" | "ready" | "missing" | "error";

/**
 * What the detail file is to its owner: the README of a directory owner, which
 * can be created when it is missing, or the Page itself, which cannot.
 */
export type PageDetailTarget = "readme" | "page";

export interface PagePathHandoff {
  previousPath: string;
  path: string;
}

export interface PageDetailContextValue {
  page: Page | null;
  adoptPage: (page: Page) => void;
  adoptPath: (path: string) => void;
  setPage: React.Dispatch<React.SetStateAction<Page | null>>;
  schemaResult: PageSchemaResult | null;
  applySchema: (schemaResult: PageSchemaResult | null) => void;
  target: PageDetailTarget;
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
  updateTitle: (title: string) => Promise<void>;
  titleError: string | null;
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
  target?: PageDetailTarget;
  fallbackTitle?: string;
  fallbackIcon?: string | null;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  /** Closes the presentation whose Page file stopped existing. */
  onPageGone?: () => void;
}

export function PageDetailProvider({
  children,
  spacePath,
  projectPath = null,
  spaceId,
  readmePath,
  ownerPath,
  target = "readme",
  fallbackTitle,
  fallbackIcon = null,
  onOpenPath,
  onPageGone,
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
  const signalUserEdit = useSignalUserEdit();
  const pageSurface = useOptionalPageSurfaceSession();
  const pageName = usePageName({ pagePath: readmePath, page, spaceId });
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
  const {
    discard: discardFields,
    flush: flushMetadata,
    save: saveField,
  } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
    deferTitlePathAdoption: true,
    onSaved: (updated, context) => {
      signalUserEdit();
      if (isPageTreeMetaField(context.field)) {
        patchPageTreeMeta(
          spaceId,
          context.previousPage.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
        const reload =
          updated.path !== context.previousPage.path
            ? reloadTreePathParents(spaceId, [
                context.previousPage.path,
                updated.path,
              ])
            : reloadTreePathParent(spaceId, updated.path);
        void reload.catch(handleError);
      }
      if (context.field === "title") pageName.clearSavedConflict();
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

  const adoptPage = useCallback(
    (nextPage: Page) => {
      adoptedReadmePathRef.current = nextPage.path;
      setPathHandoff({
        previousPath: page?.path ?? readmePath,
        path: nextPage.path,
      });
      setPage(nextPage);
      setStatus("ready");
    },
    [page?.path, readmePath],
  );
  const adoptPath = useCallback(
    (path: string) => {
      const previousPath = page?.path ?? readmePath;
      adoptedReadmePathRef.current = path;
      setPathHandoff({ previousPath, path });
      setPage((current) => (current ? { ...current, path } : current));
      retargetPage(previousPath, path, spaceId);
    },
    [page?.path, readmePath, retargetPage, spaceId],
  );

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
      if (target === "readme" && isReadmeMissingError(nextError, readmePath)) {
        setStatus("missing");
      } else {
        setError(String(nextError));
        setStatus("error");
      }
    }
  }, [loadSchema, readmePath, spacePath, target]);

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
    signalUserEdit();
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
    signalUserEdit,
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
    rejects: (_field, writeError) =>
      pageNameConflictFromError(writeError) !== null,
  });
  const {
    createReadme: ensureReadme,
    updateField: writeField,
    flush,
    retry,
    discard: discardWrites,
    drafts,
    writeError: failedWrite,
  } = writes;
  const { markLocalWrite } = usePageDetailRefresh({
    spacePath,
    path: status === "ready" ? (page?.path ?? null) : null,
    readSource: (path) => readPage({ spacePath, path }),
    readSchema: (path) => getPageSchema({ spacePath, filePath: path }),
    localFields: () => drafts.keys(),
    applyPage: applyPageUpdate,
    applySchema: setSchemaResult,
    settled: () => pageSurface?.settled() ?? Promise.resolve(),
    onGone: () => {
      if (target === "page") {
        toast.error(m.editor_file_deleted());
        onPageGone?.();
        return;
      }
      // The directory owner stays; its README can be created again.
      reloadSequenceRef.current += 1;
      setPage(null);
      setSchemaResult(null);
      setStatus("missing");
    },
  });
  // The failure detail stays in the write session; the surface names it in
  // user terms like the rest of the Page save feedback.
  const writeError = failedWrite ? m.page_surface_save_error() : null;
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
      markLocalWrite(field);
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
    [markLocalWrite, pageSurface, retry, writeField],
  );
  const { acceptTitle, handleSaveError } = pageName;
  const updateTitle = useCallback(
    async (title: string) => {
      if (!acceptTitle(title)) return;
      try {
        await updateField("title", title, { flush: true });
      } catch (titleError) {
        if (!handleSaveError(titleError)) throw titleError;
      }
    },
    [acceptTitle, handleSaveError, updateField],
  );
  const currentPath = page?.path ?? readmePath;
  const discard = useCallback(async () => {
    discardWrites();
    await discardFields();
    const sequence = reloadSequenceRef.current;
    let nextPage: Page | null = null;
    try {
      nextPage = await readPage({ spacePath, path: currentPath });
    } catch (readError) {
      if (target === "page" || !isReadmeMissingError(readError, currentPath))
        throw readError;
    }
    if (sequence !== reloadSequenceRef.current) return;
    setPage(nextPage);
    setStatus(nextPage ? "ready" : "missing");
  }, [currentPath, discardFields, discardWrites, spacePath, target]);
  useEffect(
    () =>
      pageSurface?.registerPersistence("metadata", { flush, retry, discard }),
    [discard, flush, pageSurface, retry],
  );

  const value = useMemo<PageDetailContextValue>(
    () => ({
      page,
      setPage,
      adoptPage,
      adoptPath,
      writeError,
      retryWrites,
      metadataDrafts: drafts,
      schemaResult,
      applySchema: setSchemaResult,
      target,
      status,
      error,
      fallbackTitle: resolvedFallbackTitle,
      fallbackIcon,
      reload,
      createReadme,
      updateField,
      updateTitle,
      titleError: pageName.titleError,
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
      adoptPage,
      adoptPath,
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
      target,
      pageName.titleError,
      updateField,
      updateTitle,
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
