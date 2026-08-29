import { useCallback } from "react";

import {
  useRepositoryAccessPreflight,
  type RepositoryAccessRequest,
  type RepositoryAccessTarget,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type { AgentActorRow } from "../model/agent-actor-types";

export type AgentActorAccessIntent =
  | { kind: "add-agent"; ownerPath: string }
  | { kind: "edit-agent"; ownerPath: string; row: AgentActorRow }
  | { kind: "delete-agent"; ownerPath: string; row: AgentActorRow }
  | { kind: "save-agent-catalog"; ownerPath: string };

export interface AgentActorLateAccessRequest {
  continue(): void | Promise<void>;
  intentKey: string;
  intentLabel: string;
  onPlanChanged?: () => void | Promise<void>;
  ownerName?: string;
  ownerPath: string;
  placement: "dialog" | "inline";
}

export function useAgentActorAccessCoordinator({
  onContinue,
  onOpenRepositorySettings,
}: {
  onContinue(intent: AgentActorAccessIntent): void;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}) {
  const recovery = useRepositoryAccessPreflight();
  const targetFor = useCallback(
    (ownerPath: string, ownerName?: string): RepositoryAccessTarget => ({
      displayName: ownerName ?? repositoryNameFromPath(ownerPath),
      displayPath: ownerPath,
      repositoryPath: ownerPath,
      openSettings: onOpenRepositorySettings
        ? () => onOpenRepositorySettings(ownerPath)
        : undefined,
    }),
    [onOpenRepositorySettings],
  );

  const request = useCallback(
    (intent: AgentActorAccessIntent) =>
      void recovery.request({
        continuation: "automatic",
        continue: () => onContinue(intent),
        intentKey: intent.kind,
        intentLabel: intentLabel(intent),
        placement:
          intent.kind === "add-agent" || intent.kind === "save-agent-catalog"
            ? "inline"
            : "dialog",
        targets: [
          targetFor(
            intent.ownerPath,
            "row" in intent ? intent.row.ownerLabel : undefined,
          ),
        ],
      }),
    [onContinue, recovery, targetFor],
  );

  const lateRequest = useCallback(
    (request: AgentActorLateAccessRequest): RepositoryAccessRequest => ({
      continuation: "explicit",
      continue: request.continue,
      intentKey: request.intentKey,
      intentLabel: request.intentLabel,
      onPlanChanged: request.onPlanChanged,
      placement: request.placement,
      targets: [targetFor(request.ownerPath, request.ownerName)],
    }),
    [targetFor],
  );

  const recoverFromError = useCallback(
    (error: unknown, request: AgentActorLateAccessRequest) =>
      recovery.recoverFromError(error, lateRequest(request)),
    [lateRequest, recovery],
  );
  const recoverFromBlock = useCallback(
    (request: AgentActorLateAccessRequest) =>
      recovery.request(lateRequest(request)),
    [lateRequest, recovery],
  );

  return {
    recovery,
    recoverFromBlock,
    recoverFromError,
    request,
    requesting: recovery.pending !== null,
  };
}

function intentLabel(intent: AgentActorAccessIntent) {
  if (intent.kind === "add-agent") return m.agent_actors_add();
  if (intent.kind === "delete-agent") return m.agent_actors_delete();
  if (intent.kind === "save-agent-catalog")
    return m.agent_actors_save_catalog();
  return m.agent_actors_edit();
}

function repositoryNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
