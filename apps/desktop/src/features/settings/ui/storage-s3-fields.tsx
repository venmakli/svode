import { useRef } from "react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { sourceKey, sameSource, ownerKey } from "../model/app-variables";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { AppVariableFields } from "./app-variable-fields";

export function StorageS3Fields({
  settings,
  canSave,
}: {
  settings: UseSpaceStorageSettingsResult;
  canSave: boolean;
}) {
  const { s3 } = settings;
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const disabled = settings.applyingStrategy || s3.pending;
  function returnFocus() {
    returnTarget.current?.focus();
  }
  const roles = [
    { key: "accessKey" as const, label: m.storage_s3_access_key() },
    { key: "secretKey" as const, label: m.storage_s3_secret_key() },
  ];
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="s3-endpoint">
            {m.storage_s3_endpoint()}
          </FieldLabel>
          <Input
            id="s3-endpoint"
            value={settings.s3Endpoint}
            onChange={(e) => settings.setS3Endpoint(e.target.value)}
            placeholder="https://s3.amazonaws.com"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="s3-bucket">{m.storage_s3_bucket()}</FieldLabel>
          <Input
            id="s3-bucket"
            value={settings.s3Bucket}
            onChange={(e) => settings.setS3Bucket(e.target.value)}
            placeholder="my-assets"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="s3-region">{m.storage_s3_region()}</FieldLabel>
          <Input
            id="s3-region"
            value={settings.s3Region}
            onChange={(e) => settings.setS3Region(e.target.value)}
            placeholder="us-east-1"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="s3-prefix">{m.storage_s3_prefix()}</FieldLabel>
          <Input
            id="s3-prefix"
            value={settings.s3Prefix}
            onChange={(e) => settings.setS3Prefix(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>{m.storage_s3_prefix_hint()}</FieldDescription>
        </Field>
        {(s3.loadError || s3.variables.loadError) && (
          <Alert variant="destructive">
            <AlertDescription>
              {s3.loadError || m.storage_s3_catalog_error()}
              {s3.saved?.error && (
                <span className="break-words">{s3.saved.error}</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={s3.retry}
              >
                {m.storage_lfs_retry()}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {s3.variables.catalog?.owners
          .filter((owner) => owner.error)
          .map((owner) => (
            <Alert key={ownerKey(owner.owner)} variant="destructive">
              <AlertDescription>
                <span className="break-words">
                  {owner.label}: {owner.error}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    void s3.variables.recover(owner.owner).catch(s3.retry)
                  }
                >
                  {m.variables_recovery()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={s3.retry}
                >
                  {m.storage_lfs_retry()}
                </Button>
              </AlertDescription>
            </Alert>
          ))}
        {!s3.loaded ? (
          <div
            role="status"
            aria-label={m.app_variables_loading()}
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            {settings.savedAssetsStrategy === "lfs-s3" && !s3.saved?.ready && (
              <Alert>
                <AlertDescription>
                  {s3.saved?.bindings
                    ? s3.saved.error
                    : m.storage_s3_setup_secrets()}
                </AlertDescription>
              </Alert>
            )}
            {roles.map(({ key, label }) => {
              const source = s3.bindings[key];
              const name = source.name;
              const selectedKey = name ? sourceKey(source) : "";
              const entry =
                s3.entries.find(
                  (item) =>
                    sameSource(item.source, source) && item.kind === "secret",
                ) ?? s3.entries.find((item) => sameSource(item.source, source));
              const missing = Boolean(
                name &&
                (entry?.kind !== "secret" ||
                  !entry.hasValue ||
                  entry.collision),
              );
              const active = s3.editor?.role === key;
              return (
                <Field key={key} data-invalid={missing}>
                  <FieldLabel htmlFor={`s3-${key}-source`}>{label}</FieldLabel>
                  <Select
                    value={selectedKey}
                    onValueChange={(value) => {
                      const selected = s3.entries.find(
                        (item) => sourceKey(item.source) === value,
                      );
                      if (selected) s3.select(key, selected.source);
                    }}
                    disabled={disabled || !!s3.editor}
                  >
                    <SelectTrigger
                      id={`s3-${key}-source`}
                      aria-invalid={missing}
                      aria-describedby={missing ? `s3-${key}-error` : undefined}
                      className="w-full min-w-0"
                    >
                      <SelectValue
                        placeholder={m.settings_variables_select()}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {name && entry?.kind !== "secret" && (
                          <SelectItem value={selectedKey} disabled>
                            {name}
                          </SelectItem>
                        )}
                        {s3.entries
                          .filter(
                            (item, index, entries) =>
                              item.kind === "secret" &&
                              entries.findIndex(
                                (other) =>
                                  sameSource(other.source, item.source) &&
                                  other.kind === "secret",
                              ) === index,
                          )
                          .map((item) => (
                            <SelectItem
                              key={sourceKey(item.source)}
                              value={sourceKey(item.source)}
                              className="break-all"
                            >
                              {item.name} · {item.ownerLabel} ·{" "}
                              {item.mode === "git"
                                ? "Git"
                                : m.variables_local()}
                              {item.collision &&
                                ` · ${m.app_variables_collision()}`}
                              {!item.hasValue &&
                                ` · ${m.variables_unset_here()}`}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {missing ? (
                    <FieldError id={`s3-${key}-error`}>
                      {m.storage_s3_secret_missing({ role: label, name })}
                    </FieldError>
                  ) : (
                    entry && (
                      <FieldDescription>
                        {m.storage_s3_secret_available()}
                      </FieldDescription>
                    )
                  )}
                  {
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled || !!s3.editor}
                        onClick={(e) => {
                          returnTarget.current = e.currentTarget;
                          s3.begin(key, false);
                        }}
                      >
                        {m.storage_s3_create_secret()}
                      </Button>
                      {entry?.kind === "secret" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={disabled || !!s3.editor}
                          onClick={(e) => {
                            returnTarget.current = e.currentTarget;
                            s3.begin(key, true);
                          }}
                        >
                          {m.settings_variables_edit()}
                        </Button>
                      )}
                    </div>
                  }
                  {active && s3.editor && (
                    <form
                      className="flex min-w-0 flex-col gap-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void s3.submit().then((saved) => {
                          if (saved) requestAnimationFrame(returnFocus);
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (s3.cancel()) requestAnimationFrame(returnFocus);
                        }
                      }}
                    >
                      {!!s3.editedEntry?.usedIn.length && (
                        <FieldDescription className="break-all">
                          {m.app_variables_shared_usage()}{" "}
                          {s3.editedEntry.usedIn
                            .map(
                              (usage) =>
                                `${usage.ownerDirectory} · ${usage.referenceName}`,
                            )
                            .join(", ")}
                        </FieldDescription>
                      )}
                      <AppVariableFields
                        draft={s3.editor.draft}
                        disabled={disabled}
                        onChange={s3.updateDraft}
                        compact
                        fixedKind="secret"
                        collisionAlternatives={s3.collisionAlternatives}
                      />
                      {(s3.collision || s3.stale || s3.editorError) && (
                        <FieldError>
                          {s3.collision
                            ? m.app_variables_collision()
                            : s3.stale
                              ? m.app_variables_stale()
                              : s3.editorError}
                        </FieldError>
                      )}
                      {s3.stale && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => void s3.reviewLatest()}
                        >
                          {m.variables_retry_draft()}
                        </Button>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="submit"
                          size="sm"
                          disabled={disabled || !s3.canSubmit}
                        >
                          {s3.pending
                            ? m.app_variables_saving()
                            : m.storage_s3_save_secret()}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => {
                            if (s3.cancel()) requestAnimationFrame(returnFocus);
                          }}
                        >
                          {m.project_cancel()}
                        </Button>
                      </div>
                    </form>
                  )}
                </Field>
              );
            })}
            <FieldDescription>
              {m.storage_s3_binding_draft_hint()}
            </FieldDescription>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled || !canSave}
            onClick={() => void settings.saveS3()}
          >
            {m.storage_s3_save()}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !settings.canTestS3}
            onClick={() => void settings.testS3()}
          >
            {m.storage_s3_check()}
          </Button>
        </div>
        {s3.testState !== "idle" && (
          <div role="status">
            {s3.testState === "testing" ? (
              m.storage_s3_testing()
            ) : s3.testState === "ok" ? (
              m.storage_s3_test_ok()
            ) : (
              <FieldError>{s3.testError}</FieldError>
            )}
          </div>
        )}
      </FieldGroup>
    </fieldset>
  );
}
