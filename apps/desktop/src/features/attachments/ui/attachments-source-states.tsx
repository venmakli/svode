import { AlertTriangle } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

export function SourceError({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void | Promise<void>;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{m.attachments_load_error_title()}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={() => void onRetry()}>
          {m.attachments_retry()}
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function SourceRefreshDiagnostic({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void | Promise<void>;
}) {
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{m.attachments_refresh_error_title()}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={() => void onRetry()}>
          {m.attachments_retry()}
        </Button>
      </AlertAction>
    </Alert>
  );
}
