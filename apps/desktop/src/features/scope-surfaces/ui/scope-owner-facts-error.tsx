import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

export function ScopeOwnerFactsError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {error}
        <Button onClick={onRetry}>{m.attachments_retry()}</Button>
      </AlertDescription>
    </Alert>
  );
}
