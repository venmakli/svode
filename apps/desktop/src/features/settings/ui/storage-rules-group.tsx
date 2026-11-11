import { useId, type ReactNode } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { ExtensionPicker, selectedExtensionCount } from "./extension-picker";
import { SettingsActions, SettingsGroup, SettingsRow } from "./settings-layout";
import { StorageApplyActions, useStorageAction } from "./storage-actions";

type StorageSettings = UseSpaceStorageSettingsResult;

interface StorageRulesCopy {
  title: string;
  description: string;
  unsupported: string;
  formatsHint: string;
  thresholdHint: string;
}

// Formats and size that route new files to Git LFS. Once the strategy is
// on, they are saved on their own.
export function StorageLfsRulesGroup({
  settings,
}: {
  settings: StorageSettings;
}) {
  const enabled = settings.assetsStrategy === settings.savedAssetsStrategy;
  return (
    <StorageRulesGroup
      settings={settings}
      copy={{
        title: m.storage_lfs_rules_title(),
        description: m.storage_lfs_existing_unchanged(),
        unsupported: m.storage_lfs_rules_unsupported(),
        formatsHint: m.storage_lfs_extensions_hint(),
        thresholdHint: m.storage_lfs_threshold_hint(),
      }}
      extensions={settings.lfsExtensions}
      onExtensionsChange={settings.setLfsExtensions}
      save={
        enabled
          ? {
              disabled:
                !settings.canUpdateLfsPolicy || !settings.binaryRoutingChanged,
              run: settings.updateLfsPolicy,
            }
          : null
      }
      footer={
        !enabled && settings.assetsStrategy === "lfs-remote" ? (
          <StorageApplyActions key="apply" settings={settings} />
        ) : null
      }
    />
  );
}

// Formats and size that keep files of the local strategy on this device;
// the size threshold is the one Git LFS uses.
export function StorageLocalRulesGroup({
  settings,
}: {
  settings: StorageSettings;
}) {
  return (
    <StorageRulesGroup
      settings={settings}
      copy={{
        title: m.storage_local_rules_title(),
        description: m.storage_local_existing_unchanged(),
        unsupported: m.storage_local_rules_unsupported(),
        formatsHint: m.storage_local_extensions_hint(),
        thresholdHint: m.storage_local_threshold_hint(),
      }}
      extensions={settings.localExtensions}
      onExtensionsChange={settings.setLocalExtensions}
      save={{
        disabled: !settings.canUpdateLocalRules,
        run: settings.updateLocalRules,
      }}
      footer={null}
    />
  );
}

function StorageRulesGroup({
  settings,
  copy,
  extensions,
  onExtensionsChange,
  save,
  footer,
}: {
  settings: StorageSettings;
  copy: StorageRulesCopy;
  extensions: string;
  onExtensionsChange: (value: string) => void;
  // The group's own save; `null` while a strategy draft applies them.
  save: { disabled: boolean; run: () => Promise<void> } | null;
  footer: ReactNode;
}) {
  const id = useId();
  const [saving, runSave] = useStorageAction();
  if (settings.binaryRoutingStatus === "unsupported")
    return (
      <SettingsGroup
        title={copy.title}
        callout={
          <Alert>
            <TriangleAlert />
            <AlertTitle>{copy.unsupported}</AlertTitle>
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
  return (
    <SettingsGroup title={copy.title} description={copy.description}>
      <SettingsRow
        key="formats"
        layout="stacked"
        label={
          <span id={`${id}-formats`}>{m.storage_lfs_extensions_label()}</span>
        }
        description={
          <span id={`${id}-formats-hint`}>
            {copy.formatsHint}{" "}
            {m.storage_lfs_extensions_selected({
              count: String(selectedExtensionCount(extensions)),
            })}
          </span>
        }
        error={formatsError}
        errorId={`${id}-formats-error`}
      >
        <ExtensionPicker
          value={extensions}
          onChange={onExtensionsChange}
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
        description={copy.thresholdHint}
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
      {save ? (
        <SettingsActions key="save">
          <Button
            type="button"
            disabled={save.disabled}
            onClick={() => runSave(save.run)}
          >
            {saving ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.storage_lfs_rules_save()}
          </Button>
        </SettingsActions>
      ) : (
        footer
      )}
    </SettingsGroup>
  );
}
