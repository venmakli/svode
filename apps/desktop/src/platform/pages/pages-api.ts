import type { RepositoryAccessBlockerDto } from "@/platform/git/repository-access-api";
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
  reason?: string | null;
  blockers?: RepositoryAccessBlockerDto[];
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
  source_version?: string | null;
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
  projectPath: string | null;
  sourceVersion: string;
}

export interface WritePageResultDto {
  write_nonce: string;
  source_version?: string | null;
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
  return invokeCommand<PageDto>("create_page", { ...input });
}

export function readPage(space: string, path: string): Promise<PageDto> {
  return invokeCommand<PageDto>("read_page", { space, path });
}

export function getPageDetailState(input: {
  space: string;
  path: string;
}): Promise<PageDetailStateDto> {
  return invokeCommand<PageDetailStateDto>("get_page_detail_state", {
    ...input,
  });
}

export function writePage(
  input: WritePageInputDto,
): Promise<WritePageResultDto> {
  return invokeCommand<WritePageResultDto>("write_page_body", input);
}

export function updatePageField(input: {
  space: string;
  filePath: string;
  field: string;
  value: unknown;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("update_page_field", { ...input });
}

export function deletePage(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<void> {
  return invokeCommand<void>("delete_content", { ...input });
}

export function duplicatePage(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("duplicate_page", { ...input });
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
  return invokeCommand<string>("nest_page", { ...input });
}

export function unnestPage(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("unnest_page", { ...input });
}

export function convertPageToFolder(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("convert_page_to_folder", { ...input });
}

export function convertPageToLeaf(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<PageDto> {
  return invokeCommand<PageDto>("convert_page_to_leaf", { ...input });
}

export function validatePageLinks(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<PageLinkValidationResultDto[]> {
  return invokeCommand<PageLinkValidationResultDto[]>("validate_links", input);
}
