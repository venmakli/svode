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
  const applyPageUpdate = useCallback(
    (pagePath: string, update: (current: Page) => Page) => {
      setPage((current) =>
        current?.path === pagePath ? update(current) : current,
      );
    },
    [],
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
    recoverFromError: pageSurface
      ? (saveError, _context, retry) =>
          pageSurface.recoverWriteError(saveError, retry)
      : undefined,
  });

  useEffect(() => {
    if (!pageSurface) return;
    return pageSurface.registerPersistence("metadata", flushMetadata);
  }, [flushMetadata, pageSurface]);

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
      retargetPage(
        titleOutcome.previousPath,
        titleOutcome.page.path,
        spaceId,
      );
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

  const createReadme = useCallback(async () => {
    try {
      const created = await createPage({
        spacePath,
        parentPath: ownerPath === "." ? "" : ownerPath,
        title: resolvedFallbackTitle,
        asReadme: true,
        projectPath,
      });
      const nextPage = created;
      const nextSchema = await loadSchema();
      setPage(nextPage);
      setSchemaResult(nextSchema);
      setError(null);
      setStatus("ready");
      await reloadTreePathParent(spaceId, readmePath);
      await reloadTreeParent(spaceId, ownerPath === "." ? "" : ownerPath);
      return nextPage;
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
      options: SavePageFieldOptions = {},
    ) => {
      if (pageSurface?.readOnly) return;
      const target = page ?? (await createReadme());
      const column = schemaResult?.schema.columns.find(
        (item) => item.name === field,
      );
      const save = async () => {
        await saveField(target, field, value, {
          flush: options.flush ?? !page,
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
    [createReadme, page, pageSurface, saveField, schemaResult],
  );

  const value = useMemo<PageDetailContextValue>(
    () => ({
      page,
      setPage,
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
