import {
  deleteEntry as deleteEntryDto,
  duplicateEntry as duplicateEntryDto,
  readEntry as readEntryDto,
  updateEntryField as updateEntryFieldDto,
  type EntryDto,
} from "@/platform/entries/entries-api";
import type { CoverColorName, Entry, EntryCover } from "../model/types";

export interface ReadEntryInput {
  spacePath: string;
  path: string;
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
