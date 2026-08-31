import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import { publishPageFilenameWarnings, type Page } from "@/features/page";
import type { CollectionSchema } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import {
  createTemplate as createTemplateApi,
  deleteTemplate,
  duplicateTemplate as duplicateTemplateApi,
  instantiateTemplate,
  listTemplates,
  readTemplateEntry,
  reorderTemplates,
  setDefaultTemplate,
} from "../api";
import { entryTemplateSlug, normalizePagePath } from "../lib/utils";
import {
  templateHeadPath,
  type PagePeekTarget,
  type TemplateInfo,
  type TemplateKind,
} from "../model";

export function useCollectionTemplates({
  schema,
  setSchema,
  setPeekTarget,
  refreshEntries,
  spacePath,
  projectPath,
  collectionPath,
  spaceId,
  openPage,
}: {
  schema: CollectionSchema | null;
  setSchema: Dispatch<SetStateAction<CollectionSchema | null>>;
  setPeekTarget: Dispatch<SetStateAction<PagePeekTarget | null>>;
  refreshEntries: () => void;
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  spaceId: string;
  openPage: (path: string, spaceId: string) => void;
}) {
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);

  async function loadTemplatesForMenu() {
    return listTemplates({ spacePath, collectionPath });
  }

  async function createTemplateForMenu(kind: TemplateKind) {
    const path = await createTemplateApi({
      spacePath,
      collectionPath,
      title: m.collection_new_template(),
      kind,
      projectPath,
    });
    const entry = await readTemplateEntry({ spacePath, path });
    setPeekTarget({
      page: entry,
      nested: kind === "nestedCollection",
      template: {
        slug: entryTemplateSlug(collectionPath, entry.path),
        collectionPath,
        isDefault: false,
      },
    });
  }

  async function instantiateTemplateForMenu(
    template: TemplateInfo,
    forceFolder: boolean,
  ) {
    const created = await instantiateTemplate({
      spacePath,
      collectionPath,
      templateSlug: template.slug,
      parentDir: collectionPath,
      initialTitle: null,
      forceFolder,
      contextualDefaults: null,
      projectPath,
    });
    publishPageFilenameWarnings(created.warnings);
    refreshEntries();
    await reloadTreeParent(spaceId, collectionPath);
    openPage(created.path, spaceId);
  }

  async function editTemplate(template: TemplateInfo) {
    const path = templateHeadPath(collectionPath, template);
    const entry = await readTemplateEntry({ spacePath, path });
    setPeekTarget({
      page: entry,
      nested: template.kind === "nestedCollection",
      template: {
        slug: template.slug,
        collectionPath,
        isDefault: Boolean(template.isDefault ?? template.is_default),
      },
    });
  }

  async function setDefaultTemplateForMenu(slug: string | null) {
    const next = await setDefaultTemplate({
      spacePath,
      collectionPath,
      templateSlug: slug,
      projectPath,
    });
    setSchema(normalizeSchema(next));
    setPeekTarget((current) =>
      current?.template
        ? {
            ...current,
            template: {
              ...current.template,
              isDefault: slug === current.template.slug,
            },
          }
        : current,
    );
  }

  async function duplicateTemplateForMenu(template: TemplateInfo) {
    await duplicateTemplateApi({
      spacePath,
      collectionPath,
      templateSlug: template.slug,
      projectPath,
    });
  }

  async function deleteTemplateForMenu(template: TemplateInfo) {
    await deleteTemplate({
      spacePath,
      collectionPath,
      templateSlug: template.slug,
      projectPath,
    });
    if (schema?.templates?.default === template.slug) {
      toast.warning(m.collection_default_template_missing());
    }
  }

  async function reorderTemplatesForMenu(slugs: string[]) {
    const next = await reorderTemplates({
      spacePath,
      collectionPath,
      newOrder: slugs,
      projectPath,
    });
    setSchema(normalizeSchema(next));
  }

  async function duplicateTemplateEntry(entryToDuplicate: Page) {
    const slug = entryTemplateSlug(collectionPath, entryToDuplicate.path);
    const duplicatePath = normalizePagePath(entryToDuplicate.path);
    await duplicateTemplateForMenu({
      slug,
      title: entryToDuplicate.meta.title,
      icon: entryToDuplicate.meta.icon,
      kind: duplicatePath.toLowerCase().includes("/schema.yaml")
        ? "nestedCollection"
        : duplicatePath.toLowerCase().endsWith("/readme.md")
          ? "folder"
          : "leaf",
    });
  }

  return {
    loadTemplatesForMenu,
    createTemplateForMenu,
    instantiateTemplateForMenu,
    editTemplate,
    setDefaultTemplateForMenu,
    duplicateTemplateForMenu,
    deleteTemplateForMenu,
    reorderTemplatesForMenu,
    duplicateTemplateEntry,
  };
}
