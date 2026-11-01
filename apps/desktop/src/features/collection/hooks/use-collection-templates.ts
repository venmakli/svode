import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import { publishPageFilenameWarnings, type Page } from "@/features/page";
import type { CollectionSchema } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import {
  signalCreatedArtifact,
  useSignalUserEdit,
} from "@/features/navigation";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import {
  createTemplate as createTemplateApi,
  deleteTemplate,
  duplicateTemplate as duplicateTemplateApi,
  instantiateTemplate,
  listTemplates,
  readTemplateItem,
  reorderTemplates,
  setDefaultTemplate,
} from "../api";
import { itemTemplateSlug, normalizePagePath } from "../lib/utils";
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
  refreshItems,
  spacePath,
  projectPath,
  collectionPath,
  spaceId,
  openPage,
}: {
  schema: CollectionSchema | null;
  setSchema: Dispatch<SetStateAction<CollectionSchema | null>>;
  setPeekTarget: Dispatch<SetStateAction<PagePeekTarget | null>>;
  refreshItems: () => void;
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  spaceId: string;
  openPage: (path: string, spaceId: string) => void;
}) {
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);
  const signalUserEdit = useSignalUserEdit();

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
    const item = await readTemplateItem({ spacePath, path });
    setPeekTarget({
      page: item,
      nested: kind === "nestedCollection",
      template: {
        slug: itemTemplateSlug(collectionPath, item.path),
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
    refreshItems();
    signalUserEdit();
    await reloadTreeParent(spaceId, collectionPath);
    openPage(created.path, spaceId);
    signalCreatedArtifact(spaceId, created.path);
  }

  async function editTemplate(template: TemplateInfo) {
    const path = templateHeadPath(collectionPath, template);
    const item = await readTemplateItem({ spacePath, path });
    setPeekTarget({
      page: item,
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

  async function duplicateTemplateItem(itemToDuplicate: Page) {
    const slug = itemTemplateSlug(collectionPath, itemToDuplicate.path);
    const duplicatePath = normalizePagePath(itemToDuplicate.path);
    await duplicateTemplateForMenu({
      slug,
      title: itemToDuplicate.meta.title,
      icon: itemToDuplicate.meta.icon,
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
    duplicateTemplateItem,
  };
}
