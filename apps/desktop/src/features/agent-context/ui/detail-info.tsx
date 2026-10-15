import {
  CollectionDetailInfo,
  type CollectionDetailInfoGroup,
} from "@/features/collection/app-shell";
import * as m from "@/paraglide/messages.js";

import {
  instructionImports,
  instructionSourceLines,
  skillSourceLines,
  type AgentContextSourceLine,
} from "../model/detail-info";
import type {
  AgentContextInstructionRow,
  AgentContextReference,
  AgentContextSkillRow,
} from "../model/types";
import { sourceLinkKindLabel } from "./provenance-labels";

/** ⓘ "Instruction details": its discovery path and its imports. */
export function AgentContextInstructionInfo({
  row,
}: {
  row: AgentContextInstructionRow;
}) {
  return (
    <CollectionDetailInfo
      groups={[
        sourcesGroup(instructionSourceLines(row)),
        {
          key: "imports",
          label: m.agent_context_info_imports(),
          rows: instructionImports(row).map((reference) => ({
            detail: referenceStatusLabel(reference.status),
            key: `${reference.status}:${reference.path}`,
            path: reference.path,
          })),
        },
      ]}
      title={m.agent_context_info_instruction()}
    />
  );
}

/** ⓘ "Skill details": the paths by which clients discover the skill. */
export function AgentContextSkillInfo({ row }: { row: AgentContextSkillRow }) {
  return (
    <CollectionDetailInfo
      groups={[sourcesGroup(skillSourceLines(row))]}
      title={m.agent_context_info_skill()}
    />
  );
}

function sourcesGroup(
  lines: readonly AgentContextSourceLine[],
): CollectionDetailInfoGroup {
  return {
    key: "sources",
    label: m.agent_context_info_sources(),
    rows: lines.map((line) => ({
      detail:
        line.linkKind === "direct" ? null : sourceLinkKindLabel(line.linkKind),
      key: line.path,
      path: line.path,
      target: line.target,
    })),
  };
}

function referenceStatusLabel(status: AgentContextReference["status"]) {
  if (status === "available") {
    return m.agent_context_import_status_available();
  }
  if (status === "outside_boundary") {
    return m.agent_context_import_status_outside_boundary();
  }
  if (status === "requires_client_approval") {
    return m.agent_context_import_status_requires_client_approval();
  }
  return m.agent_context_import_status_unreadable();
}
