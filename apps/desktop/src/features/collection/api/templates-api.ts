import {
  createTemplate as createTemplateDto,
  deleteTemplate as deleteTemplateDto,
  duplicateTemplate as duplicateTemplateDto,
  instantiateTemplate as instantiateTemplateDto,
  listTemplates as listTemplatesDto,
  reorderTemplates as reorderTemplatesDto,
  setDefaultTemplate as setDefaultTemplateDto,
} from "@/platform/collections/collections-api";
import { normalizeEntry } from "@/features/entry";
import { readEntry } from "@/features/entry/entry-api";
import { normalizeSchema } from "@/features/properties";
import {
  normalizeTemplateInfo,
  templateKindToCommand,
  type TemplateKind,
} from "../model/templates";

export async function listTemplates({
  spacePath,
  collectionPath,
}: {
  spacePath: string;
  collectionPath: string;
}) {
  const templates = await listTemplatesDto({ spacePath, collectionPath });
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
  return createTemplateDto({
    spacePath,
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
  return deleteTemplateDto({
    spacePath,
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
  return duplicateTemplateDto({
    spacePath,
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
  return instantiateTemplateDto({
    spacePath,
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
  return setDefaultTemplateDto({
    spacePath,
    collectionPath,
    templateSlug,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
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
  return reorderTemplatesDto({
    spacePath,
    collectionPath,
    newOrder,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
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
