export const SVODE_RESOURCE_MIME = "application/x-svode-resource+json";

export type SvodeDraggedResourceKind = "file" | "folder" | "collection";

export interface SvodeDraggedResource {
  version: 1;
  kind: SvodeDraggedResourceKind;
  projectPath: string;
  spacePath: string;
  relativePath: string;
}

export function serializeSvodeDraggedResource(
  resource: SvodeDraggedResource,
): string {
  return JSON.stringify(resource);
}

export function parseSvodeDraggedResource(
  value: string,
): SvodeDraggedResource | null {
  try {
    const candidate: unknown = JSON.parse(value);
    if (!candidate || typeof candidate !== "object") return null;
    const resource = candidate as Partial<SvodeDraggedResource>;
    if (
      resource.version !== 1 ||
      !["file", "folder", "collection"].includes(resource.kind ?? "") ||
      typeof resource.projectPath !== "string" ||
      typeof resource.spacePath !== "string" ||
      typeof resource.relativePath !== "string" ||
      !resource.projectPath ||
      !resource.spacePath ||
      !resource.relativePath
    ) {
      return null;
    }
    return resource as SvodeDraggedResource;
  } catch {
    return null;
  }
}
