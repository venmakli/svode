import { LoaderCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import * as m from "@/paraglide/messages.js";

import type {
  AgentActorAdapterDiagnostic,
  AgentAdapterId,
} from "../model/agent-actor-types";
import {
  agentActorDiagnosticStatus,
  agentActorDiagnosticSummary,
} from "./agent-actor-copy";

/**
 * The agent of an Actor's binding with the check of its readiness on this
 * device. Its setting values and mode are kept as they are.
 */
export function AgentAdapterCard({
  agent,
  checkDisabled,
  diagnostic,
  label,
  pending,
  readOnly,
  onCheck,
}: {
  agent: AgentAdapterId;
  checkDisabled: boolean;
  diagnostic?: AgentActorAdapterDiagnostic;
  label: string;
  pending: boolean;
  readOnly: boolean;
  onCheck(): void;
}) {
  const summary = agentActorDiagnosticSummary(diagnostic);
  return (
    <Card size="sm" data-agent-adapter={agent}>
      <CardHeader>
        <CardTitle className="truncate">{label}</CardTitle>
        <CardDescription aria-live="polite">
          {agentActorDiagnosticStatus(diagnostic, pending)}
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={m.agent_actors_check_named({ client: label })}
            disabled={checkDisabled || readOnly}
            onClick={onCheck}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.agent_actors_check()}
          </Button>
        </CardAction>
      </CardHeader>
      {summary ? (
        <CardContent>
          <Alert variant="destructive" data-agent-adapter-diagnostic>
            <AlertTitle>{summary}</AlertTitle>
            {diagnostic?.message ? (
              <AlertDescription>
                {m.agent_actors_diagnostic_raw_detail()}: {diagnostic.message}
              </AlertDescription>
            ) : null}
          </Alert>
        </CardContent>
      ) : null}
    </Card>
  );
}
