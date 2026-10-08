import { homeDir } from "@tauri-apps/api/path";
import { invokeCommand } from "@/platform/native/invoke";

export function pathExists(path: string): Promise<boolean> {
  return invokeCommand<boolean>("path_exists", { path });
}

export type PathKindDto = "file" | "directory";

export interface LocalPathDto {
  kind: PathKindDto;
  /** A file opens for reading, a folder lists its entries. */
  readable: boolean;
}

/**
 * Whether `path` names a file or a folder and can be read; null when
 * nothing is there.
 */
export function pathKind(path: string): Promise<LocalPathDto | null> {
  return invokeCommand<LocalPathDto | null>("path_kind", { path });
}

/** The user's home folder. */
export function homeDirectory(): Promise<string> {
  return homeDir();
}

/** Files of the project whose name contains `query`, as absolute paths. */
export function searchProjectFiles(
  projectPath: string,
  query: string,
  limit: number,
): Promise<string[]> {
  return invokeCommand<string[]>("search_project_files", {
    projectPath,
    query,
    limit,
  });
}

interface LocalFileDto {
  name: string;
  bytes: number[];
  mimeType: string;
}

/** The bytes of a local file by its absolute path, as a typed blob. */
export async function readLocalFile(path: string): Promise<Blob> {
  const file = await invokeCommand<LocalFileDto>("read_file_for_upload", {
    path,
  });
  return new Blob([new Uint8Array(file.bytes)], { type: file.mimeType });
}
