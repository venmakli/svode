import { useCallback, useEffect, useRef, useState } from "react";

import { useRepositoryAccess } from "@/features/git";

import type { AgentActorRow } from "../model/agent-actor-types";
import { useActorAccessPreflight } from "./use-actor-access-preflight";

export type AgentActorAccessIntent =
  | { kind: "add-agent"; ownerPath: string }
  | { kind: "edit-agent"; ownerPath: string; row: AgentActorRow }
  | { kind: "delete-agent"; ownerPath: string; row: AgentActorRow }
  | { kind: "save-agent-catalog"; ownerPath: string };

interface PendingAccessIntent {
  id: number;
  intent: AgentActorAccessIntent;
}

export function useAgentActorAccessCoordinator({
  launchSpacePath,
  onContinue,
}: {
  launchSpacePath: string;
  onContinue(intent: AgentActorAccessIntent): void;
}) {
  const [targetPath, setTargetPath] = useState(launchSpacePath);
  const [pending, setPending] = useState<PendingAccessIntent | null>(null);
  const nextRequestIdRef = useRef(1);
  const handledRequestIdRef = useRef(0);
  const access = useRepositoryAccess(targetPath);

  const continueAndReset = useCallback(
    (intent: AgentActorAccessIntent) => {
      setPending(null);
      setTargetPath(launchSpacePath);
      onContinue(intent);
    },
    [launchSpacePath, onContinue],
  );
  const preflight = useActorAccessPreflight<AgentActorAccessIntent>({
    error: access.error,
    snapshot: access.snapshot,
    verifying: access.verifying,
    onContinue: continueAndReset,
    onVerify: access.verify,
  });
  const closePreflight = preflight.close;
  const requestPreflight = preflight.request;

  useEffect(() => {
    if (
      !pending ||
      handledRequestIdRef.current === pending.id ||
      access.spacePath !== pending.intent.ownerPath ||
      (!access.snapshot && !access.error && !access.verifying)
    ) {
      return;
    }

    handledRequestIdRef.current = pending.id;
    requestPreflight(pending.intent);
  }, [
    access.error,
    access.snapshot,
    access.spacePath,
    access.verifying,
    pending,
    requestPreflight,
  ]);

  const request = useCallback((intent: AgentActorAccessIntent) => {
    setPending({ id: nextRequestIdRef.current++, intent });
    setTargetPath(intent.ownerPath);
  }, []);
  const close = useCallback(() => {
    closePreflight();
    setPending(null);
    setTargetPath(launchSpacePath);
  }, [closePreflight, launchSpacePath]);

  return {
    access,
    close,
    intent: preflight.intent,
    request,
    verify: preflight.verify,
  };
}
