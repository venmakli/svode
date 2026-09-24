import { useId, useLayoutEffect, useRef } from "react";
import { AlertTriangle, LoaderCircle, RotateCcw } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { humanAvatar, type FanoutPreviewEntry } from "@/features/identity";
import type { SpaceSettingsIdentity } from "../hooks/use-space-settings-identity";
import {
  fanoutEntryHasOverride,
  fanoutEntrySummarySource,
  identitySummary,
  identityText,
  type IdentitySummarySource,
} from "../model";
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
  SettingsRow,
  SettingsRows,
  SettingsRowSkeleton,
} from "./settings-layout";

function sourceLabel(source: IdentitySummarySource): string {
  switch (source) {
    case "global":
      return m.settings_git_identity_source_global();
    case "project":
      return m.settings_git_identity_source_project();
    case "repository":
      return m.settings_git_identity_source_repository();
    case "partial":
      return m.settings_git_identity_source_partial();
    case "missing":
      return m.settings_git_identity_source_missing();
  }
}

function sourceBadgeVariant(source: IdentitySummarySource) {
  if (source === "missing") return "destructive";
  if (source === "global") return "secondary";
  return "outline";
}

function editActionLabel(
  isRoot: boolean,
  source: IdentitySummarySource,
): string {
  if (source !== "missing") return m.settings_git_identity_edit();
  return isRoot
    ? m.settings_git_identity_set_project()
    : m.settings_git_identity_set_repository();
}

