import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useContextualAppVariables } from "../hooks/use-contextual-app-variables";
import type { AppVariablesContext } from "../model";
import { sourceKey, sameSource, ownerKey } from "../model/app-variables";
import { canSaveVariableDraft } from "../model/app-variable-draft";
import { AppVariableFields } from "./app-variable-fields";

interface AppVariablesDialogProps {
  context: AppVariablesContext;
  name?: string;
  onClose(): void;
  returnFocus(): void;
}

export function AppVariablesDialog(props: AppVariablesDialogProps) {
  return <ContextualVariables key={JSON.stringify(props.context)} {...props} />;
}

function ContextualVariables({
  context,
  name,
  onClose,
  returnFocus,
}: AppVariablesDialogProps) {
  const variables = useContextualAppVariables(context);
  const { editor, pending } = variables;
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const restoreRowFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!editor && restoreRowFocus.current) {
      triggers.current.get(restoreRowFocus.current)?.focus();
      restoreRowFocus.current = null;
    }
  }, [editor]);
  const title =
    name ||
    context.ownerPath.split(/[\\/]/).filter(Boolean).at(-1) ||
    context.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ||
    context.ownerPath;
  function cancelEditor() {
    restoreRowFocus.current = editor?.referenceName ?? null;
    variables.cancel();
  }
  const errorCopy =
    variables.error === "partial"
      ? m.app_variables_partial()
      : variables.error === "collision"
        ? m.app_variables_collision()
        : variables.error === "stale" || variables.stale
          ? m.app_variables_stale()
          : variables.error
            ? m.app_variables_save_error()
            : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden sm:max-w-md"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader className="min-w-0 shrink-0 pr-8">
          <DialogTitle>{m.settings_variables_title()}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {title}
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-2 top-2"
          disabled={pending}
          aria-label={m.app_variables_close()}
          onClick={onClose}
        >
          <X />
        </Button>
        <div
          className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto"
          aria-busy={pending}
        >
          {variables.loadError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {m.app_variables_load_error()}
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void variables.recover().catch(() => undefined)
                  }
                >
                  {m.variables_recovery()}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void variables.refresh().catch(() => undefined)
                  }
                >
                  {m.app_retry()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {variables.catalog?.owners
            .filter((owner) => owner.error)
            .map((owner) => (
              <Alert key={owner.label} variant="destructive">
                <AlertDescription>
                  {owner.label}: {owner.error}
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void variables.recover(owner.owner).catch(() => undefined)
                    }
                  >
                    {m.variables_recovery()}
                  </Button>
                </AlertDescription>
              </Alert>
            ))}
          {!variables.catalog && !variables.loadError ? (
            <div
              role="status"
              aria-label={m.app_variables_loading()}
              className="flex flex-col gap-3"
            >
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
          {variables.catalog &&
          variables.references.length === 0 &&
          !variables.loadError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{m.app_variables_empty()}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
          <ul className="flex min-w-0 flex-col gap-3">
            {variables.references.map((reference, index) => {
              const entry = variables.catalog?.entries.find((item) =>
                sameSource(item.source, reference.source),
              );
              const active = editor?.referenceName === reference.referenceName;
              return (
                <li
                  key={reference.referenceName}
                  className="flex min-w-0 flex-col gap-3"
                >
                  {index > 0 ? <Separator /> : null}
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1 wrap-anywhere">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="text-sm">
                          {reference.referenceName}
                        </code>
                        {!reference.resolved ? (
                          <Badge variant="outline">
                            {entry?.kind === "secret" && !entry.hasValue
                              ? m.variables_unset_here()
                              : m.settings_variables_missing()}
                          </Badge>
                        ) : null}
                        {entry ? (
                          <Badge variant="outline">
                            {entry.mode === "git" ? "Git" : m.variables_local()}
                          </Badge>
                        ) : null}
                        {entry ? (
                          <span className="text-xs text-muted-foreground">
                            {entry.kind === "secret"
                              ? m.settings_variables_kind_secret()
                              : m.settings_variables_kind_variable()}
                          </span>
                        ) : null}
                      </div>
                      {
                        <p className="text-xs text-muted-foreground">
                          {m.app_variables_source({
                            name: `${entry?.source.owner.scope === "library" ? m.variables_library() : (entry?.ownerLabel ?? variables.catalog?.owners.find((o) => ownerKey(o.owner) === ownerKey(reference.source.owner))?.label ?? "")} · ${reference.entryName}`,
                          })}
                        </p>
                      }
                      {entry?.hasValue &&
                      !(active && editor?.mode === "value") ? (
                        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                          {entry.kind === "secret" ? "••••••••" : entry.value}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || variables.loadError || active}
                        ref={(node) => {
                          if (node)
                            triggers.current.set(reference.referenceName, node);
                          else triggers.current.delete(reference.referenceName);
                        }}
                        aria-label={
                          entry
                            ? m.settings_variables_edit_named({
                                name: reference.referenceName,
                              })
                            : m.settings_variables_create_named({
                                name: reference.referenceName,
                              })
                        }
                        onClick={() => variables.begin(reference, "value")}
                      >
                        {entry
                          ? m.settings_variables_edit()
                          : m.app_variables_set()}
                      </Button>
                      {context.spaceId &&
                      entry?.source.owner.scope === "project" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending || active || variables.loadError}
                          onClick={() =>
                            variables.begin(reference, "value", true)
                          }
                        >
                          {m.variables_override()}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          pending ||
                          variables.loadError ||
                          active ||
                          (!variables.catalog?.entries.length &&
                            !reference.explicit)
                        }
                        aria-label={m.settings_variables_select_existing({
                          name: reference.referenceName,
                        })}
                        onClick={() => variables.begin(reference, "binding")}
                      >
                        {m.app_variables_change_source()}
                      </Button>
                    </div>
                  </div>
                  {active && editor ? (
                    <form
                      className="flex min-w-0 flex-col gap-3 pb-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        restoreRowFocus.current = reference.referenceName;
                        void variables.submit();
                      }}
                    >
                      {editor.mode === "value" ? (
                        <>
                          <AppVariableFields
                            compact
                            draft={editor.draft}
                            collisionAlternatives={variables.catalog?.entries.filter(
                              (e) =>
                                sameSource(e.source, {
                                  owner: editor.draft.owner,
                                  name: editor.draft.name,
                                }),
                            )}
                            disabled={pending || Boolean(editor.savedEntry)}
                            onChange={variables.updateDraft}
                          />
                          {(variables.entry?.usedIn.length ?? 0) > 0 ? (
                            <p className="text-xs text-muted-foreground wrap-anywhere">
                              {m.app_variables_shared_usage()}{" "}
                              {variables.entry?.usedIn
                                .map(
                                  (usage) =>
                                    `${usage.ownerDirectory.startsWith(context.projectPath + "/") ? usage.ownerDirectory.slice(context.projectPath.length + 1) : usage.ownerDirectory} · ${usage.referenceName}`,
                                )
                                .join(", ")}
                            </p>
                          ) : null}
                          {variables.collision ? (
                            <Alert>
                              <AlertDescription>
                                {m.app_variables_collision()}
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={pending}
                                  onClick={variables.useCollision}
                                >
                                  {m.settings_variables_select()}
                                </Button>
                              </AlertDescription>
                            </Alert>
                          ) : null}
                        </>
                      ) : (
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor="app-variable-source">
                              {m.app_variables_source_label()}
                            </FieldLabel>
                            <Select
                              value={
                                editor.entryName === "inherit" ||
                                variables.catalog?.entries.some(
                                  (item) =>
                                    sourceKey(item.source) === editor.entryName,
                                )
                                  ? editor.entryName
                                  : ""
                              }
                              onValueChange={variables.selectEntry}
                              disabled={pending}
                            >
                              <SelectTrigger
                                id="app-variable-source"
                                className="w-full min-w-0 [&>span]:truncate"
                              >
                                <SelectValue
                                  placeholder={m.settings_variables_select()}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="inherit">
                                    {m.variables_inherit()}
                                  </SelectItem>
                                  {variables.catalog?.entries
                                    .filter(
                                      (item, i, all) =>
                                        all.findIndex((e) =>
                                          sameSource(e.source, item.source),
                                        ) === i,
                                    )
                                    .map((item) => (
                                      <SelectItem
                                        key={sourceKey(item.source)}
                                        value={sourceKey(item.source)}
                                        disabled={item.collision}
                                        className="wrap-anywhere"
                                      >
                                        {item.name} ·{" "}
                                        {item.source.owner.scope === "library"
                                          ? m.variables_library()
                                          : item.ownerLabel}{" "}
                                        ·{" "}
                                        {item.mode === "git"
                                          ? "Git"
                                          : m.variables_local()}
                                        {!item.hasValue
                                          ? ` · ${m.variables_unset_here()}`
                                          : ""}
                                      </SelectItem>
                                    ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                        </FieldGroup>
                      )}
                      {errorCopy ? (
                        <Alert variant="destructive">
                          <AlertDescription>
                            {errorCopy}
                            {variables.stale || variables.error === "stale" ? (
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
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={cancelEditor}
                        >
                          {m.settings_cancel()}
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={
                            pending ||
                            variables.loadError ||
                            variables.stale ||
                            (editor.mode === "value" &&
                              !editor.savedEntry &&
                              (!canSaveVariableDraft(editor.draft) ||
                                Boolean(variables.collision))) ||
                            (editor.mode === "binding" &&
                              editor.entryName !== "inherit" &&
                              !variables.catalog?.entries.some(
                                (item) =>
                                  sourceKey(item.source) === editor.entryName,
                              ))
                          }
                        >
                          {pending
                            ? m.app_variables_saving()
                            : editor.savedEntry
                              ? m.app_variables_retry_binding()
                              : editor.mode === "binding"
                                ? m.app_variables_bind()
                                : m.settings_save()}
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {editor &&
          !variables.references.some(
            (reference) => reference.referenceName === editor.referenceName,
          ) ? (
            <Alert variant="destructive">
              <AlertDescription>
                {m.app_variables_stale()}
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={cancelEditor}
                >
                  {m.settings_cancel()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        {editor || variables.saved ? (
          <p role="status" className="shrink-0 text-xs text-muted-foreground">
            {variables.saved
              ? m.app_variables_saved()
              : m.app_variables_next_start()}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
