import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { GitRemoteAuthDialog } from "@/features/git";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRow,
} from "./settings-layout";
import { useStorageAction } from "./storage-actions";
import { StorageLfsPolicyRow } from "./storage-lfs-policy-row";

type RemoteDiagnostic = UseSpaceStorageSettingsResult["lfsRemoteDiagnostic"];

// The state of an enabled LFS strategy: its objects on this device, the
// repository LFS policy and, with a Git provider, the provider's remote.
export function StorageStateGroup({
  settings,
}: {
  settings: UseSpaceStorageSettingsResult;
}) {
  const [outputOpen, setOutputOpen] = useState(false);
  const [updating, runUpdate] = useStorageAction();
  const remote = settings.savedAssetsStrategy === "lfs-remote";
  const state = settings.lfsState;
  const ready = state === "ready";
  const pulling = state === "pulling";
  const diagnostic = settings.lfsRemoteDiagnostic;
  const checking = settings.lfsRemoteDiagnosticInFlight;
  const repairing = pulling || settings.lfsRepairInFlight;

  return (
    <>
      <SettingsGroup title={m.storage_state_group()}>
        {state === "n/a" ? null : (
          <SettingsItem
            key="objects"
            title={m.storage_lfs_objects()}
            description={
              pulling
                ? m.storage_repair_lfs_pulling()
                : ready
                  ? m.storage_lfs_objects_ready()
                  : remote
                    ? m.storage_lfs_objects_missing_remote()
                    : m.storage_lfs_objects_missing_s3()
            }
            actions={
              ready || pulling || !remote ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={repairing}
                  onClick={() => void settings.repairLfs()}
                >
                  {repairing ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : null}
                  {ready || pulling
                    ? m.storage_repair_lfs()
                    : m.storage_lfs_retry()}
                </Button>
              ) : null
            }
          />
        )}
        <StorageLfsPolicyRow
          key="policy"
          diagnostic={settings.lfsPolicyDiagnostic}
          loading={settings.lfsPolicyDiagnosticLoading}
          error={settings.lfsPolicyDiagnosticError}
          updating={updating}
          canUpdate={settings.canUpdateLfsPolicy}
          onUpdate={() => runUpdate(settings.updateLfsPolicy)}
          onRefresh={() => void settings.refreshLfsPolicyDiagnostic()}
        />
        {remote ? (
          <SettingsItem
            key="remote"
            title="Git LFS remote"
            description={
              <>
                <span className="block">
                  {checking
                    ? m.storage_lfs_remote_checking()
                    : ready && !diagnostic
                      ? m.storage_lfs_remote_ready_desc()
                      : remoteDiagnosticMessage(diagnostic)}
                </span>
                {diagnostic?.remoteUrl ? (
                  <span className="block break-all">
                    {diagnostic.remoteUrl}
                  </span>
                ) : null}
              </>
            }
            actions={
              <>
                <Badge variant={ready ? "secondary" : "outline"}>
                  {ready
                    ? m.storage_lfs_remote_ready()
                    : m.storage_lfs_remote_needs_setup()}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={checking}
                  onClick={() => void settings.diagnoseLfsRemote()}
                >
                  {checking ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : null}
                  {diagnostic?.reason === "auth-required" &&
                  diagnostic.authMethod === "https"
                    ? m.storage_lfs_remote_sign_in()
                    : m.storage_lfs_policy_refresh_action()}
                </Button>
              </>
            }
          />
        ) : null}
        {remote && diagnostic?.terminalCommand ? (
          <SettingsRow
            key="command"
            layout="stacked"
            label={m.storage_lfs_remote_command_label()}
          >
            <code className="block rounded-md bg-muted/50 px-3 py-2 font-mono text-xs break-all">
              {diagnostic.terminalCommand}
            </code>
          </SettingsRow>
        ) : null}
        {remote && diagnostic?.detail ? (
          <Collapsible
            key="output"
            open={outputOpen}
            onOpenChange={setOutputOpen}
          >
            <SettingsItem
              title={m.storage_lfs_remote_error_label()}
              actions={
                <SettingsDisclosureTrigger
                  open={outputOpen}
                  label={
                    outputOpen
                      ? m.storage_lfs_output_hide()
                      : m.storage_lfs_output_show()
                  }
                />
              }
            >
              <CollapsibleContent className="basis-full">
                <pre className="rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                  {diagnostic.detail}
                </pre>
              </CollapsibleContent>
            </SettingsItem>
          </Collapsible>
        ) : null}
      </SettingsGroup>
      <GitRemoteAuthDialog
        open={settings.lfsRemoteAuthOpen}
        challenge={settings.lfsRemoteAuthChallenge}
        saving={settings.lfsRemoteAuthSaving}
        error={settings.lfsRemoteAuthError}
        onOpenChange={settings.setLfsRemoteAuthDialogOpen}
        onSaveAndRetry={settings.saveLfsRemoteAuthAndRetry}
      />
    </>
  );
}

function remoteDiagnosticMessage(diagnostic: RemoteDiagnostic): string {
  if (!diagnostic) return m.storage_lfs_remote_setup_desc();
  switch (diagnostic.reason) {
    case "ready":
      return m.storage_lfs_remote_ready_desc();
    case "git-lfs-missing":
      return m.storage_lfs_remote_git_lfs_missing();
    case "remote-missing":
      return m.storage_lfs_remote_missing_remote();
    case "auth-required":
      return diagnostic.authMethod === "ssh"
        ? m.storage_lfs_remote_auth_required_ssh()
        : m.storage_lfs_remote_auth_required_https();
    case "lfs-unavailable":
      return m.storage_lfs_remote_lfs_unavailable();
    case "probe-failed":
      return m.storage_lfs_remote_probe_failed();
  }
}
