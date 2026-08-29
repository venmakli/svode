import {
  getKnowledgeSnapshot as getKnowledgeSnapshotDto,
  repairKnowledgeIndex,
  type GetKnowledgeSnapshotInputDto,
} from "@/platform/knowledge/knowledge-api";
import type { KnowledgeSnapshot } from "../model/types";

export interface GetKnowledgeSnapshotInput {
  projectPath: string;
  scope?: GetKnowledgeSnapshotInputDto["scope"];
  query?: string;
  filters?: GetKnowledgeSnapshotInputDto["filters"];
  nodeOffset?: number;
  edgeOffset?: number;
  nodeLimit?: number;
  edgeLimit?: number;
  searchLimit?: number;
}

export function getKnowledgeSnapshot(
  input: GetKnowledgeSnapshotInput,
): Promise<KnowledgeSnapshot> {
  return getKnowledgeSnapshotDto({
    projectPath: input.projectPath,
    scope: input.scope,
    query: input.query,
    filters: input.filters,
    nodeOffset: input.nodeOffset,
    edgeOffset: input.edgeOffset,
    nodeLimit: input.nodeLimit,
    edgeLimit: input.edgeLimit,
    searchLimit: input.searchLimit,
  });
}

export function repairKnowledgeSnapshot(projectPath: string): Promise<void> {
  return repairKnowledgeIndex(projectPath);
}
