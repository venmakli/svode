import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import type { Entry } from "@/features/entry";
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
import {
  entryTemplateSlug,
  normalizeEntryPath,
} from "../lib/utils";
import {
  templateHeadPath,
  type EntryPeekTarget,
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
  openDocument,
}: {
  schema: CollectionSchema | null;
  setSchema: Dispatch<SetStateAction<CollectionSchema | null>>;
  setPeekTarget: Dispatch<SetStateAction<EntryPeekTarget | null>>;
  refreshEntries: () => void;
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  spaceId: string;
  openDocument: (path: string, spaceId: string) => void;
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
      entry,
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
    refreshEntries();
    await reloadTreeParent(spaceId, collectionPath);
    openDocument(created.path, spaceId);
  }

  async function editTemplate(template: TemplateInfo) {
    const path = templateHeadPath(collectionPath, template);
    const entry = await readTemplateEntry({ spacePath, path });
    setPeekTarget({
      entry,
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

  async function duplicateTemplateEntry(entryToDuplicate: Entry) {
    const slug = entryTemplateSlug(collectionPath, entryToDuplicate.path);
    const duplicatePath = normalizeEntryPath(entryToDuplicate.path);
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
