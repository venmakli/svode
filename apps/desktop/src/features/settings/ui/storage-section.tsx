import { useId } from "react";
import { CheckCircle2, LoaderCircle, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import type { AssetsStrategy } from "@/features/space";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { isLfsStorageStrategy } from "../model/storage-strategy";
import {
  LfsExtensionPicker,
  selectedLfsExtensionCount,
} from "./lfs-extension-picker";
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
  SettingsRow,
  SettingsRowSkeleton,
} from "./settings-layout";
import { SettingsSelect } from "./settings-select";
import { StorageApplyActions, useStorageAction } from "./storage-actions";
import { StorageS3Group } from "./storage-s3-group";
import { StorageStateGroup } from "./storage-state-group";

type StorageSettings = UseSpaceStorageSettingsResult;

const STRATEGIES: readonly AssetsStrategy[] = [
  "local",
  "in-git",
  "lfs-remote",
  "lfs-s3",
];

export function storageStrategyTitle(strategy: AssetsStrategy | null) {
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

function storageStrategyDescription(strategy: AssetsStrategy) {
  switch (strategy) {
    case "in-git":
      return m.storage_strategy_in_git_desc();
    case "lfs-remote":
      return m.storage_strategy_lfs_remote_desc();
    case "lfs-s3":
      return m.storage_strategy_lfs_s3_desc();
    case "local":
      return m.storage_strategy_local_desc();
  }
}

// The summary of a collapsed repository block: its strategy and whether it
// follows the project setting.
export function storageSummary(settings: StorageSettings): string | null {
  if (!settings.storageConfigLoaded || settings.inheritedFromProject)
    return null;
  const strategy = m.storage_summary_strategy({
    strategy: storageStrategyTitle(settings.savedAssetsStrategy),
  });
  if (settings.projectConfigStatus !== "loaded") return strategy;
  return `${strategy} · ${
    settings.projectDefaultApplied
      ? m.storage_summary_project_applied()
      : m.storage_summary_project_differs()
  }`;
}

// A space without its own repository uses the project strategy; its block
// only names it and points to the project.
export function StorageInheritedGroup({
  projectName,
  strategy,
  loading = false,
  onOpenProject,
}: {
  projectName: string;
  strategy: AssetsStrategy | null;
  loading?: boolean;
  onOpenProject: () => void;
}) {
  return (
    <SettingsGroup aria-busy={loading || undefined}>
      {loading ? (
        <SettingsRowSkeleton />
      ) : (
        <SettingsItem
          title={
            strategy
              ? m.storage_inline_title({
                  name: projectName,
                  strategy: storageStrategyTitle(strategy),
                })
              : m.storage_inline_title_unknown({ name: projectName })
          }
          description={m.storage_inline_description()}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenProject}
            >
              {m.storage_open_project()}
            </Button>
          }
        />
      )}
    </SettingsGroup>
  );
}

// The storage groups of the project or of one space repository.
export function StorageSettingsSection({
  settings,
  projectName,
  onOpenProject,
}: {
  settings: StorageSettings;
  projectName: string;
  onOpenProject: () => void;
}) {
  if (settings.storageConfigError)
    return (
      <SettingsGroup
        title={m.storage_strategy_group()}
        callout={
          <Alert>
            <AlertTitle>{m.storage_config_error_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.storage_config_error()}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={settings.retryStorageConfig}
                >
                  {m.app_retry()}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        }
      />
    );
  if (settings.storageConfigLoaded && settings.inheritedFromProject)
    return (
      <StorageInheritedGroup
        projectName={projectName}
        strategy={settings.savedAssetsStrategy}
        onOpenProject={onOpenProject}
      />
    );
  if (!settings.storageConfigLoaded || !settings.lfsAvailabilityLoaded)
    return (
      <SettingsGroup title={m.storage_strategy_group()} aria-busy>
        <SettingsRowSkeleton key="strategy" />
        <SettingsRowSkeleton key="lfs" />
      </SettingsGroup>
    );
  return (
    <>
      {settings.isRoot ? null : (
        <StorageProjectSettingGroup
          settings={settings}
          projectName={projectName}
        />
      )}
      <StorageStrategyGroup settings={settings} />
      {isLfsStorageStrategy(settings.assetsStrategy) ||
      settings.binaryRoutingStatus === "unsupported" ? (
        <StorageLfsRulesGroup settings={settings} />
      ) : null}
      {settings.assetsStrategy === "lfs-s3" ? (
        <StorageS3Group settings={settings} />
      ) : null}
      {isLfsStorageStrategy(settings.savedAssetsStrategy) ? (
        <StorageStateGroup settings={settings} />
      ) : null}
    </>
  );
}

