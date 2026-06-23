import {
  createEntry as createEntryDto,
  convertEntryToFolder as convertEntryToFolderDto,
  convertEntryToLeaf as convertEntryToLeafDto,
  convertEntryToNestedCollection as convertEntryToNestedCollectionDto,
  deleteEntry as deleteEntryDto,
  duplicateEntry as duplicateEntryDto,
  readEntry as readEntryDto,
  renameEntry as renameEntryDto,
  updateEntryField as updateEntryFieldDto,
  type EntryDto,
} from "@/platform/entries/entries-api";
import type { CoverColorName, Entry, EntryCover } from "../model/types";

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

const COVER_COLOR_NAMES = new Set<CoverColorName>([
  "neutral",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
]);

export async function readEntry(input: ReadEntryInput): Promise<Entry> {
  const entry = await readEntryDto(input.spacePath, input.path);
  return entryFromDto(entry);
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

export function convertEntryToNestedCollection(
  input: ConvertEntryToNestedCollectionInput,
): Promise<string> {
  return convertEntryToNestedCollectionDto({
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
}

function entryFromDto(entry: EntryDto): Entry {
  return {
    ...entry,
    meta: {
      ...entry.meta,
      cover: entryCoverFromDto(entry.meta.cover),
    },
  };
}

function entryCoverFromDto(
  cover: EntryDto["meta"]["cover"],
): EntryCover | null | undefined {
  if (cover == null) return cover;
  if (cover.type === "image") return cover;
  return {
    type: "color",
    value: COVER_COLOR_NAMES.has(cover.value as CoverColorName)
      ? (cover.value as CoverColorName)
      : "neutral",
  };
}
