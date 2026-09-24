import { useId, useRef } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/shared/lib/utils";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import {
  ownerKey,
  sameSource,
  sourceKey,
  type AppVariableEntry,
} from "../model/app-variables";
import { AppVariableFields } from "./app-variable-fields";
import {
  SettingsActions,
  SettingsGroup,
  SettingsRow,
  SettingsRowSkeleton,
} from "./settings-layout";
import { SettingsSelect, type SettingsSelectOption } from "./settings-select";
import { StorageApplyActions, useStorageAction } from "./storage-actions";

type Role = "accessKey" | "secretKey";

const textInput = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;

// Where a Secret lives and what keeps it from working, in one line.
function secretDescription(entry: AppVariableEntry) {
  const global = entry.source.owner.scope === "global";
  return [
    global ? m.variables_global() : entry.ownerLabel,
    global ? null : entry.mode === "git" ? "Git" : m.variables_local(),
    entry.collision ? m.variables_conflict() : null,
    entry.hasValue ? null : m.variables_unset_here(),
  ]
    .filter(Boolean)
    .join(" · ");
}

// The S3 target and its two Secret keys. Before S3 is on, the group ends
// with the action that applies the strategy; once it is on, with its save.
export function StorageS3Group({
  settings,
}: {
  settings: UseSpaceStorageSettingsResult;
}) {
  const { s3 } = settings;
  const id = useId();
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const [saving, runSave] = useStorageAction();
  const busy = settings.applyingStrategy || s3.pending;
  const locked = busy || Boolean(s3.editor);
  const enabled = settings.savedAssetsStrategy === "lfs-s3";
  const canSave =
    !settings.applyingStrategy &&
    settings.canSaveS3 &&
    settings.binaryRoutingStatus !== "unsupported" &&
    settings.binaryRoutingIssue === null;
  const testing = s3.testState === "testing";
  const secrets = s3.entries.filter(
    (item, index, entries) =>
      item.kind === "secret" &&
      entries.findIndex(
        (other) =>
          sameSource(other.source, item.source) && other.kind === "secret",
      ) === index,
  );

  function returnFocus() {
    returnTarget.current?.focus();
  }
  function cancel() {
    if (s3.cancel()) requestAnimationFrame(returnFocus);
  }

  function roleRow(role: Role, label: string) {
    const source = s3.bindings[role];
    const name = source.name;
    const selectedKey = name ? sourceKey(source) : "";
    const entry =
      s3.entries.find(
        (item) => sameSource(item.source, source) && item.kind === "secret",
      ) ?? s3.entries.find((item) => sameSource(item.source, source));
    const missing = Boolean(
      name && (entry?.kind !== "secret" || !entry.hasValue || entry.collision),
    );
    const errorId = `${id}-${role}-error`;
    const options: SettingsSelectOption[] = [
      ...(name && entry?.kind !== "secret"
        ? [
            {
              value: selectedKey,
              label: name,
              description: entry
                ? m.storage_s3_secret_not_secret()
                : m.storage_s3_secret_not_found(),
              disabled: true,
            },
          ]
        : []),
      ...secrets.map((item) => ({
        value: sourceKey(item.source),
        label: item.name,
        description: secretDescription(item),
      })),
    ];
    return (
      <SettingsRow
        key={role}
        label={label}
        htmlFor={`${id}-${role}`}
        description={!missing && entry ? secretDescription(entry) : undefined}
        error={
          missing ? m.storage_s3_secret_missing({ role: label, name }) : null
        }
        errorId={errorId}
      >
        <SettingsSelect
          id={`${id}-${role}`}
          className="w-56"
          value={selectedKey}
          options={options}
          placeholder={m.storage_s3_secret_placeholder()}
          disabled={locked || options.length === 0}
          invalid={missing}
          describedBy={missing ? errorId : undefined}
          onValueChange={(value) => {
            const selected = s3.entries.find(
              (item) => sourceKey(item.source) === value,
            );
            if (selected) s3.select(role, selected.source);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          aria-label={`${label}: ${m.storage_s3_create_secret()}`}
          onClick={(event) => {
            returnTarget.current = event.currentTarget;
            s3.begin(role, false);
          }}
        >
          {m.storage_s3_create_secret()}
        </Button>
        {entry?.kind === "secret" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={locked}
            aria-label={`${label}: ${m.settings_variables_edit()}`}
            onClick={(event) => {
              returnTarget.current = event.currentTarget;
              s3.begin(role, true);
            }}
          >
            {m.settings_variables_edit()}
          </Button>
        ) : null}
      </SettingsRow>
    );
  }

  // The fixed Secret editor opens under its role and returns focus to the
  // button that opened it.
  function editor(role: Role, label: string) {
    const current = s3.editor;
    if (current?.role !== role) return null;
    const usage = s3.editedEntry?.usedIn ?? [];
    return (
      <form
        key={`${role}-editor`}
        aria-label={`${label}: ${
          current.draft.editing
            ? m.settings_variables_edit()
            : m.storage_s3_create_secret()
        }`}
        className="flex min-w-0 flex-col bg-muted/40"
        onSubmit={(event) => {
          event.preventDefault();
          void s3.submit().then((saved) => {
            if (saved) requestAnimationFrame(returnFocus);
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }}
      >
        <AppVariableFields
          layout="rows"
          draft={current.draft}
          disabled={busy}
          onChange={s3.updateDraft}
          fixedKind="secret"
          collisionAlternatives={s3.collisionAlternatives}
          nameError={s3.collision ? m.app_variables_collision() : null}
          usage={
            usage.length
              ? `${m.variables_known_usage()}: ${usage
                  .map(
                    ({ ownerDirectory, referenceName }) =>
                      `${ownerDirectory} · ${referenceName}`,
                  )
                  .join(", ")}`
              : null
          }
        />
        <Separator />
        {s3.stale || s3.editorError ? (
          <div className="px-4 pt-3">
            <Alert variant="destructive">
              <AlertDescription>
                <p className="wrap-anywhere">
                  {s3.stale ? m.variables_changed_outside() : s3.editorError}
                </p>
                {s3.stale ? (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void s3.reviewLatest()}
                    >
                      {m.variables_retry_draft()}
                    </Button>
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        <SettingsActions>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={cancel}
          >
            {m.settings_cancel()}
          </Button>
          <Button type="submit" disabled={busy || !s3.canSubmit}>
            {s3.pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.storage_s3_save_secret()}
          </Button>
        </SettingsActions>
      </form>
    );
  }

  const check = (
    <>
      {s3.testState === "idle" ? null : (
        <span
          role="status"
          className={cn(
            "mr-auto text-sm wrap-anywhere",
            s3.testState === "fail"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {testing
            ? m.storage_s3_testing()
            : s3.testState === "ok"
              ? m.storage_s3_test_ok()
              : s3.testError}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy || !settings.canTestS3}
        onClick={() => void settings.testS3()}
      >
        {testing ? (
          <LoaderCircle data-icon="inline-start" className="animate-spin" />
        ) : null}
        {m.storage_s3_check()}
      </Button>
    </>
  );

  const accessKey = m.storage_s3_access_key();
  const secretKey = m.storage_s3_secret_key();
  return (
    <SettingsGroup
      title={m.storage_s3_group()}
      description={m.storage_s3_group_description()}
      aria-busy={!s3.loaded || busy || undefined}
      callout={
        <>
          {s3.loadError || s3.variables.loadError ? (
            <Alert>
              <AlertTitle>{m.storage_s3_load_error_title()}</AlertTitle>
              <AlertDescription>
                <p className="wrap-anywhere">
                  {s3.loadError || m.storage_s3_catalog_error()}
                </p>
                {s3.saved?.error ? (
                  <p className="wrap-anywhere">{s3.saved.error}</p>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={s3.retry}
                  >
                    {m.app_retry()}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {s3.variables.catalog?.owners
            .filter((owner) => owner.error)
            .map((owner) => (
              <Alert key={ownerKey(owner.owner)}>
                <AlertTitle>{m.variables_owner_error_title()}</AlertTitle>
                <AlertDescription>
                  <p className="wrap-anywhere">
                    {owner.owner.scope === "global"
                      ? m.variables_global()
                      : owner.label}
                    : {owner.error}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void s3.variables.recover(owner.owner).catch(s3.retry)
                      }
                    >
                      {m.variables_recovery()}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={s3.retry}
                    >
                      {m.app_retry()}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ))}
          {enabled && s3.loaded && !s3.saved?.ready ? (
            <Alert>
              <TriangleAlert />
              <AlertTitle>{m.storage_s3_keys_needed_title()}</AlertTitle>
              <AlertDescription>
                <p className="wrap-anywhere">
                  {s3.saved?.bindings
                    ? s3.saved.error
                    : m.storage_s3_setup_secrets()}
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      }
    >
      <SettingsRow
        key="endpoint"
        layout="stacked"
        label={m.storage_s3_endpoint()}
        htmlFor={`${id}-endpoint`}
      >
        <Input
          id={`${id}-endpoint`}
          value={settings.s3Endpoint}
          onChange={(event) => settings.setS3Endpoint(event.target.value)}
          placeholder="https://s3.amazonaws.com"
          disabled={busy}
          {...textInput}
        />
      </SettingsRow>
      <SettingsRow
        key="bucket"
        label={m.storage_s3_bucket()}
        htmlFor={`${id}-bucket`}
      >
        <Input
          id={`${id}-bucket`}
          className="w-72 max-w-full"
          value={settings.s3Bucket}
          onChange={(event) => settings.setS3Bucket(event.target.value)}
          placeholder="my-assets"
          disabled={busy}
          {...textInput}
        />
      </SettingsRow>
      <SettingsRow
        key="region"
        label={m.storage_s3_region()}
        htmlFor={`${id}-region`}
      >
        <Input
          id={`${id}-region`}
          className="w-72 max-w-full"
          value={settings.s3Region}
          onChange={(event) => settings.setS3Region(event.target.value)}
          placeholder="us-east-1"
          disabled={busy}
          {...textInput}
        />
      </SettingsRow>
      <SettingsRow
        key="prefix"
        label={m.storage_s3_prefix()}
        description={m.storage_s3_prefix_hint()}
        htmlFor={`${id}-prefix`}
      >
        <Input
          id={`${id}-prefix`}
          className="w-72 max-w-full"
          value={settings.s3Prefix}
          onChange={(event) => settings.setS3Prefix(event.target.value)}
          disabled={busy}
          {...textInput}
        />
      </SettingsRow>
      {s3.loaded
        ? [
            roleRow("accessKey", accessKey),
            editor("accessKey", accessKey),
            roleRow("secretKey", secretKey),
            editor("secretKey", secretKey),
          ]
        : [
            <SettingsRowSkeleton key="access-loading" />,
            <SettingsRowSkeleton key="secret-loading" />,
          ]}
      {enabled ? (
        <SettingsActions key="actions">
          {check}
          <Button
            type="button"
            disabled={busy || !canSave}
            onClick={() => runSave(settings.saveS3)}
          >
            {saving ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.settings_save()}
          </Button>
        </SettingsActions>
      ) : (
        <StorageApplyActions key="actions" settings={settings}>
          {check}
        </StorageApplyActions>
      )}
    </SettingsGroup>
  );
}
