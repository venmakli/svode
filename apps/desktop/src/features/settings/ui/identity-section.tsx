import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  avatarColorFromEmail,
  type FanoutPreviewEntry,
  type RepoIdentityResult,
} from "@/features/identity";
import { AlertTriangle, ChevronRight, RotateCcw, X } from "lucide-react";
import {
  fanoutEntryHasOverride,
  fanoutEntrySummarySource,
  identitySummary,
  identityText,
  type IdentitySummarySource,
} from "../model";

interface Props {
  mode: "summary" | "detail";
  isRoot: boolean;
  scopeName: string;
  repoIdentity: RepoIdentityResult | null;
  identityName: string;
  identityEmail: string;
  setIdentityName: (v: string) => void;
  setIdentityEmail: (v: string) => void;
  identityFormError: string | null;
  savingIdentity: boolean;
  canResetIdentity: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onReset: () => void;
  fanoutEnabled: boolean;
  setFanoutEnabled: (v: boolean) => void;
  fanoutPreview: FanoutPreviewEntry[];
  fanoutSelected: Record<string, boolean>;
  setFanoutSelected: (next: Record<string, boolean>) => void;
}

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

function scopeDescription(isRoot: boolean, scopeName: string): string {
  return isRoot
    ? m.settings_git_identity_project_scope({ name: scopeName })
    : m.settings_git_identity_repository_scope({ name: scopeName });
}

