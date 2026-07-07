import type { FormEvent } from "react";
import { AlertTriangle, KeyRound, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GitAuthChallenge, GitRemoteAuthCredentials } from "../model";
import * as m from "@/paraglide/messages.js";

export interface GitRemoteAuthDialogProps {
  open: boolean;
  challenge: GitAuthChallenge | null;
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSaveAndRetry: (credentials: GitRemoteAuthCredentials) => Promise<void>;
}

export function GitRemoteAuthDialog({
  open,
  challenge,
  saving,
  error,
  onOpenChange,
  onSaveAndRetry,
}: GitRemoteAuthDialogProps) {
  const isHttps = challenge?.authMethod === "https";
  const remoteLabel = remoteDisplayLabel(challenge);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isHttps || saving) return;
    const formData = new FormData(event.currentTarget);
    void onSaveAndRetry({
      username: String(formData.get("username") ?? ""),
      password: String(formData.get("password") ?? ""),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[480px] overflow-hidden sm:max-w-[480px]">
        <DialogHeader className="min-w-0">
          <DialogTitle>{m.git_remote_auth_title()}</DialogTitle>
          <DialogDescription className="break-words">
            {m.git_remote_auth_description({
              operation: operationLabel(challenge?.operation ?? "unknown"),
            })}
          </DialogDescription>
        </DialogHeader>

        <form className="flex min-w-0 flex-col gap-4" onSubmit={submit}>
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">
              {m.git_remote_auth_remote_label()}
            </span>
            <span className="break-all text-muted-foreground">
              {remoteLabel}
            </span>
          </div>

          {challenge && !isHttps && (
            <Alert>
              <AlertTriangle />
              <AlertTitle>{m.git_remote_auth_ssh_title()}</AlertTitle>
              <AlertDescription>
                {m.git_remote_auth_ssh_description()}
              </AlertDescription>
            </Alert>
          )}

          {isHttps && (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="git-remote-auth-username">
                  {m.git_remote_auth_username_label()}
                </Label>
                <Input
                  id="git-remote-auth-username"
                  name="username"
                  required
                  disabled={saving}
                  autoComplete="username"
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="git-remote-auth-token">
                  {m.git_remote_auth_token_label()}
                </Label>
                <Input
                  id="git-remote-auth-token"
                  name="password"
                  type="password"
                  required
                  disabled={saving}
                  autoComplete="current-password"
                  aria-invalid={!!error}
                />
                <p className="text-xs text-muted-foreground">
                  {m.git_remote_auth_token_hint()}
                </p>
              </div>
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {challenge?.detail && (
            <details className="group min-w-0 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium">
                {m.git_remote_auth_detail_label()}
              </summary>
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background px-2 py-1">
                {challenge.detail}
              </pre>
            </details>
          )}

          <DialogFooter className="min-w-0">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {m.git_remote_auth_cancel()}
            </Button>
            {isHttps && (
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <RefreshCw
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : (
                  <KeyRound data-icon="inline-start" />
                )}
                {m.git_remote_auth_save_retry()}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function remoteDisplayLabel(challenge: GitAuthChallenge | null): string {
  if (!challenge) return m.git_remote_auth_unknown_remote();
  if (challenge.repository && challenge.host) {
    return `${challenge.host}/${challenge.repository}`;
  }
  if (challenge.remoteUrl) return challenge.remoteUrl;
  if (challenge.host) return challenge.host;
  return m.git_remote_auth_unknown_remote();
}

function operationLabel(operation: GitAuthChallenge["operation"]): string {
  switch (operation) {
    case "clone":
      return m.git_remote_auth_operation_clone();
    case "first-push":
      return m.git_remote_auth_operation_first_push();
    case "fetch":
      return m.git_remote_auth_operation_fetch();
    case "lfs-diagnostics":
      return m.git_remote_auth_operation_lfs_diagnostics();
    case "lfs-fetch-pull":
      return m.git_remote_auth_operation_lfs_fetch_pull();
    case "sync":
      return m.git_remote_auth_operation_sync();
    case "unknown":
      return m.git_remote_auth_operation_unknown();
  }
}
