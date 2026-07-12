import * as m from "@/paraglide/messages.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CheckCircle2, Loader2 } from "lucide-react";
import { GitRemoteAuthDialog } from "@/features/git";
import type { AssetsStrategy, LfsState, SpaceGitType } from "@/features/space";
import { isLfsStorageStrategy } from "../model/storage-strategy";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { StorageLfsPolicyWarning } from "./storage-lfs-policy-warning";

interface StorageSettingsSectionProps {
  gitType: SpaceGitType | null;
  activeRootName: string | null;
  settings: UseSpaceStorageSettingsResult;
}

export function StorageSettingsSection({
  gitType,
  activeRootName,
  settings,
}: StorageSettingsSectionProps) {
  const isRepoSpace =
    !settings.isRoot && (gitType === "independent" || gitType === "submodule");

  if (gitType === "inline") {
    return (
      <div className="space-y-3 max-w-md">
        <div>
          <Label className="text-sm font-medium">{m.storage_title()}</Label>
        </div>
        <div className="rounded-md border p-3 space-y-1">
          <p className="text-sm">
            {m.storage_inherited_from_project({
              name: activeRootName ?? "",
              strategy: settings.savedAssetsStrategy,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {m.storage_inherited_hint()}
          </p>
        </div>
      </div>
    );
  }

  const storageOptions: {
    value: AssetsStrategy;
    title: string;
    desc: string;
    needsLfs: boolean;
  }[] = [
    {
      value: "local",
      title: m.storage_strategy_local_title(),
      desc: m.storage_strategy_local_desc(),
      needsLfs: false,
    },
    {
      value: "in-git",
      title: m.storage_strategy_in_git_title(),
      desc: m.storage_strategy_in_git_desc(),
      needsLfs: false,
    },
    {
      value: "lfs-remote",
      title: m.storage_strategy_lfs_remote_title(),
      desc: m.storage_strategy_lfs_remote_desc(),
      needsLfs: true,
    },
    {
      value: "lfs-s3",
      title: m.storage_strategy_lfs_s3_title(),
      desc: m.storage_strategy_lfs_s3_desc(),
      needsLfs: true,
    },
  ];
  const canSaveVisibleS3 =
    settings.savedAssetsStrategy === "lfs-s3"
      ? !settings.applyingStrategy && settings.canSaveS3
      : settings.canApplyStrategy;
  const lfsStatePanelStrategy =
    settings.storageConfigLoaded &&
    isLfsStorageStrategy(settings.savedAssetsStrategy)
      ? settings.savedAssetsStrategy
      : null;

  const storageControls = (
    <div className="space-y-4 max-w-md">
      <div>
        <Label className="text-sm font-medium">{m.storage_title()}</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          {m.storage_scope_hint()}
        </p>
      </div>
      {lfsStatePanelStrategy && (
        <StorageLfsPolicyWarning
          diagnostic={settings.lfsPolicyDiagnostic}
          loading={settings.lfsPolicyDiagnosticLoading}
          error={settings.lfsPolicyDiagnosticError}
          updating={
            settings.applyingStrategy &&
            settings.strategyInFlight === settings.savedAssetsStrategy
          }
          canUpdate={settings.canUpdateLfsPolicy}
          onUpdate={() => void settings.updateLfsPolicy()}
          onRefresh={() => void settings.refreshLfsPolicyDiagnostic()}
        />
      )}
      <RadioGroup
        value={settings.assetsStrategy}
        onValueChange={(value) =>
          void settings.selectStrategy(value as AssetsStrategy)
        }
        className="gap-3"
      >
        {storageOptions.map((option) => {
          const migrationDisabled =
            settings.savedAssetsStrategy !== "local" &&
            option.value !== settings.savedAssetsStrategy;
          const disabled =
            settings.applyingStrategy ||
            migrationDisabled ||
            (option.needsLfs && !settings.lfsAvailable);
          return (
            <label
              key={option.value}
              title={
                migrationDisabled
                  ? m.storage_migration_unsupported_hint()
                  : undefined
              }
              className={`flex items-start gap-3 rounded-md border p-3 ${
                disabled
                  ? "opacity-60 cursor-not-allowed"
                  : "cursor-pointer hover:bg-accent/50"
              } ${
                settings.assetsStrategy === option.value ? "border-primary" : ""
              }`}
            >
              {settings.strategyInFlight === option.value ? (
                <Loader2 className="mt-0.5 size-4 animate-spin text-muted-foreground" />
              ) : (
                <RadioGroupItem
                  value={option.value}
                  id={`storage-${option.value}`}
                  disabled={disabled}
                  className="mt-0.5"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{option.title}</span>
                  {option.needsLfs &&
                    (settings.lfsAvailable ? (
                      <Badge
                        variant="secondary"
                        className="text-xs font-normal"
                      >
                        <span className="text-green-600 mr-1">&#10003;</span>
                        {settings.lfsVersion
                          ? `${m.storage_lfs_available()} (${settings.lfsVersion})`
                          : m.storage_lfs_available()}
                      </Badge>
                    ) : (
                      <Badge
                        variant="destructive"
                        className="text-xs font-normal"
                      >
                        <span className="mr-1">&#10005;</span>
                        {m.storage_lfs_missing()}
                      </Badge>
                    ))}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.desc}
                </p>
              </div>
            </label>
          );
        })}
      </RadioGroup>
      {!settings.lfsAvailable && (
        <p className="text-xs text-muted-foreground">
          {m.storage_lfs_install_hint()}
        </p>
      )}
      {settings.savedAssetsStrategy !== "local" && (
        <p className="text-xs text-muted-foreground">
          {m.storage_migration_unsupported_hint()}
        </p>
      )}
      {settings.assetsStrategy !== settings.savedAssetsStrategy &&
        settings.assetsStrategy !== "lfs-s3" && (
          <div>
            <Button
              type="button"
              size="sm"
              onClick={() => void settings.applySelectedStrategy()}
              disabled={!settings.canApplyStrategy}
            >
              {settings.applyingStrategy && (
                <Loader2 className="mr-1 size-3 animate-spin" />
              )}
              {m.storage_apply_action()}
            </Button>
          </div>
        )}
      {settings.assetsStrategy === "lfs-s3" && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="s3-endpoint" className="text-xs">
              {m.storage_s3_endpoint()}
            </Label>
            <Input
              id="s3-endpoint"
              value={settings.s3Endpoint}
              onChange={(event) => settings.setS3Endpoint(event.target.value)}
              placeholder="https://s3.amazonaws.com"
              className="h-8 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="s3-bucket" className="text-xs">
                {m.storage_s3_bucket()}
              </Label>
              <Input
                id="s3-bucket"
                value={settings.s3Bucket}
                onChange={(event) => settings.setS3Bucket(event.target.value)}
                placeholder="my-assets"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="s3-region" className="text-xs">
                {m.storage_s3_region()}
              </Label>
              <Input
                id="s3-region"
                value={settings.s3Region}
                onChange={(event) => settings.setS3Region(event.target.value)}
                placeholder="us-east-1"
                className="h-8 text-sm"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="s3-prefix" className="text-xs">
              {m.storage_s3_prefix()}
            </Label>
            <Input
              id="s3-prefix"
              value={settings.s3Prefix}
              onChange={(event) => settings.setS3Prefix(event.target.value)}
              placeholder="bigquest/root"
              className="h-8 text-sm font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              {m.storage_s3_prefix_hint()}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="s3-access" className="text-xs">
              {m.storage_s3_access_key()}
            </Label>
            <Input
              id="s3-access"
              value={settings.s3AccessKey}
              onChange={(event) => settings.setS3AccessKey(event.target.value)}
              placeholder={
                settings.hasSavedS3Credentials ? m.storage_s3_creds_saved() : ""
              }
              className="h-8 text-sm font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="s3-secret" className="text-xs">
              {m.storage_s3_secret_key()}
            </Label>
            <Input
              id="s3-secret"
              type="password"
              value={settings.s3SecretKey}
              onChange={(event) => settings.setS3SecretKey(event.target.value)}
              placeholder={
                settings.hasSavedS3Credentials ? m.storage_s3_creds_saved() : ""
              }
              className="h-8 text-sm font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void settings.testS3()}
              disabled={!settings.canTestS3}
            >
              {settings.s3TestState === "testing" && (
                <Loader2 className="mr-1 size-3 animate-spin" />
              )}
              {m.storage_s3_check()}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void settings.saveS3()}
              disabled={!canSaveVisibleS3}
            >
              {settings.applyingStrategy &&
                settings.strategyInFlight === "lfs-s3" && (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                )}
              {m.storage_s3_save()}
            </Button>
            {settings.s3TestState === "ok" && (
              <span className="text-xs text-green-600">
                {m.storage_s3_test_ok()}
              </span>
            )}
            {settings.s3TestState === "fail" && (
              <span className="text-xs text-destructive">
                {settings.s3TestError ?? m.storage_s3_test_failed()}
              </span>
            )}
          </div>
          {settings.hasSavedS3Credentials && (
            <p className="text-xs text-muted-foreground">
              {m.storage_s3_creds_hint()}
            </p>
          )}
        </div>
      )}

      {lfsStatePanelStrategy && (
        <>
          <LfsStatePanel
            state={settings.lfsState}
            strategy={lfsStatePanelStrategy}
            repairing={settings.lfsRepairInFlight}
            remoteDiagnostic={settings.lfsRemoteDiagnostic}
            remoteChecking={settings.lfsRemoteDiagnosticInFlight}
            onDiagnoseRemote={settings.diagnoseLfsRemote}
            onRepair={settings.repairLfs}
          />
          <GitRemoteAuthDialog
            open={settings.lfsRemoteAuthOpen}
            challenge={settings.lfsRemoteAuthChallenge}
            saving={settings.lfsRemoteAuthSaving}
            error={settings.lfsRemoteAuthError}
            onOpenChange={settings.setLfsRemoteAuthDialogOpen}
            onSaveAndRetry={settings.saveLfsRemoteAuthAndRetry}
          />
        </>
      )}

      {settings.inlineSpaceNames.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {m.storage_used_by_inline_spaces({
            names: settings.inlineSpaceNames.join(", "),
          })}
        </p>
      )}
    </div>
  );

  if (isRepoSpace) {
    return (
      <div className="flex max-w-md flex-col gap-4">
        <RepositoryProjectSetting
          activeRootName={activeRootName}
          settings={settings}
        />
        {storageControls}
      </div>
    );
  }

  return storageControls;
}

function RepositoryProjectSetting({
  activeRootName,
  settings,
}: {
  activeRootName: string | null;
  settings: UseSpaceStorageSettingsResult;
}) {
  const projectName = activeRootName ?? "";
  const isS3ProjectDefault = settings.projectAssetsStrategy === "lfs-s3";
  const showS3Hint = isS3ProjectDefault && !settings.projectDefaultApplied;
  const projectSettingDisabled =
    settings.applyingStrategy || (isS3ProjectDefault && !settings.lfsAvailable);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm font-medium">
            {m.storage_project_setting_title()}
          </Label>
          <p className="text-xs text-muted-foreground">
            {m.storage_project_setting_summary({
              name: projectName,
              strategy: settings.projectAssetsStrategy,
            })}
          </p>
        </div>
        {settings.projectDefaultApplied ? (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <CheckCircle2 className="size-3" />
            {m.storage_project_setting_applied()}
          </Badge>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void settings.useProjectStorageSetting()}
            disabled={projectSettingDisabled}
          >
            {settings.applyingStrategy && (
              <Loader2 className="mr-1 size-3 animate-spin" />
            )}
            {m.storage_use_project_setting()}
          </Button>
        )}
      </div>
      {!settings.projectDefaultApplied && (
        <p className="text-xs text-muted-foreground">
          {m.storage_project_setting_differs_hint()}
        </p>
      )}
      {showS3Hint && (
        <p className="text-xs text-muted-foreground">
          {m.storage_project_setting_s3_hint()}
        </p>
      )}
    </div>
  );
}

