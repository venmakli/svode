import * as propertiesPlatform from "@/platform/properties/properties-api";
import type {
  ActorCandidateDto,
  ColumnDto,
  PropertyOptionDto,
} from "@/platform/properties/properties-api";
import { normalizeSchema } from "../lib/utils";
import type {
  ActorCandidate,
  ChangeSchemaTypeResult,
  CollectionSchema,
  Column,
  ColumnPatch,
  EntrySchemaResult,
  PropertyOption,
  PropertyType,
} from "../model/types";

interface SchemaMutationInput {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}

export interface CollectionOption {
  path: string;
  title: string;
}

export async function listPropertyActors(spacePath: string, allTime = false) {
  const actors = await propertiesPlatform.listActors(spacePath, allTime);
  return actors.map(toActorCandidate);
}

export async function getEntrySchema(input: {
  spacePath: string;
  filePath: string;
}): Promise<EntrySchemaResult | null> {
  const result = await propertiesPlatform.getEntrySchema(input);
  return result
    ? {
        schema: normalizeSchema(result.schema),
        collectionRootPath:
          result.collectionRootPath ?? result.collection_root_path ?? "",
      }
    : null;
}

export async function getCollectionSchema(
  input: SchemaMutationInput,
): Promise<CollectionSchema> {
  return normalizeSchema(await propertiesPlatform.getCollectionSchema(input));
}

export function listCollectionOptions(spacePath: string) {
  return propertiesPlatform.listCollections(spacePath);
}

export async function assignEntryUniqueId(input: {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}) {
  const entry = await propertiesPlatform.assignUniqueId(input);
  return entry.meta?.extra ?? {};
}

export async function normalizeUniqueIdCounter(
  input: SchemaMutationInput,
): Promise<CollectionSchema> {
  return normalizeSchema(await propertiesPlatform.normalizeUniqueIdCounter(input));
}

export async function changeSchemaType(input: {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  columnName: string;
  newType: PropertyType;
  conversionStrategy?: Record<string, unknown>;
}): Promise<ChangeSchemaTypeResult> {
  const result = await propertiesPlatform.changeSchemaType(input);
  return {
    schema: normalizeSchema(result.schema),
    warnings: result.warnings,
  };
}

export function clearFieldValues(
  input: SchemaMutationInput & { field: string },
) {
  return propertiesPlatform.clearFieldValues(input);
}

export function clearOptionValues(
  input: SchemaMutationInput & {
    columnName: string;
    optionNames: string[];
  },
) {
  return propertiesPlatform.clearOptionValues(input);
}

export function promoteOrphan(
  input: SchemaMutationInput & {
    filePath: string;
    field: string;
  },
) {
  return propertiesPlatform.promoteOrphan(input);
}

export function addSchemaColumn(
  input: SchemaMutationInput & { column: Column },
) {
  return propertiesPlatform.addSchemaColumn({
    ...input,
    column: toColumnDto(input.column),
  });
}

export async function updateSchemaColumn(
  input: SchemaMutationInput & {
    columnName: string;
    patch: ColumnPatch;
  },
): Promise<CollectionSchema> {
  return normalizeSchema(
    await propertiesPlatform.updateSchemaColumn({
      ...input,
      patch: toColumnPatchDto(input.patch),
    }),
  );
}

export function renameSchemaColumn(
  input: SchemaMutationInput & {
    oldName: string;
    newName: string;
  },
) {
  return propertiesPlatform.renameSchemaColumn(input);
}

export async function deleteSchemaColumn(
  input: SchemaMutationInput & {
    columnName: string;
    deleteValues: boolean;
  },
): Promise<CollectionSchema> {
  return normalizeSchema(await propertiesPlatform.deleteSchemaColumn(input));
}

export async function addOption(
  input: SchemaMutationInput & {
    columnName: string;
    option: PropertyOption;
  },
): Promise<CollectionSchema> {
  return normalizeSchema(
    await propertiesPlatform.addOption({
      ...input,
      option: toPropertyOptionDto(input.option),
    }),
  );
}

export async function updateOption(
  input: SchemaMutationInput & {
    columnName: string;
    optionName: string;
    option?: PropertyOption | null;
    patch: Record<string, unknown>;
  },
): Promise<CollectionSchema> {
  return normalizeSchema(
    await propertiesPlatform.updateOption({
      ...input,
      option: input.option ? toPropertyOptionDto(input.option) : null,
    }),
  );
}

export async function renameOption(
  input: SchemaMutationInput & {
    columnName: string;
    oldOptionName: string;
    newOptionName: string;
  },
): Promise<CollectionSchema> {
  return normalizeSchema(await propertiesPlatform.renameOption(input));
}

export async function deleteOption(
  input: SchemaMutationInput & {
    columnName: string;
    optionName: string;
    deleteValues: boolean;
  },
): Promise<CollectionSchema> {
  return normalizeSchema(await propertiesPlatform.deleteOption(input));
}

function toActorCandidate(actor: ActorCandidateDto): ActorCandidate {
  return {
    email: actor.email,
    name: actor.name,
    lastCommitAt: actor.lastCommitAt ?? actor.last_commit_at ?? null,
    commitCount: actor.commitCount ?? actor.commit_count ?? 0,
    isMe: actor.isMe ?? actor.is_me ?? false,
  };
}

function toColumnDto(column: Column): ColumnDto {
  const { timeByDefault, rangeByDefault, twoWay, options, ...rest } = column;
  return {
    ...rest,
    options: options?.map(toPropertyOptionDto) ?? options,
    ...(timeByDefault !== undefined ? { time_by_default: timeByDefault } : {}),
    ...(rangeByDefault !== undefined
      ? { range_by_default: rangeByDefault }
      : {}),
    ...(twoWay !== undefined ? { two_way: twoWay } : {}),
  };
}

function toColumnPatchDto(patch: ColumnPatch): Record<string, unknown> {
  const { timeByDefault, rangeByDefault, twoWay, options, ...rest } = patch;
  return {
    ...rest,
    ...(options !== undefined
      ? { options: options?.map(toPropertyOptionDto) ?? options }
      : {}),
    ...(timeByDefault !== undefined ? { time_by_default: timeByDefault } : {}),
    ...(rangeByDefault !== undefined
      ? { range_by_default: rangeByDefault }
      : {}),
    ...(twoWay !== undefined ? { two_way: twoWay } : {}),
  };
}

function toPropertyOptionDto(option: PropertyOption): PropertyOptionDto {
  return { ...option };
}