// Why the project setting cannot be taken over, if it cannot.
function projectSettingBlock(settings: StorageSettings): string | null {
  const saved = settings.savedAssetsStrategy;
  const project = settings.projectAssetsStrategy;
  if (settings.binaryRoutingStatus === "unsupported")
    return m.storage_lfs_rules_unsupported();
  if (saved !== "local" && !(saved === "lfs-s3" && project === "lfs-s3"))
    return m.storage_strategy_locked();
  if (isLfsStorageStrategy(project) && !settings.lfsAvailable)
    return m.storage_strategy_needs_lfs();
  return null;
}

// A space repository keeps its own strategy until it takes over the
// project's one.
function StorageProjectSettingGroup({
  settings,
  projectName,
}: {
  settings: StorageSettings;
  projectName: string;
}) {
  const status = settings.projectConfigStatus;
  const applied = settings.projectDefaultApplied;
  const block = projectSettingBlock(settings);
  return (
    <SettingsGroup
      title={m.storage_project_setting_title()}
      aria-busy={status === "loading" || undefined}
    >
      {status === "loading" ? (
        <SettingsRowSkeleton />
      ) : status === "failed" ? (
        <SettingsItem
          title={m.storage_project_setting_owner({ name: projectName })}
          description={m.storage_project_setting_failed()}
        />
      ) : (
        <SettingsItem
          title={m.storage_project_setting_summary({
            name: projectName,
            strategy: storageStrategyTitle(settings.projectAssetsStrategy),
          })}
          description={
            applied
              ? undefined
              : (block ??
                (settings.projectAssetsStrategy === "lfs-s3"
                  ? m.storage_project_setting_s3_hint()
                  : m.storage_project_setting_differs_hint()))
          }
          actions={
            applied ? (
              <Badge variant="secondary">
                <CheckCircle2 data-icon="inline-start" />
                {m.storage_project_setting_applied()}
              </Badge>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  Boolean(block) ||
                  settings.applyingStrategy ||
                  settings.s3.pending ||
                  Boolean(settings.s3.editor)
                }
                onClick={() => void settings.useProjectStorageSetting()}
              >
                {m.storage_use_project_setting()}
              </Button>
            )
          }
        />
      )}
    </SettingsGroup>
  );
}

// The strategy draft applies in the last group it needs: here for In Git,
// in the LFS rules for Git LFS (Remote) and in S3 for Git LFS + S3.
function StorageStrategyGroup({ settings }: { settings: StorageSettings }) {
  const id = useId();
  const saved = settings.savedAssetsStrategy;
  const draft = settings.assetsStrategy;
  // Once a synced strategy is on, no other one is available yet.
  const locked = saved !== "local";
  const unsupported = settings.binaryRoutingStatus === "unsupported";
  const options = STRATEGIES.map((value) => {
    const unavailable = isLfsStorageStrategy(value) && !settings.lfsAvailable;
    return {
      value,
      label: storageStrategyTitle(value),
      description: unavailable
        ? m.storage_strategy_needs_lfs()
        : storageStrategyDescription(value),
      disabled: unavailable,
    };
  });
  return (
    <SettingsGroup
      title={m.storage_strategy_group()}
      description={m.storage_strategy_group_description()}
      aria-busy={settings.applyingStrategy || undefined}
    >
      <SettingsRow
        key="strategy"
        label={m.storage_strategy_label()}
        htmlFor={`${id}-strategy`}
        description={
          locked
            ? m.storage_strategy_locked()
            : unsupported
              ? m.storage_lfs_rules_unsupported()
              : draft !== saved
                ? m.storage_strategy_not_applied()
                : undefined
        }
      >
        <SettingsSelect
          id={`${id}-strategy`}
          className="w-48"
          value={draft}
          options={options}
          pending={
            settings.applyingStrategy && settings.strategyInFlight !== saved
          }
          disabled={
            locked ||
            unsupported ||
            settings.s3.pending ||
            Boolean(settings.s3.editor)
          }
          onValueChange={(value) =>
            void settings.selectStrategy(value as AssetsStrategy)
          }
        />
      </SettingsRow>
      <SettingsItem
        key="lfs"
        title="git-lfs"
        description={
          settings.lfsAvailable ? (
            settings.lfsVersion ? (
              m.storage_lfs_version({ version: settings.lfsVersion })
            ) : undefined
          ) : (
            <span className="wrap-anywhere">
              {m.storage_lfs_install_hint()}
            </span>
          )
        }
        actions={
          <Badge variant={settings.lfsAvailable ? "secondary" : "outline"}>
            {settings.lfsAvailable
              ? m.storage_lfs_available()
              : m.storage_lfs_missing()}
          </Badge>
        }
      />
      {draft !== saved && draft === "in-git" ? (
        <StorageApplyActions key="apply" settings={settings} />
      ) : null}
    </SettingsGroup>
  );
}

