import {
  createEntry as createEntryDto,
  convertEntryToFolder as convertEntryToFolderDto,
  convertEntryToLeaf as convertEntryToLeafDto,
  deleteEntry as deleteEntryDto,
  duplicateEntry as duplicateEntryDto,
  getEntryDetailState as getEntryDetailStateDto,
  type LinkValidationResultDto,
  readEntry as readEntryDto,
  readTreeOrder as readTreeOrderDto,
  renameEntry as renameEntryDto,
  saveTreeOrder as saveTreeOrderDto,
  updateEntryField as updateEntryFieldDto,
  validateLinks as validateLinksDto,
  writeEntry as writeEntryDto,
  type EntryDto,
  type WriteResultDto,
} from "@/platform/entries/entries-api";
import { convertToCollection as convertToCollectionDto } from "@/platform/collections/collections-api";
import { normalizeEntry } from "../model/normalize-entry";
import type {
  Entry,
  EntryDetailState,
  LinkValidationResult,
  WriteResult,
} from "../model/types";
import { normalizeEntryPath } from "../lib/path";

export interface ReadEntryInput {
  spacePath: string;
  path: string;
}

export interface CreateEntryInput {
  spacePath: string;
  parentPath: string | null;
  title: string;
  contextualDefaults?: Record<string, unknown> | null;
  projectPath?: string | null;
}

export interface RenameEntryInput {
  spacePath: string;
  from: string;
  to: string;
  projectPath?: string | null;
}

export interface UpdateEntryFieldInput {
  spacePath: string;
  filePath: string;
  field: string;
  value: unknown;
  projectPath: string | null;
}

export interface WriteEntryInput {
  spacePath: string;
  path: string;
  content: string;
  skipRename: boolean;
  projectPath: string | null;
}

export interface ValidateLinksInput {
  spacePath: string;
  path: string;
  projectPath: string | null;
}

export interface DeleteEntryInput {
  spacePath: string;
  path: string;
  projectPath?: string | null;
}

export interface DuplicateEntryInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface ConvertEntryToFolderInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface ConvertEntryToLeafInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface ConvertEntryToNestedCollectionInput {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}

export interface GetEntryDetailStateInput {
  spacePath: string;
  path: string;
}

export interface SaveEntryTreeOrderInput {
  spacePath: string;
  orderKey: string;
  entries: Entry[];
  projectPath?: string | null;
}

export interface SaveEntryTreeOrderNamesInput {
  spacePath: string;
  orderKey: string;
  names: string[];
  projectPath?: string | null;
}

export async function readEntry(input: ReadEntryInput): Promise<Entry> {
  const entry = await readEntryDto(input.spacePath, input.path);
  return entryFromDto(entry);
}

export function getEntryDetailState(
  input: GetEntryDetailStateInput,
): Promise<EntryDetailState> {
  return getEntryDetailStateDto({
    space: input.spacePath,
    path: input.path,
  });
}

export async function createEntry(input: CreateEntryInput): Promise<Entry> {
  const entry = await createEntryDto({
    space: input.spacePath,
    parentPath: input.parentPath,
    title: input.title,
    contextualDefaults: input.contextualDefaults ?? null,
    projectPath: input.projectPath ?? null,
  });
  return entryFromDto(entry);
}

export function renameEntry(input: RenameEntryInput): Promise<string[]> {
  return renameEntryDto({
    space: input.spacePath,
    from: input.from,
    to: input.to,
    projectPath: input.projectPath ?? null,
  });
}

export async function updateEntryField(
  input: UpdateEntryFieldInput,
): Promise<Entry> {
  const entry = await updateEntryFieldDto({
    space: input.spacePath,
    filePath: input.filePath,
    field: input.field,
    value: input.value,
    projectPath: input.projectPath,
  });
  return entryFromDto(entry);
}

export async function writeEntry(input: WriteEntryInput): Promise<WriteResult> {
  const result = await writeEntryDto({
    space: input.spacePath,
    path: input.path,
    content: input.content,
    skipRename: input.skipRename,
    projectPath: input.projectPath,
  });
  return writeResultFromDto(result);
}

export async function validateLinks(
  input: ValidateLinksInput,
): Promise<LinkValidationResult[]> {
  const result = await validateLinksDto({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
  return result.map(linkValidationResultFromDto);
}

export function deleteEntry(input: DeleteEntryInput): Promise<void> {
  return deleteEntryDto({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath ?? null,
  });
}

export async function duplicateEntry(
  input: DuplicateEntryInput,
): Promise<Entry> {
  const entry = await duplicateEntryDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return entryFromDto(entry);
}

export async function convertEntryToFolder(
  input: ConvertEntryToFolderInput,
): Promise<Entry> {
  const entry = await convertEntryToFolderDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return entryFromDto(entry);
}

export async function convertEntryToLeaf(
  input: ConvertEntryToLeafInput,
): Promise<Entry> {
  const entry = await convertEntryToLeafDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return entryFromDto(entry);
}

export async function convertEntryToNestedCollection(
  input: ConvertEntryToNestedCollectionInput,
): Promise<Entry> {
  const conversion = await convertToCollectionDto({
    spacePath: input.spacePath,
    path: input.filePath,
    projectPath: input.projectPath ?? null,
  });
  return entryFromDto(conversion.entry);
}

export async function saveEntryTreeOrder({
  spacePath,
  orderKey,
  entries,
  projectPath,
}: SaveEntryTreeOrderInput) {
  await saveEntryTreeOrderNames({
    spacePath,
    orderKey,
    names: entries.map(orderNameForEntry),
    projectPath,
  });
}

export async function saveEntryTreeOrderNames({
  spacePath,
  orderKey,
  names,
  projectPath,
}: SaveEntryTreeOrderNamesInput) {
  const existing = await readTreeOrderDto(spacePath).catch(() => ({}));

  await saveTreeOrderDto({
    space: spacePath,
    order: {
      ...existing,
      [orderKey || "."]: names,
    },
    projectPath: projectPath ?? null,
  });
}

function entryFromDto(entry: EntryDto): Entry {
  return normalizeEntry(entry);
}

function orderNameForEntry(entry: Entry) {
  const path = normalizeEntryPath(entry.path);
  if (path.toLowerCase().endsWith("/readme.md")) {
    const folder = path.replace(/\/readme\.md$/i, "");
    return folder.split("/").at(-1) ?? folder;
  }
  return path.split("/").at(-1) ?? path;
}

function writeResultFromDto(result: WriteResultDto): WriteResult {
  return {
    newPath: result.new_path,
    modifiedFiles: result.modified_files,
    modifiedSources: result.modified_sources,
    writeNonce: result.write_nonce,
  };
}

function linkValidationResultFromDto(
  result: LinkValidationResultDto,
): LinkValidationResult {
  return result;
}
