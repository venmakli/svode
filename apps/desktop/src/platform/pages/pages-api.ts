import { invokeCommand } from "@/platform/native/invoke";

export type PageCoverDto =
  | { type: "color"; value: string }
  | { type: "image"; path: string; position?: number | null };

export interface PageMetaDto {
  title: string;
  icon: string | null;
  description?: string | null;
  cover?: PageCoverDto | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

export interface PageWarningDto {
  kind: string;
  message: string;
  path?: string | null;
}

export interface PageNameConflictDto {
  parentPath: string | null;
  conflicts: Array<{ path: string; title: string }>;
}

export interface PageDto {
  meta: PageMetaDto;
  body: string;
  path: string;
  warnings?: PageWarningDto[];
  name_conflict?: PageNameConflictDto;
}

export interface PageLinkValidationResultDto {
  url: string;
  exists: boolean;
}

export interface PageBacklinkDto {
  sourceSpaceId: string | null;
  sourcePath: string;
  linkCount: number;
}

export interface PageDetailStateDto {
  form: "leaf" | "folder" | "nestedCollection";
  subpageCount: number;
  otherFileCount: number;
}

export interface WritePageInputDto extends Record<string, unknown> {
  space: string;
  path: string;
  content: string;
  skipRename: boolean;
  projectPath: string | null;
}

export interface WritePageResultDto {
  new_path: string | null;
  modified_files: string[];
  modified_sources?: { spaceId: string | null; path: string }[];
  write_nonce: string;
  warnings?: PageWarningDto[];
}

export function createPage(input: {
  space: string;
  parentPath: string | null;
  title: string;
  contextualDefaults?: Record<string, unknown> | null;
  allocateUniqueTitle?: boolean;
  asReadme?: boolean;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("create_entry", { ...input });
}

export function renamePage(input: {
  space: string;
  from: string;
  to: string;
  projectPath: string | null;
}): Promise<string[]> {
  return invokeCommand<string[]>("rename_entry", { ...input });
}

export function readPage(space: string, path: string): Promise<PageDto> {
  return invokeCommand<PageDto>("read_entry", { space, path });
}

export function getPageDetailState(input: {
  space: string;
  path: string;
}): Promise<PageDetailStateDto> {
  return invokeCommand<PageDetailStateDto>("get_entry_detail_state", {
    ...input,
  });
}

export function writePage(input: WritePageInputDto): Promise<WritePageResultDto> {
  return invokeCommand<WritePageResultDto>("write_entry", input);
}

export function updatePageField(input: {
  space: string;
  filePath: string;
  field: string;
  value: unknown;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("update_entry_field", { ...input });
}

export function deletePage(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<void> {
  return invokeCommand<void>("delete_entry", { ...input });
}

export function duplicatePage(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("duplicate_entry", { ...input });
}

export function getPageBacklinks(input: {
  space: string;
  targetPath: string;
  projectPath: string | null;
}): Promise<PageBacklinkDto[]> {
  return invokeCommand<PageBacklinkDto[]>("get_backlinks", { ...input });
}

export function nestPage(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("nest_entry", { ...input });
}

export function unnestPage(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("unnest_entry", { ...input });
}

export function convertPageToFolder(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("convert_entry_to_folder", { ...input });
}

export function convertPageToLeaf(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("convert_entry_to_leaf", { ...input });
}

export function validatePageLinks(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<PageLinkValidationResultDto[]> {
  return invokeCommand<PageLinkValidationResultDto[]>("validate_links", input);
}
