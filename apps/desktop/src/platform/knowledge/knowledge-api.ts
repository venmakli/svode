import { invokeCommand } from "@/platform/native/invoke";
import type {
  KnowledgeEdgeKindDto,
  KnowledgeNodeKindDto,
  KnowledgeResponseDto,
  KnowledgeScopeDto,
  KnowledgeSourceDto,
} from "./knowledge-types";

export interface GetKnowledgeDocumentsInputDto extends Record<string, unknown> {
  projectPath: string;
  scope?: KnowledgeScopeDto;
  query?: string;
  filters?: KnowledgeFiltersDto;
  nodeOffset?: number;
  edgeOffset?: number;
  nodeLimit?: number;
  edgeLimit?: number;
  searchLimit?: number;
}

export interface KnowledgeFiltersDto {
  nodeKinds?: KnowledgeNodeKindDto[];
  edgeKinds?: KnowledgeEdgeKindDto[];
  neighbor?: KnowledgeSourceDto;
  neighborLimit?: number;
}

export function getKnowledgeDocuments(
  input: GetKnowledgeDocumentsInputDto,
): Promise<KnowledgeResponseDto> {
  return invokeCommand<KnowledgeResponseDto>("get_knowledge_documents", input);
}

export function repairKnowledgeIndex(projectPath: string): Promise<void> {
  return invokeCommand<void>("reindex_project", { projectPath });
}