// Formats and size that route new files to Git LFS. Once the strategy is
// on, they are saved on their own.
function StorageLfsRulesGroup({ settings }: { settings: StorageSettings }) {
  const id = useId();
  const [saving, runSave] = useStorageAction();
  if (settings.binaryRoutingStatus === "unsupported")
    return (
      <SettingsGroup
        title={m.storage_lfs_rules_title()}
        callout={
          <Alert>
            <TriangleAlert />
            <AlertTitle>{m.storage_lfs_rules_unsupported()}</AlertTitle>
            <AlertDescription>
              {m.storage_lfs_rules_unsupported_hint({
                version: String(settings.binaryRoutingVersion ?? "?"),
              })}
            </AlertDescription>
          </Alert>
        }
      />
    );

  const issue = settings.binaryRoutingIssue;
  const formatsError =
    issue === "invalid-extension"
      ? m.storage_lfs_extensions_invalid()
      : issue === "protected-extension"
        ? m.storage_lfs_extensions_protected()
        : null;
  const sizeError =
    issue === "invalid-threshold" ? m.storage_lfs_threshold_invalid() : null;
  const disabled = settings.applyingStrategy;
  const enabled = settings.assetsStrategy === settings.savedAssetsStrategy;
  return (
    <SettingsGroup
      title={m.storage_lfs_rules_title()}
      description={m.storage_lfs_existing_unchanged()}
    >
      <SettingsRow
        key="formats"
        layout="stacked"
        label={
          <span id={`${id}-formats`}>{m.storage_lfs_extensions_label()}</span>
        }
        description={
          <span id={`${id}-formats-hint`}>
            {m.storage_lfs_extensions_hint()}{" "}
            {m.storage_lfs_extensions_selected({
              count: String(selectedLfsExtensionCount(settings.lfsExtensions)),
            })}
          </span>
        }
        error={formatsError}
        errorId={`${id}-formats-error`}
      >
        <LfsExtensionPicker
          value={settings.lfsExtensions}
          onChange={settings.setLfsExtensions}
          disabled={disabled}
          invalid={Boolean(formatsError)}
          labelledBy={`${id}-formats`}
          describedBy={
            formatsError
              ? `${id}-formats-hint ${id}-formats-error`
              : `${id}-formats-hint`
          }
        />
      </SettingsRow>
      <SettingsRow
        key="threshold"
        label={m.storage_lfs_threshold_label()}
        description={m.storage_lfs_threshold_hint()}
        htmlFor={`${id}-threshold-enabled`}
      >
        <Switch
          id={`${id}-threshold-enabled`}
          checked={settings.lfsThresholdEnabled}
          disabled={disabled}
          onCheckedChange={(checked) =>
            settings.setLfsThresholdEnabled(checked === true)
          }
        />
      </SettingsRow>
      {settings.lfsThresholdEnabled ? (
        <SettingsRow
          key="size"
          label={m.storage_lfs_threshold_input_label()}
          htmlFor={`${id}-threshold-size`}
          error={sizeError}
          errorId={`${id}-threshold-error`}
        >
          <InputGroup className="w-32">
            <InputGroupInput
              id={`${id}-threshold-size`}
              inputMode="decimal"
              value={settings.lfsThresholdMegabytes}
              disabled={disabled}
              aria-invalid={sizeError ? true : undefined}
              aria-describedby={sizeError ? `${id}-threshold-error` : undefined}
              onChange={(event) =>
                settings.setLfsThresholdMegabytes(event.target.value)
              }
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{m.storage_lfs_threshold_unit()}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </SettingsRow>
      ) : null}
      {enabled ? (
        <SettingsActions key="save">
          <Button
            type="button"
            disabled={
              !settings.canUpdateLfsPolicy || !settings.binaryRoutingChanged
            }
            onClick={() => runSave(settings.updateLfsPolicy)}
          >
            {saving ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.storage_lfs_rules_save()}
          </Button>
        </SettingsActions>
      ) : settings.assetsStrategy === "lfs-remote" ? (
        <StorageApplyActions key="apply" settings={settings} />
      ) : null}
    </SettingsGroup>
  );
}

export function StorageStrategyConfirmDialog({
  settings,
}: {
  settings: StorageSettings;
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
