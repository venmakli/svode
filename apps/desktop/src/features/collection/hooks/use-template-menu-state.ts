import { useCallback, useEffect, useMemo, useState } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import type { TemplateInfo } from "../model";
import { handleError } from "../lib/errors";

export type TemplateMenuPane = "main" | "templateActions" | "newTemplate";

export function useTemplateMenuState({
  defaultSlug,
  onLoadTemplates,
  onReorderTemplates,
}: {
  defaultSlug: string | null;
  onLoadTemplates: () => Promise<TemplateInfo[]>;
  onReorderTemplates: (slugs: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<TemplateMenuPane>("main");
  const [loading, setLoading] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [orderedSlugs, setOrderedSlugs] = useState<string[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<TemplateInfo | null>(
    null,
  );

  const sortedTemplates = useMemo(() => {
    const bySlug = new Map(
      templates.map((template) => [template.slug, template]),
    );
    return orderedSlugs
      .map((slug) => bySlug.get(slug))
      .filter((template): template is TemplateInfo => Boolean(template));
  }, [orderedSlugs, templates]);

  const missingDefault = Boolean(
    templatesLoaded &&
      defaultSlug &&
      !templates.some((template) => template.slug === defaultSlug),
  );

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const next = await onLoadTemplates();
      setTemplates(next);
      setOrderedSlugs(next.map((template) => template.slug));
      setTemplatesLoaded(true);
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }, [onLoadTemplates]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadTemplates();
    });
    return () => {
      cancelled = true;
    };
  }, [loadTemplates, open]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setPane("main");
      setActiveTemplate(null);
    }
  }, []);

  const reorderTemplates = useCallback(
    async (activeSlug: string, overSlug: string) => {
      if (activeSlug === overSlug) return;
      const oldIndex = orderedSlugs.indexOf(activeSlug);
      const newIndex = orderedSlugs.indexOf(overSlug);
      if (oldIndex < 0 || newIndex < 0) return;

      const previous = orderedSlugs;
      const next = arrayMove(orderedSlugs, oldIndex, newIndex);
      setOrderedSlugs(next);
      try {
        await onReorderTemplates(next);
      } catch (error) {
        setOrderedSlugs(previous);
        handleError(error);
      }
    },
    [onReorderTemplates, orderedSlugs],
  );

  const runAndClose = useCallback(async (action: () => Promise<void>) => {
    await action();
    setOpen(false);
  }, []);

  const runAndReturnToMain = useCallback(
    async (action: () => Promise<void>) => {
      await action();
      await loadTemplates();
      setPane("main");
      setActiveTemplate(null);
    },
    [loadTemplates],
  );

  const openTemplateActions = useCallback((template: TemplateInfo) => {
    setActiveTemplate(template);
    setPane("templateActions");
  }, []);

  return {
    activeTemplate,
    handleOpenChange,
    loadTemplates,
    loading,
    missingDefault,
    open,
    openTemplateActions,
    orderedSlugs,
    pane,
    reorderTemplates,
    runAndClose,
    runAndReturnToMain,
    setPane,
    sortedTemplates,
  };
}
