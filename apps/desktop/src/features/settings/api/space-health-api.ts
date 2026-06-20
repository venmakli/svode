import { countBrokenLinks as countPlatformBrokenLinks } from "@/platform/space/space-api";

export function countBrokenLinks(projectPath: string): Promise<number> {
  return countPlatformBrokenLinks(projectPath);
}