export function StorageStrategyConfirmDialog({
  settings,
}: {
  settings: UseSpaceStorageSettingsResult;
}) {
  return (
    <AlertDialog
      open={settings.pendingStrategy !== null}
      onOpenChange={(open) => {
        if (!open) settings.cancelPendingStrategy();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.storage_confirm_title()}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            {m.storage_confirm_description({
              strategy: storageStrategyTitle(settings.pendingStrategy),
            })}
            <span className="block">{m.storage_confirm_files()}</span>
            {(settings.pendingStrategy === "lfs-remote" ||
              settings.pendingStrategy === "lfs-s3") && (
              <span className="block">
                {m.storage_confirm_repository_lfs_policy()}
              </span>
            )}
            {settings.pendingAssetCount > 0 && (
              <span className="mt-2 block text-destructive">
                {m.storage_confirm_existing_assets({
                  count: String(settings.pendingAssetCount),
                })}
              </span>
            )}
            <span className="block">{m.storage_confirm_locked()}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={settings.cancelPendingStrategy}>
            {m.project_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void settings.confirmPendingStrategy()}
          >
            {settings.pendingAssetCount > 0
              ? m.storage_confirm_existing_assets_action()
              : m.storage_confirm_action()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function storageStrategyTitle(strategy: AssetsStrategy | null) {
  switch (strategy) {
    case "in-git":
      return m.storage_strategy_in_git_title();
    case "lfs-remote":
      return m.storage_strategy_lfs_remote_title();
    case "lfs-s3":
      return m.storage_strategy_lfs_s3_title();
    case "local":
      return m.storage_strategy_local_title();
    default:
      return "";
  }
}

function LfsStatePanel({
  state,
  strategy,
  repairing,
  remoteDiagnostic,
  remoteChecking,
  onDiagnoseRemote,
  onRepair,
}: {
  state: LfsState;
  strategy: "lfs-remote" | "lfs-s3";
  repairing: boolean;
  remoteDiagnostic: UseSpaceStorageSettingsResult["lfsRemoteDiagnostic"];
  remoteChecking: boolean;
  onDiagnoseRemote: () => void;
  onRepair: () => void;
}) {
  if (state === "n/a") return null;
  if (strategy === "lfs-remote") {
    return (
      <RemoteLfsStatePanel
        state={state}
        diagnostic={remoteDiagnostic}
        checking={remoteChecking}
        repairing={repairing}
        onDiagnose={onDiagnoseRemote}
        onRepair={onRepair}
      />
    );
  }
  const missingTitle = m.storage_lfs_banner_missing_s3_title();
  const missingDesc = m.storage_lfs_banner_missing_s3_desc();

  if (state === "pulling") {
    return (
      <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span>{m.storage_repair_lfs_pulling()}</span>
      </div>
    );
  }
  if (state === "missing-creds") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
        <p className="text-sm font-medium">{missingTitle}</p>
        <p className="text-xs text-muted-foreground">{missingDesc}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRepair}
          disabled={repairing}
        >
          {repairing && <Loader2 className="mr-1 size-3 animate-spin" />}
          {m.storage_lfs_retry()}
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-md border p-3 flex items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">
        {m.storage_lfs_banner_ready()}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRepair}
        disabled={repairing}
      >
        {repairing && <Loader2 className="mr-1 size-3 animate-spin" />}
        {m.storage_repair_lfs()}
      </Button>
    </div>
  );
}

function RemoteLfsStatePanel({
  state,
  diagnostic,
  checking,
  repairing,
  onDiagnose,
  onRepair,
}: {
  state: LfsState;
  diagnostic: UseSpaceStorageSettingsResult["lfsRemoteDiagnostic"];
  checking: boolean;
  repairing: boolean;
  onDiagnose: () => void;
  onRepair: () => void;
}) {
  if (state === "pulling") {
    return (
      <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span>{m.storage_repair_lfs_pulling()}</span>
      </div>
    );
  }

  const ready = state === "ready";
  const message =
    ready && !diagnostic
      ? m.storage_lfs_remote_ready_desc()
      : remoteDiagnosticMessage(diagnostic);
  const borderClass = ready
    ? "border-primary/40 bg-primary/5"
    : "border-destructive/40 bg-destructive/5";

  return (
    <div className={`rounded-md border p-3 space-y-3 ${borderClass}`}>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {ready
            ? m.storage_lfs_remote_ready_title()
            : m.storage_lfs_remote_setup_title()}
        </p>
        <p className="text-xs text-muted-foreground">{message}</p>
      </div>

      <div className="space-y-1 text-xs">
        <RemoteRequirement
          checked={
            ready && !diagnostic
              ? true
              : remoteRequirementState(diagnostic, "remote")
          }
          label={m.storage_lfs_remote_req_remote()}
        />
        <RemoteRequirement
          checked={
            ready && !diagnostic
              ? true
              : remoteRequirementState(diagnostic, "provider")
          }
          label={m.storage_lfs_remote_req_provider()}
        />
        <RemoteRequirement
          checked={
            ready && !diagnostic
              ? true
              : remoteRequirementState(diagnostic, "auth")
          }
          label={m.storage_lfs_remote_req_auth()}
        />
      </div>

      {diagnostic?.remoteUrl && (
        <p className="text-xs text-muted-foreground break-all">
          {diagnostic.remoteUrl}
        </p>
      )}

      {checking && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <span>{m.storage_lfs_remote_checking()}</span>
        </div>
      )}

      {diagnostic?.terminalCommand && (
        <div className="space-y-1">
          <p className="text-xs font-medium">
            {m.storage_lfs_remote_command_label()}
          </p>
          <code className="block rounded border bg-background px-2 py-1 text-xs break-all">
            {diagnostic.terminalCommand}
          </code>
        </div>
      )}

      {diagnostic?.detail && (
        <div className="space-y-1">
          <p className="text-xs font-medium">
            {m.storage_lfs_remote_error_label()}
          </p>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border bg-background px-2 py-1 text-xs">
            {diagnostic.detail}
          </pre>
        </div>
      )}

      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={ready ? onRepair : onDiagnose}
          disabled={ready ? repairing : checking}
        >
          {(ready ? repairing : checking) && (
            <Loader2 className="mr-1 size-3 animate-spin" />
          )}
          {remoteActionLabel({ ready, diagnostic })}
        </Button>
      </div>
    </div>
  );
}

