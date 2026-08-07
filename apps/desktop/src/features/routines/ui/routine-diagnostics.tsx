import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import * as m from "@/paraglide/messages.js";

import type { RoutineDiagnostic } from "../model/types";

export function RoutineDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly RoutineDiagnostic[];
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{m.routines_invalid_definition_title()}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${diagnostic.field ?? ""}:${index}`}>
              {diagnostic.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
