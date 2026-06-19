import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { Entry } from "@/features/entry";
import type {
  ChangeSchemaTypeResult,
  Column,
  EntrySchemaResult,
  Person,
  PropertyOption,
  PropertyType,
} from "../model/types";

interface SchemaMutationInput {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}

export function listPropertyPersons(spacePath: string, allTime = false) {
  return invoke<Person[]>("list_persons", {
    spacePath,
    allTime,
  });
}

export function getEntrySchema(input: {
  spacePath: string;
  filePath: string;
}) {
  return invoke<EntrySchemaResult | null>("get_entry_schema", {
    space: input.spacePath,
    filePath: input.filePath,
  });
}

function invokeSchemaMutation<T = unknown>(
  command: string,
  input: SchemaMutationInput,
  args: Record<string, unknown>,
) {
  return invoke<T>(command, {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    projectPath: input.projectPath ?? null,
    ...args,
  });
}

export function assignEntryUniqueId(input: {
  spacePath: string;
  filePath: string;
  projectPath?: string | null;
}) {
  return invoke<Entry>("assign_unique_id", {
    space: input.spacePath,
    filePath: input.filePath,
    projectPath: input.projectPath ?? null,
  });
}

export function changeSchemaType(input: {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  columnName: string;
  newType: PropertyType;
  conversionStrategy?: Record<string, unknown>;
}) {
  return invoke<ChangeSchemaTypeResult>("change_schema_type", {
    space: input.spacePath,
    collectionPath: input.collectionPath,
    projectPath: input.projectPath ?? null,
    columnName: input.columnName,
    newType: input.newType,
    conversionStrategy: input.conversionStrategy,
  });
}

export function clearFieldValues(input: SchemaMutationInput & { field: string }) {
  return invokeSchemaMutation("clear_field_values", input, {
    field: input.field,
  });
}

export function clearOptionValues(
  input: SchemaMutationInput & {
    columnName: string;
    optionNames: string[];
  },
) {
  return invokeSchemaMutation("clear_option_values", input, {
    columnName: input.columnName,
    optionNames: input.optionNames,
  });
}

export function promoteOrphan(input: SchemaMutationInput & {
  filePath: string;
  field: string;
}) {
  return invokeSchemaMutation("promote_orphan", input, {
    filePath: input.filePath,
    field: input.field,
  });
}

export function addSchemaColumn(input: SchemaMutationInput & { column: Column }) {
  return invokeSchemaMutation("add_schema_column", input, {
    column: input.column,
  });
}

export function renameSchemaColumn(
  input: SchemaMutationInput & {
    oldName: string;
    newName: string;
  },
) {
  return invokeSchemaMutation("rename_schema_column", input, {
    oldName: input.oldName,
    newName: input.newName,
  });
}

export function deleteSchemaColumn(
  input: SchemaMutationInput & {
    columnName: string;
    deleteValues: boolean;
  },
) {
  return invokeSchemaMutation("delete_schema_column", input, {
    columnName: input.columnName,
    deleteValues: input.deleteValues,
  });
}

export function addOption(
  input: SchemaMutationInput & {
    columnName: string;
    option: PropertyOption;
  },
) {
  return invokeSchemaMutation("add_option", input, {
    columnName: input.columnName,
    option: input.option,
  });
}

export function renameOption(
  input: SchemaMutationInput & {
    columnName: string;
    oldOptionName: string;
    newOptionName: string;
  },
) {
  return invokeSchemaMutation("rename_option", input, {
    columnName: input.columnName,
    oldOptionName: input.oldOptionName,
    newOptionName: input.newOptionName,
  });
}

export function deleteOption(
  input: SchemaMutationInput & {
    columnName: string;
    optionName: string;
    deleteValues: boolean;
  },
) {
  return invokeSchemaMutation("delete_option", input, {
    columnName: input.columnName,
    optionName: input.optionName,
    deleteValues: input.deleteValues,
  });
}
