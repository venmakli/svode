import {
  CollectionDetailInfo,
  type CollectionDetailInfoGroup,
} from "@/features/collection/app-shell";
import {
  AgentIcon,
  useAgentAdapterDictionary,
  type AgentAdapterDictionary,
} from "@/features/agent-adapters";
import * as m from "@/paraglide/messages.js";

import type {
  AgentContextItem,
  AgentContextReference,
  AgentContextSourceReader,
} from "../model/types";

/**
 * ⓘ "Details": "Sources" — a line per path by which enabled agents find the
 * item, with the agents reading by it and only the shadowed ones marked —
 * and the imports of an instruction.
 */
export function AgentContextItemInfo({ item }: { item: AgentContextItem }) {
  const agents = useAgentAdapterDictionary();
  const groups: CollectionDetailInfoGroup[] = [
    {
      key: "sources",
      label: m.agent_context_info_sources(),
      rows: item.sources.map((source) => ({
        detail: <SourceReaders agents={agents} readers={source.readers} />,
        key: source.path,
        path: source.path,
        target: source.target,
      })),
    },
  ];
  if (item.kind === "instruction") {
    groups.push({
      key: "imports",
      label: m.agent_context_info_imports(),
      rows: item.references.map((reference) => ({
        detail: referenceStatusLabel(reference.status),
        key: `${reference.status}:${reference.path}`,
        path: reference.path,
      })),
    });
  }
  return (
    <CollectionDetailInfo
      groups={groups}
      title={
        item.kind === "skill"
          ? m.agent_context_info_skill()
          : item.kind === "plugin"
            ? m.agent_context_info_plugin()
            : m.agent_context_info_instruction()
      }
    />
  );
}

function SourceReaders({
  agents,
  readers,
}: {
  agents: AgentAdapterDictionary;
  readers: readonly AgentContextSourceReader[];
}) {
  return (
    <ul className="flex min-w-0 flex-col gap-0.5" data-agent-context-readers>
      {readers.map((reader) => (
        <li key={reader.agent} className="flex min-w-0 items-start gap-1.5">
          <AgentIcon agent={reader.agent} className="mt-0.5 size-3.5" />
          <span className="min-w-0 break-all">
            {agents.label(reader.agent)}
            {readerException(reader)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Only exceptions are labelled: shadowed, turned off, unchecked switch. */
function readerException(reader: AgentContextSourceReader) {
  if (reader.disabled) return ` · ${m.agent_context_reader_disabled()}`;
  if (reader.supersededBy !== null) {
    return ` · ${
      reader.supersededBy
        ? m.agent_context_reader_superseded_by({ path: reader.supersededBy })
        : m.agent_context_reader_superseded()
    }`;
  }
  if (reader.unverified) return ` · ${m.agent_context_reader_unverified()}`;
  return null;
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
