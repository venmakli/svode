import { invokeCommand } from "@/platform/native/invoke";

export function pathExists(path: string): Promise<boolean> {
  return invokeCommand<boolean>("path_exists", { path });
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
