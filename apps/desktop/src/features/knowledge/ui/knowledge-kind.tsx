import {
  Bot,
  FileText,
  Library,
  Link2,
  Network,
  Sparkles,
  SquareStack,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import type { KnowledgeEdgeKind, KnowledgeNodeKind } from "../model/types";
import * as m from "@/paraglide/messages.js";

const NODE_ICONS: Record<KnowledgeNodeKind, LucideIcon> = {
  page: FileText,
  collection: Library,
  agent_instruction: Bot,
  skill: Sparkles,
};

const EDGE_ICONS: Record<KnowledgeEdgeKind, LucideIcon> = {
  links_to: Link2,
  relation: Network,
  member_of: SquareStack,
  references: FileText,
};

export function KnowledgeKindIcon({
  kind,
  ...props
}: { kind: KnowledgeNodeKind } & ComponentProps<"svg">) {
  const Icon = NODE_ICONS[kind];
  return <Icon {...props} />;
}

export function KnowledgeEdgeKindIcon({
  kind,
  ...props
}: { kind: KnowledgeEdgeKind } & ComponentProps<"svg">) {
  const Icon = EDGE_ICONS[kind];
  return <Icon {...props} />;
}

export function knowledgeNodeKindLabel(kind: KnowledgeNodeKind) {
  switch (kind) {
    case "page":
      return m.knowledge_graph_kind_page();
    case "collection":
      return m.knowledge_graph_kind_collection();
    case "agent_instruction":
      return m.knowledge_graph_kind_agent_instruction();
    case "skill":
      return m.knowledge_graph_kind_skill();
  }
}

export function knowledgeEdgeKindLabel(kind: KnowledgeEdgeKind) {
  switch (kind) {
    case "links_to":
      return m.knowledge_graph_edge_links_to();
    case "relation":
      return m.knowledge_graph_edge_relation();
    case "member_of":
      return m.knowledge_graph_edge_member_of();
    case "references":
      return m.knowledge_graph_edge_references();
  }
}
