import { invokeCommand } from "@/platform/native/invoke";
import type {
  KnowledgeResponseDto,
  KnowledgeScopeDto,
} from "./knowledge-types";

export interface GetKnowledgeDocumentsInputDto extends Record<string, unknown> {
  projectPath: string;
  scope?: KnowledgeScopeDto;
  query?: string;
  nodeOffset?: number;
  edgeOffset?: number;
  nodeLimit?: number;
  edgeLimit?: number;
  searchLimit?: number;
}

export function getKnowledgeDocuments(
  input: GetKnowledgeDocumentsInputDto,
): Promise<KnowledgeResponseDto> {
  return invokeCommand<KnowledgeResponseDto>("get_knowledge_documents", input);
}