// The commit author of one repository: a summary row that expands in place
// into its editor. Closing the editor returns focus to the row.
export function IdentitySection({
  isRoot,
  identity,
}: {
  isRoot: boolean;
  identity: SpaceSettingsIdentity;
}) {
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const editing = identity.identityEditing;
  const saving = identity.savingIdentity;
  const summary = identitySummary(identity.repoIdentity, isRoot);
  const missing = identity.identityLoaded && summary.source === "missing";
  const showFanout = isRoot && identity.fanoutPreview.length > 0;

  useLayoutEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    editButton.current?.focus();
  }, [editing]);

  function closing(action: () => unknown) {
    return () => {
      restoreFocus.current = true;
      void action();
    };
  }

  let row;
  if (!identity.identityLoaded) {
    row = <SettingsRowSkeleton />;
  } else if (editing) {
    row = (
      <form
        aria-label={m.settings_git_identity_title()}
        className="flex min-w-0 flex-col bg-muted/40"
        onSubmit={(event) => {
          event.preventDefault();
          closing(identity.handleSaveIdentity)();
        }}
      >
        <SettingsRows>
          <SettingsRow
            key="name"
            label={m.identity_name_label()}
            htmlFor={`${id}-name`}
            data-disabled={saving || undefined}
          >
            <Input
              id={`${id}-name`}
              className="w-72 max-w-full"
              autoFocus
              value={identity.identityName}
              disabled={saving}
              placeholder={m.settings_git_identity_name_placeholder()}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => identity.setIdentityName(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            key="email"
            label={m.identity_email_label()}
            htmlFor={`${id}-email`}
            data-disabled={saving || undefined}
          >
            <Input
              id={`${id}-email`}
              type="email"
              className="w-72 max-w-full"
              value={identity.identityEmail}
              disabled={saving}
              placeholder={m.settings_git_identity_email_placeholder()}
              autoComplete="off"
              onChange={(event) =>
                identity.setIdentityEmail(event.target.value)
              }
            />
          </SettingsRow>
          {showFanout ? (
            <SettingsRow
              key="fanout"
              label={m.settings_git_identity_nested_checkbox()}
              description={m.settings_git_identity_nested_description()}
              htmlFor={`${id}-fanout`}
              data-disabled={saving || undefined}
            >
              <Switch
                id={`${id}-fanout`}
                checked={identity.fanoutEnabled}
                disabled={saving}
                onCheckedChange={identity.setFanoutEnabled}
              />
            </SettingsRow>
          ) : null}
          {showFanout && identity.fanoutEnabled ? (
            <NestedRepositories
              key="repositories"
              id={id}
              entries={identity.fanoutPreview}
              selected={identity.fanoutSelected}
              disabled={saving}
              onSelectedChange={identity.setFanoutSelected}
            />
          ) : null}
        </SettingsRows>
        <Separator />
        {identity.identityFormError ? (
          <FieldError className="px-4 pt-3">
            {identity.identityFormError}
          </FieldError>
        ) : null}
        <SettingsActions>
          {identity.canResetIdentity ? (
            <Button
              type="button"
              variant="destructive"
              className="mr-auto"
              disabled={saving}
              onClick={closing(identity.handleResetIdentity)}
            >
              <RotateCcw data-icon="inline-start" />
              {m.settings_git_identity_reset_global()}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={closing(identity.handleCancelIdentityEdit)}
          >
            {m.settings_cancel()}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.identity_save()}
          </Button>
        </SettingsActions>
      </form>
    );
  } else {
    const avatar = humanAvatar(summary.identity);
    const name = summary.identity?.name?.trim();
    const email = summary.identity?.email?.trim();
    // Without an author the source is the row's title; the callout above
    // explains the consequence.
    const title = name || email || sourceLabel(summary.source);
    const actionLabel = editActionLabel(isRoot, summary.source);
    row = (
      <SettingsItem
        media={
          <Avatar size="sm">
            <AvatarFallback
              style={avatar.style}
              className="text-xs font-medium"
            >
              {avatar.initials}
            </AvatarFallback>
          </Avatar>
        }
        title={title}
        description={name && email ? email : undefined}
        actions={
          <>
            {name || email ? (
              <Badge variant={sourceBadgeVariant(summary.source)}>
                {sourceLabel(summary.source)}
              </Badge>
            ) : null}
            <Button
              ref={editButton}
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${title}: ${actionLabel}`}
              onClick={identity.handleStartIdentityEdit}
            >
              {actionLabel}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <SettingsGroup
      title={m.settings_git_identity_title()}
      description={
        isRoot
          ? m.settings_git_identity_project_scope()
          : m.settings_git_identity_repository_scope()
      }
      aria-busy={!identity.identityLoaded || saving}
      callout={
        missing ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{m.settings_git_identity_missing_title()}</AlertTitle>
            <AlertDescription>
              {editing
                ? m.settings_git_identity_missing_edit_description()
                : m.settings_git_identity_missing_description()}
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      {row}
    </SettingsGroup>
  );
}

// Nested repositories the project author is also written to on save.
function NestedRepositories({
  id,
  entries,
  selected,
  disabled,
  onSelectedChange,
}: {
  id: string;
  entries: FanoutPreviewEntry[];
  selected: Record<string, boolean>;
  disabled: boolean;
  onSelectedChange: (next: Record<string, boolean>) => void;
}) {
  const count = entries.filter((entry) => selected[entry.spacePath]).length;
  function setAll(checked: boolean) {
    const next: Record<string, boolean> = {};
    for (const entry of entries) next[entry.spacePath] = checked;
    onSelectedChange(next);
  }
  return (
    <div
      role="group"
      aria-label={m.settings_git_identity_nested_checkbox()}
      className="flex min-w-0 flex-col gap-3 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {m.settings_git_identity_nested_count({
            selected: count,
            total: entries.length,
          })}
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => setAll(true)}
          >
            {m.settings_git_identity_nested_select_all()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => setAll(false)}
          >
            {m.settings_git_identity_nested_clear()}
          </Button>
        </div>
      </div>
      <FieldGroup className="gap-3">
        {entries.map((entry, index) => {
          const checkboxId = `${id}-repository-${index}`;
          const current = identityText(
            entry.currentEffective ?? entry.currentLocal ?? null,
          );
          return (
            <Field key={entry.spacePath} orientation="horizontal">
              <Checkbox
                id={checkboxId}
                checked={selected[entry.spacePath] ?? true}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onSelectedChange({
                    ...selected,
                    [entry.spacePath]: checked === true,
                  })
                }
              />
              <FieldContent>
                <FieldLabel
                  htmlFor={checkboxId}
                  className="flex-wrap font-normal"
                >
                  <span className="wrap-break-word">{entry.spaceName}</span>
                  <Badge variant="secondary">
                    {sourceLabel(fanoutEntrySummarySource(entry))}
                  </Badge>
                  {fanoutEntryHasOverride(entry) ? (
                    <Badge variant="outline">
                      {m.settings_git_identity_fanout_will_replace()}
                    </Badge>
                  ) : null}
                </FieldLabel>
                <FieldDescription className="wrap-anywhere">
                  {current
                    ? m.settings_git_identity_nested_current({
                        identity: current,
                      })
                    : m.settings_git_identity_nested_current_missing()}
                </FieldDescription>
              </FieldContent>
            </Field>
          );
        })}
      </FieldGroup>
    </div>
  );
}
