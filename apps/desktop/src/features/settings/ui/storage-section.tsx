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
import type { AssetsStrategy, LfsState, SpaceGitType } from "@/features/space";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";

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

  const storageControls = (
    <div className="space-y-4 max-w-md">
      <div>
        <Label className="text-sm font-medium">{m.storage_title()}</Label>
      </div>
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
              disabled={settings.applyingStrategy || !settings.canSaveS3}
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

      {(settings.savedAssetsStrategy === "lfs-s3" ||
        settings.savedAssetsStrategy === "lfs-remote") && (
        <LfsStatePanel
          state={settings.lfsState}
          strategy={settings.savedAssetsStrategy}
          repairing={settings.lfsRepairInFlight}
          onRepair={settings.repairLfs}
        />
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
          <AlertDialogDescription>
            {m.storage_confirm_description({
              strategy: settings.pendingStrategy ?? "",
            })}
            {settings.pendingAssetCount > 0 && (
              <span className="mt-2 block text-destructive">
                {m.storage_confirm_existing_assets({
                  count: String(settings.pendingAssetCount),
                })}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={settings.cancelPendingStrategy}>
            {m.project_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void settings.confirmPendingStrategy()}
          >
            {m.storage_confirm_action()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LfsStatePanel({
  state,
  strategy,
  repairing,
  onRepair,
}: {
  state: LfsState;
  strategy: "lfs-remote" | "lfs-s3";
  repairing: boolean;
  onRepair: () => void;
}) {
  if (state === "n/a") return null;
  const missingTitle =
    strategy === "lfs-s3"
      ? m.storage_lfs_banner_missing_s3_title()
      : m.storage_lfs_banner_missing_remote_title();
  const missingDesc =
    strategy === "lfs-s3"
      ? m.storage_lfs_banner_missing_s3_desc()
      : m.storage_lfs_banner_missing_remote_desc();

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