function editDescription(isRoot: boolean): string {
  return isRoot
    ? m.settings_git_identity_project_edit_hint()
    : m.settings_git_identity_repository_edit_hint();
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

function selectedFanoutCount(
  entries: FanoutPreviewEntry[],
  selected: Record<string, boolean>,
): number {
  return entries.filter((entry) => selected[entry.spacePath]).length;
}

export function IdentitySection({
  mode,
  isRoot,
  scopeName,
  repoIdentity,
  identityName,
  identityEmail,
  setIdentityName,
  setIdentityEmail,
  identityFormError,
  savingIdentity,
  canResetIdentity,
  onEdit,
  onCancelEdit,
  onSave,
  onReset,
  fanoutEnabled,
  setFanoutEnabled,
  fanoutPreview,
  fanoutSelected,
  setFanoutSelected,
}: Props) {
  const summary = identitySummary(repoIdentity, isRoot);
  const showFanout = isRoot && fanoutPreview.length > 0;
  const fanoutCount = selectedFanoutCount(fanoutPreview, fanoutSelected);
  const identityTitle =
    summary.identity?.name ||
    summary.identity?.email ||
    m.settings_git_identity_missing_title();
  const summaryEmail = summary.identity?.email ?? null;
  const identityActionLabel = editActionLabel(isRoot, summary.source);

  function setAllFanoutSelected(checked: boolean) {
    const next: Record<string, boolean> = {};
    for (const entry of fanoutPreview) {
      next[entry.spacePath] = checked;
    }
    setFanoutSelected(next);
  }

  const sectionHeader = (
    <div className="flex flex-col gap-1">
      <Label className="text-sm font-medium">
        {m.settings_git_identity_title()}
      </Label>
      <p className="text-xs text-muted-foreground">
        {scopeDescription(isRoot, scopeName)}
      </p>
    </div>
  );

  if (mode === "summary") {
    return (
      <section className="flex min-w-0 flex-col gap-3">
        {sectionHeader}

        <button
          type="button"
          className="flex w-full min-w-0 flex-col gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted sm:flex-row sm:items-start sm:justify-between"
          aria-label={`${identityTitle}: ${identityActionLabel}`}
          onClick={onEdit}
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Avatar size="sm" className="mt-0.5">
              <AvatarFallback
                style={{
                  backgroundColor: avatarColorFromEmail(
                    summary.identity?.email,
                  ),
                }}
                className="text-xs font-medium text-white"
              >
                {summary.initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {identityTitle}
                </span>
                <Badge
                  variant={sourceBadgeVariant(summary.source)}
                  className="shrink-0 text-xs font-normal"
                >
                  {sourceLabel(summary.source)}
                </Badge>
              </div>
              {summaryEmail && (
                <p className="truncate text-xs text-muted-foreground">
                  {summaryEmail}
                </p>
              )}
            </div>
          </div>
          <span className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
            {identityActionLabel}
            <ChevronRight className="size-3" />
          </span>
        </button>

        {summary.source === "missing" && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{m.settings_git_identity_missing_title()}</AlertTitle>
            <AlertDescription>
              {m.settings_git_identity_missing_description()}
            </AlertDescription>
          </Alert>
        )}
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      {sectionHeader}

      <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground">
          {editDescription(isRoot)}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-identity-name" className="text-xs">
              {m.settings_git_identity_name_override_label()}
            </Label>
            <Input
              id="ws-identity-name"
              value={identityName}
              onChange={(e) => setIdentityName(e.target.value)}
              placeholder={m.settings_git_identity_name_placeholder()}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-identity-email" className="text-xs">
              {m.settings_git_identity_email_override_label()}
            </Label>
            <Input
              id="ws-identity-email"
              type="email"
              value={identityEmail}
              onChange={(e) => setIdentityEmail(e.target.value)}
              placeholder={m.settings_git_identity_email_placeholder()}
              className="h-8 text-sm"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {m.settings_git_identity_override_helper()}
        </p>
        {summary.source === "missing" && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{m.settings_git_identity_missing_title()}</AlertTitle>
            <AlertDescription>
              {m.settings_git_identity_missing_edit_description()}
            </AlertDescription>
          </Alert>
        )}
        {identityFormError && (
          <p className="text-xs text-destructive">{identityFormError}</p>
        )}

        {showFanout && (
          <NestedRepositoriesSection
            enabled={fanoutEnabled}
            entries={fanoutPreview}
            selected={fanoutSelected}
            selectedCount={fanoutCount}
            setEnabled={setFanoutEnabled}
            setSelected={setFanoutSelected}
            setAllSelected={setAllFanoutSelected}
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSave} disabled={savingIdentity}>
            {m.identity_save()}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancelEdit}
            disabled={savingIdentity}
          >
            <X data-icon="inline-start" />
            {m.settings_cancel()}
          </Button>
          {canResetIdentity && (
            <Button
              type="button"
              variant="outline"
              onClick={onReset}
              disabled={savingIdentity}
            >
              <RotateCcw data-icon="inline-start" />
              {m.settings_git_identity_reset_global()}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function NestedRepositoriesSection({
  enabled,
  entries,
  selected,
  selectedCount,
  setEnabled,
  setSelected,
  setAllSelected,
}: {
  enabled: boolean;
  entries: FanoutPreviewEntry[];
  selected: Record<string, boolean>;
  selectedCount: number;
  setEnabled: (value: boolean) => void;
  setSelected: (next: Record<string, boolean>) => void;
  setAllSelected: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <label className="flex cursor-pointer items-start gap-2">
        <Checkbox
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(checked === true)}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-1 text-sm">
          <span>{m.settings_git_identity_nested_checkbox()}</span>
          <span className="text-xs text-muted-foreground">
            {m.settings_git_identity_nested_description()}
          </span>
        </span>
      </label>

      {enabled && (
        <div className="flex flex-col gap-2 pl-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              {m.settings_git_identity_nested_count({
                selected: selectedCount,
                total: entries.length,
              })}
            </p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setAllSelected(true)}
              >
                {m.settings_git_identity_nested_select_all()}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setAllSelected(false)}
              >
                {m.settings_git_identity_nested_clear()}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => {
              const checked = selected[entry.spacePath] ?? true;
              const source = fanoutEntrySummarySource(entry);
              const currentIdentity = identityText(
                entry.currentEffective ?? entry.currentLocal ?? null,
              );
              return (
                <label
                  key={entry.spacePath}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(c) =>
                      setSelected({
                        ...selected,
                        [entry.spacePath]: c === true,
                      })
                    }
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-medium">
                        {entry.spaceName}
                      </span>
                      <Badge
                        variant="secondary"
                        className="text-xs font-normal"
                      >
                        {sourceLabel(source)}
                      </Badge>
                      {fanoutEntryHasOverride(entry) && (
                        <Badge
                          variant="outline"
                          className="text-xs font-normal"
                        >
                          {m.settings_git_identity_fanout_will_replace()}
                        </Badge>
                      )}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {currentIdentity
                        ? m.settings_git_identity_nested_current({
                            identity: currentIdentity,
                          })
                        : m.settings_git_identity_nested_current_missing()}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
