import {
  getKnowledgeDocuments,
  type GetKnowledgeDocumentsInputDto,
} from "@/platform/knowledge/knowledge-api";
import type { KnowledgeSnapshot } from "../model/types";

export interface GetKnowledgeSnapshotInput {
  projectPath: string;
  scope?: GetKnowledgeDocumentsInputDto["scope"];
  query?: string;
  nodeOffset?: number;
  edgeOffset?: number;
  nodeLimit?: number;
  edgeLimit?: number;
  searchLimit?: number;
}

export function getKnowledgeSnapshot(
  input: GetKnowledgeSnapshotInput,
): Promise<KnowledgeSnapshot> {
  return getKnowledgeDocuments({
    projectPath: input.projectPath,
    scope: input.scope,
    query: input.query,
    nodeOffset: input.nodeOffset,
    edgeOffset: input.edgeOffset,
    nodeLimit: input.nodeLimit,
    edgeLimit: input.edgeLimit,
    searchLimit: input.searchLimit,
  });
}
