import type { KnowledgeNode, KnowledgeSearchItem } from "./types";

type KnowledgeOpenTarget =
  | KnowledgeNode
  | Pick<KnowledgeSearchItem, "source" | "locationPath">;

export function knowledgeOpenPath(target: KnowledgeOpenTarget): string {
  if ("locationPath" in target && target.locationPath) {
    return target.locationPath;
  }
  if ("provenance" in target) {
    const readmePath = target.provenance.readmePath;
    if (target.source.kind === "collection" && typeof readmePath === "string") {
      return readmePath;
    }
    return target.canonicalSourcePath || target.source.path;
  }
  return target.source.path;
}
