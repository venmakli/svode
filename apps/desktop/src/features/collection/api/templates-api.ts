import { invokeCommand as invoke } from "@/platform/native/invoke";
import { normalizeEntry, type Entry } from "@/features/entry";
import { readEntry } from "@/features/entry/entry-api";
import type { CollectionSchema } from "@/features/properties";
import {
  normalizeTemplateInfo,
  templateKindToCommand,
  type TemplateInfo,
  type TemplateKind,
} from "../model/templates";

export async function listTemplates({
  spacePath,
  collectionPath,
}: {
  spacePath: string;
  collectionPath: string;
}) {
  const templates = await invoke<TemplateInfo[]>("list_templates", {
    space: spacePath,
    collectionPath,
  });
  return templates.map(normalizeTemplateInfo);
}

export async function createTemplate({
  spacePath,
  collectionPath,
  title,
  kind,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  title: string;
  kind: TemplateKind;
  projectPath?: string | null;
}) {
  return invoke<string>("create_template", {
    space: spacePath,
    collectionPath,
    title,
    kind: templateKindToCommand(kind),
    projectPath: projectPath ?? null,
  });
}

export async function deleteTemplate({
  spacePath,
  collectionPath,
  templateSlug,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  templateSlug: string;
  projectPath?: string | null;
}) {
  return invoke("delete_template", {
    space: spacePath,
    collectionPath,
    templateSlug,
    projectPath: projectPath ?? null,
  });
}

export async function duplicateTemplate({
  spacePath,
  collectionPath,
  templateSlug,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  templateSlug: string;
  projectPath?: string | null;
}) {
  return invoke<string>("duplicate_template", {
    space: spacePath,
    collectionPath,
    templateSlug,
    projectPath: projectPath ?? null,
  });
}

export async function instantiateTemplate({
  spacePath,
  collectionPath,
  templateSlug,
  parentDir,
  initialTitle,
  forceFolder,
  contextualDefaults,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  templateSlug: string;
  parentDir: string;
  initialTitle?: string | null;
  forceFolder?: boolean;
  contextualDefaults?: Record<string, unknown> | null;
  projectPath?: string | null;
}) {
  return invoke<Entry>("instantiate_template", {
    space: spacePath,
    collectionPath,
    templateSlug,
    parentDir,
    initialTitle: initialTitle ?? null,
    forceFolder: Boolean(forceFolder),
    contextualDefaults: contextualDefaults ?? {},
    projectPath: projectPath ?? null,
  }).then(normalizeEntry);
}

export async function setDefaultTemplate({
  spacePath,
  collectionPath,
  templateSlug,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  templateSlug: string | null;
  projectPath?: string | null;
}) {
  return invoke<CollectionSchema>("set_default_template", {
    space: spacePath,
    collectionPath,
    templateSlug,
    projectPath: projectPath ?? null,
  });
}

export async function reorderTemplates({
  spacePath,
  collectionPath,
  newOrder,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  newOrder: string[];
  projectPath?: string | null;
}) {
  return invoke<CollectionSchema>("reorder_templates", {
    space: spacePath,
    collectionPath,
    newOrder,
    projectPath: projectPath ?? null,
  });
}

export function readTemplateEntry({
  spacePath,
  path,
}: {
  spacePath: string;
  path: string;
}) {
  return readEntry({ spacePath, path });
}