function remoteActionLabel({
  ready,
  diagnostic,
}: {
  ready: boolean;
  diagnostic: UseSpaceStorageSettingsResult["lfsRemoteDiagnostic"];
}): string {
  if (ready) return m.storage_repair_lfs();
  if (
    diagnostic?.reason === "auth-required" &&
    diagnostic.authMethod === "https"
  ) {
    return m.storage_lfs_remote_sign_in();
  }
  return m.storage_lfs_retry();
}

function RemoteRequirement({
  checked,
  label,
}: {
  checked: boolean | null;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      {checked === true ? (
        <CheckCircle2 className="size-3 text-green-600" />
      ) : checked === false ? (
        <span className="flex size-3 items-center justify-center text-destructive">
          x
        </span>
      ) : (
        <span className="size-3 rounded-full border" />
      )}
      <span>{label}</span>
    </div>
  );
}

function remoteRequirementState(
  diagnostic: UseSpaceStorageSettingsResult["lfsRemoteDiagnostic"],
  requirement: "remote" | "provider" | "auth",
): boolean | null {
  if (!diagnostic) return null;
  if (diagnostic.reason === "ready") return true;
  if (requirement === "remote") {
    if (diagnostic.reason === "remote-missing") return false;
    return diagnostic.remoteUrl ? true : null;
  }
  if (requirement === "provider") {
    if (diagnostic.reason === "lfs-unavailable") return false;
    return null;
  }
  if (diagnostic.reason === "auth-required") return false;
  return null;
}

function remoteDiagnosticMessage(
  diagnostic: UseSpaceStorageSettingsResult["lfsRemoteDiagnostic"],
): string {
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
