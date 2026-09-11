import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AppVariableFields } from "./app-variable-fields";
import { useVariableCatalogEditor } from "../hooks/use-variable-catalog-editor";
import { sourceKey, sameSource, ownerKey } from "../model/app-variables";
import type { SettingsLeaveGuard } from "../model/settings-destination";

interface Props {
  projectPath?: string;
  spaceId?: string | null;
  registerLeaveGuard?: (guard: SettingsLeaveGuard) => () => void;
}
export function AppVariablesSection(props: Props) {
  return (
    <VariableCatalog
      key={`${props.projectPath ?? "global"}:${props.spaceId ?? ""}`}
      {...props}
    />
  );
}
function VariableCatalog({ projectPath, spaceId, registerLeaveGuard }: Props) {
  const scope = useMemo(
    () => (projectPath ? { projectPath, spaceId: spaceId ?? null } : undefined),
    [projectPath, spaceId],
  );
  const variables = useVariableCatalogEditor(scope, registerLeaveGuard);
  const { catalog, draft, pending, removing } = variables;
  const entries =
    catalog?.entries.filter(
      (e) =>
        !e.inherited ||
        !catalog.entries.some((own) => !own.inherited && own.name === e.name),
    ) ?? [];
  return (
    <section className="flex w-full min-w-0 flex-col gap-4" aria-busy={pending}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-medium wrap-anywhere">
            {draft
              ? draft.editing
                ? m.variables_edit_title()
                : m.settings_variables_add()
              : scope
                ? m.settings_variables_title()
                : m.variables_global_title()}
          </h2>
          {!scope || (!draft && scope.spaceId) ? (
            <p className="text-sm text-muted-foreground">
              {scope
                ? m.variables_scope_description()
                : m.variables_global_description()}
            </p>
          ) : null}
        </div>
        {!draft ? (
          <Button
            size="sm"
            disabled={
              pending ||
              !catalog ||
              variables.loadError ||
              !catalog.owners.find(
                (o) => o.owner.scope === catalog.defaultOwner.scope,
              )?.revision
            }
            onClick={() => variables.begin()}
          >
            <Plus data-icon="inline-start" />
            {m.settings_variables_add()}
          </Button>
        ) : null}
      </div>
      {!catalog && !variables.loadError ? (
        <Skeleton
          className="h-24 w-full"
          aria-label={m.app_variables_loading()}
        />
      ) : null}
      {variables.loadError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {m.app_variables_load_error()}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void variables.refresh().catch(() => undefined)}
            >
              {m.app_retry()}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void variables.recover(undefined)}
            >
              {m.variables_recovery()}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {catalog?.owners
        .filter((owner) => owner.error)
        .map((owner) => (
          <Alert key={owner.label} variant="destructive">
            <AlertDescription>
              <span className="wrap-anywhere">
                {owner.owner.scope === "global"
                  ? m.variables_global()
                  : owner.label}
                : {owner.error}
              </span>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void variables.recover(owner.owner)}
              >
                {m.variables_recovery()}
              </Button>
            </AlertDescription>
          </Alert>
        ))}
      {draft ? (
        <form
          className="flex w-full min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void variables.save();
          }}
        >
          <AppVariableFields
            draft={draft}
            showOwner={Boolean(
              catalog &&
              ownerKey(draft.owner) !== ownerKey(catalog.defaultOwner),
            )}
            collisionAlternatives={catalog?.entries.filter((e) =>
              sameSource(e.source, { owner: draft.owner, name: draft.name }),
            )}
            disabled={pending}
            onChange={variables.updateDraft}
          />
          {variables.currentEntry?.usedIn.length ? (
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {m.variables_known_usage()}:{" "}
              {variables.currentEntry.usedIn
                .map((u) => `${u.ownerDirectory} · ${u.referenceName}`)
                .join(", ")}
            </p>
          ) : null}
          {variables.collision || variables.stale || variables.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {variables.collision
                  ? m.app_variables_collision()
                  : variables.stale
                    ? m.app_variables_stale()
                    : m.app_variables_save_error()}
                {variables.stale ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void variables.reviewLatest()}
                  >
                    {m.variables_retry_draft()}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {variables.reviewed ? (
            <p role="status" className="text-xs text-muted-foreground">
              {m.variables_reload_review()}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={variables.cancel}
            >
              {m.settings_cancel()}
            </Button>
            <Button type="submit" disabled={pending || !variables.canSave}>
              {pending ? m.app_variables_saving() : m.settings_save()}
            </Button>
          </div>
        </form>
      ) : null}
      {draft && entries.length > 0 ? <Separator /> : null}
      {catalog &&
      !draft &&
      !entries.length &&
      !variables.loadError &&
      !catalog.owners.some((o) => o.error) ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.settings_variables_empty_title()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-3">
        {entries.map((entry, i) => (
          <li
            key={`${sourceKey(entry.source)}:${entry.mode}`}
            className="flex min-w-0 flex-col gap-2"
          >
            {i > 0 ? <Separator /> : null}
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1 wrap-anywhere">
                <div className="flex flex-wrap items-center gap-2">
                  <code>{entry.name}</code>
                  <Badge variant="outline">
                    {entry.mode === "git" ? "Git" : m.variables_local()}
                  </Badge>
                  {entry.kind === "secret" ? (
                    <Badge variant="secondary">{m.variables_secret()}</Badge>
                  ) : null}
                  {entry.collision ? (
                    <Badge variant="destructive">
                      {m.variables_conflict()}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {entry.inherited ? `${m.variables_inherited()} · ` : ""}
                  {entry.source.owner.scope === "global"
                    ? m.variables_global()
                    : entry.ownerLabel}
                </p>
                <p className="whitespace-pre-wrap text-sm">
                  {entry.kind === "secret"
                    ? entry.hasValue
                      ? "••••••••"
                      : m.variables_unset_here()
                    : entry.value}
                </p>
                {entry.usedIn.length ? (
                  <p className="text-xs text-muted-foreground">
                    {m.variables_known_usage()}:{" "}
                    {entry.usedIn
                      .map((u) => `${u.ownerDirectory} · ${u.referenceName}`)
                      .join(", ")}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={m.settings_variables_edit_named({
                    name: entry.name,
                  })}
                  onClick={() => variables.begin(entry)}
                >
                  {m.settings_variables_edit()}
                </Button>
                {scope?.spaceId && entry.inherited ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => variables.begin(entry, true)}
                  >
                    {m.variables_override()}
                  </Button>
                ) : null}
                {!entry.inherited && !entry.collision ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={m.settings_variables_remove_named({
                      name: entry.name,
                    })}
                    onClick={() => variables.requestRemove(entry)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) variables.requestRemove(null);
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.settings_variables_remove_title({
                name: removing?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {scope?.spaceId
                ? m.variables_remove_inheritance()
                : m.settings_variables_remove_description()}
              {removing?.usedIn.length
                ? ` ${m.variables_known_usage()}: ${removing.usedIn.map((u) => `${u.ownerDirectory} · ${u.referenceName}`).join(", ")}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {variables.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {m.app_variables_save_error()}
              </AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              {m.settings_cancel()}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void variables.remove()}
            >
              {m.settings_variables_remove()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
