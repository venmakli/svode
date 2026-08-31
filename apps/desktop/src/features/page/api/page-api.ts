import {
  createPage as createPageDto,
  convertPageToFolder as convertPageToFolderDto,
  convertPageToLeaf as convertPageToLeafDto,
  deletePage as deletePageDto,
  duplicatePage as duplicatePageDto,
  getPageDetailState as getPageDetailStateDto,
  type PageLinkValidationResultDto,
  readPage as readPageDto,
  renamePage as renamePageDto,
  updatePageField as updatePageFieldDto,
  validatePageLinks as validatePageLinksDto,
  writePage as writePageDto,
  type PageDto,
  type WritePageResultDto,
} from "@/platform/pages/pages-api";
import {
  readContentTreeOrder,
  saveContentTreeOrder,
} from "@/platform/space/content-tree-api";
import { convertToCollection as convertToCollectionDto } from "@/platform/collections/collections-api";
import { normalizePage } from "../model/normalize-page";
import type {
  Page,
  PageDetailState,
  PageLinkValidationResult,
  WritePageResult,
} from "../model/types";
import { normalizePagePath } from "../lib/path";

export interface ReadPageInput {
  spacePath: string;
  path: string;
}

export interface CreatePageInput {
  spacePath: string;
  parentPath: string | null;
  title: string;
  contextualDefaults?: Record<string, unknown> | null;
  allocateUniqueTitle?: boolean;
  asReadme?: boolean;
  projectPath?: string | null;
}

export interface RenamePageInput {
  spacePath: string;
  from: string;
  to: string;
  projectPath?: string | null;
}

export interface UpdatePageFieldInput {
  spacePath: string;
  filePath: string;
  field: string;
  value: unknown;
  projectPath: string | null;
}

export interface WritePageInput {
  spacePath: string;
  path: string;
  content: string;
  skipRename: boolean;
  projectPath: string | null;
}

export interface ValidatePageLinksInput {
  spacePath: string;
  path: string;
  projectPath: string | null;
}

export interface DeletePageInput {
  spacePath: string;
  path: string;
  projectPath?: string | null;
}

export interface DuplicatePageInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface ConvertPageToFolderInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface ConvertPageToLeafInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface ConvertPageToNestedCollectionInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface GetPageDetailStateInput {
  spacePath: string;
  path: string;
}

export interface SavePageTreeOrderInput {
  spacePath: string;
  orderKey: string;
  pages: Page[];
  projectPath?: string | null;
}

export interface SavePageTreeOrderNamesInput {
  spacePath: string;
  orderKey: string;
  names: string[];
  projectPath?: string | null;
}

export async function readPage(input: ReadPageInput): Promise<Page> {
  const page = await readPageDto(input.spacePath, input.path);
  return pageFromDto(page);
}

export function getPageDetailState(
  input: GetPageDetailStateInput,
): Promise<PageDetailState> {
  return getPageDetailStateDto({
    space: input.spacePath,
    path: input.path,
  });
}

export async function createPage(input: CreatePageInput): Promise<Page> {
  const page = await createPageDto({
    space: input.spacePath,
    parentPath: input.parentPath,
    title: input.title,
    contextualDefaults: input.contextualDefaults ?? null,
    allocateUniqueTitle: input.allocateUniqueTitle ?? false,
    asReadme: input.asReadme ?? false,
    projectPath: input.projectPath ?? null,
  });
  return pageFromDto(page);
}

export function renamePage(input: RenamePageInput): Promise<string[]> {
  return renamePageDto({
    space: input.spacePath,
    from: input.from,
    to: input.to,
    projectPath: input.projectPath ?? null,
  });
}

export async function updatePageField(
  input: UpdatePageFieldInput,
): Promise<Page> {
  const page = await updatePageFieldDto({
    space: input.spacePath,
    filePath: input.filePath,
    field: input.field,
    value: input.value,
    projectPath: input.projectPath,
  });
  return pageFromDto(page);
}

export async function writePage(input: WritePageInput): Promise<WritePageResult> {
  const result = await writePageDto({
    space: input.spacePath,
    path: input.path,
    content: input.content,
    skipRename: input.skipRename,
    projectPath: input.projectPath,
  });
  return writeResultFromDto(result);
}

export async function validatePageLinks(
  input: ValidatePageLinksInput,
): Promise<PageLinkValidationResult[]> {
  const result = await validatePageLinksDto({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
  return result.map(linkValidationResultFromDto);
}

export function deletePage(input: DeletePageInput): Promise<void> {
  return deletePageDto({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath ?? null,
  });
}

export async function duplicatePage(
  input: DuplicatePageInput,
): Promise<Page> {
  const page = await duplicatePageDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return pageFromDto(page);
}

export async function convertPageToFolder(
  input: ConvertPageToFolderInput,
): Promise<Page> {
  const page = await convertPageToFolderDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return pageFromDto(page);
}

export async function convertPageToLeaf(
  input: ConvertPageToLeafInput,
): Promise<Page> {
  const page = await convertPageToLeafDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return pageFromDto(page);
}

export async function convertPageToNestedCollection(
  input: ConvertPageToNestedCollectionInput,
): Promise<Page> {
  const conversion = await convertToCollectionDto({
    spacePath: input.spacePath,
    path: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return pageFromDto(conversion.page);
}

export async function savePageTreeOrder({
  spacePath,
  orderKey,
  pages,
  projectPath,
}: SavePageTreeOrderInput) {
  await savePageTreeOrderNames({
    spacePath,
    orderKey,
    names: pages.map(orderNameForPage),
    projectPath,
  });
}

export async function savePageTreeOrderNames({
  spacePath,
  orderKey,
  names,
  projectPath,
}: SavePageTreeOrderNamesInput) {
  const existing = await readContentTreeOrder(spacePath).catch(() => ({}));

  await saveContentTreeOrder({
    space: spacePath,
    order: {
      ...existing,
      [orderKey || "."]: names,
    },
    projectPath: projectPath ?? null,
  });
}

function pageFromDto(page: PageDto): Page {
  return normalizePage(page);
}

function orderNameForPage(page: Page) {
  const path = normalizePagePath(page.path);
  if (path.toLowerCase().endsWith("/readme.md")) {
    const folder = path.replace(/\/readme\.md$/i, "");
    return folder.split("/").at(-1) ?? folder;
  }
  return path.split("/").at(-1) ?? path;
}

function writeResultFromDto(result: WritePageResultDto): WritePageResult {
  return {
    newPath: result.new_path,
    modifiedFiles: result.modified_files,
    modifiedSources: result.modified_sources,
    writeNonce: result.write_nonce,
    warnings: result.warnings ?? [],
  };
}

function linkValidationResultFromDto(
  result: PageLinkValidationResultDto,
): PageLinkValidationResult {
  return result;
}
