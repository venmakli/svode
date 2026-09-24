import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { useVariableCatalogEditor } from "../hooks/use-variable-catalog-editor";
import {
  ownerKey,
  sameSource,
  sourceKey,
  type AppVariableEntry,
  type AppVariableUsage,
  type VariableMode,
  type VariableSource,
} from "../model/app-variables";
import type { SettingsLeaveGuard } from "../model/settings-destination";
import { AppVariableFields } from "./app-variable-fields";
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
  SettingsRowSkeleton,
} from "./settings-layout";

export interface VariableCatalogGroupHandle {
  edit(name: string, mode: VariableMode): void;
}

const rowKey = (source: VariableSource, mode: VariableMode) =>
  `${sourceKey(source)}:${mode}`;

function usageText(
  usage: AppVariableUsage[],
  projectPath?: string,
  projectName?: string,
) {
  return usage
    .map(({ ownerDirectory, referenceName }) => {
      const nested =
        projectPath &&
        ownerDirectory.startsWith(projectPath) &&
        /^[\\/]/.test(ownerDirectory.slice(projectPath.length));
      const owner =
        projectPath && ownerDirectory === projectPath
          ? (projectName ?? ownerDirectory)
          : nested
            ? ownerDirectory.slice(projectPath.length + 1)
            : ownerDirectory;
      return `${owner} · ${referenceName}`;
    })
    .join(", ");
}

const valueText = (entry: AppVariableEntry) =>
  entry.kind === "secret"
    ? entry.hasValue
      ? "••••••••"
      : m.variables_unset_here()
    : (entry.value ?? "");

// The Variables group of one owner. Each owner keeps its own catalog
// lifecycle; the page only coordinates the single open editor.
export function VariableCatalogGroup({
  ref,
  projectPath,
  spaceId = null,
  projectName,
  description,
  registerLeaveGuard,
  locked = false,
  onEditorChange,
  onEditInProject,
}: {
  ref?: Ref<VariableCatalogGroupHandle>;
  projectPath?: string;
  spaceId?: string | null;
  projectName?: string;
  description?: ReactNode;
  registerLeaveGuard?: (guard: SettingsLeaveGuard) => () => void;
  locked?: boolean;
  onEditorChange?(owner: string, open: boolean): void;
  onEditInProject?(entry: AppVariableEntry): void;
}) {
  const scope = useMemo(
    () => (projectPath ? { projectPath, spaceId } : undefined),
    [projectPath, spaceId],
  );
  const owner = spaceId
    ? `space:${spaceId}`
    : projectPath
      ? "project"
      : "global";
  const variables = useVariableCatalogEditor(scope, registerLeaveGuard);
  const { catalog, draft, pending, removing } = variables;
  const [anchor, setAnchor] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLElement>());
  const restoreFocus = useRef<string | null>(null);
  const removeTrigger = useRef<HTMLElement | null>(null);
  const editing = Boolean(draft);

  useEffect(() => {
    if (!editing) return;
    onEditorChange?.(owner, true);
    return () => onEditorChange?.(owner, false);
  }, [owner, editing, onEditorChange]);

  useLayoutEffect(() => {
    if (draft || !restoreFocus.current) return;
    const target =
      triggers.current.get(restoreFocus.current) ?? triggers.current.get("add");
    restoreFocus.current = null;
    target?.focus();
  }, [draft]);

  const own = catalog?.entries.filter((entry) => !entry.inherited) ?? [];
  const inherited =
    catalog?.entries.filter(
      (entry) =>
        entry.inherited && !own.some((item) => item.name === entry.name),
    ) ?? [];
  // The editor opens in its row; a new entry, or a row that disappeared
  // while editing, keeps it at the top of the card.
  const editorAnchor =
    draft &&
    anchor &&
    [...own, ...inherited].some(
      (entry) => rowKey(entry.source, entry.mode) === anchor,
    )
      ? anchor
      : draft
        ? "new"
        : null;
  const ownerState = catalog?.owners.find(
    (item) => ownerKey(item.owner) === ownerKey(catalog.defaultOwner),
  );
  const ownerError = ownerState?.error ?? null;
  const blocked = pending || locked || editing;
  const canAdd = Boolean(
    catalog && !variables.loadError && ownerState?.revision,
  );
  const empty = Boolean(
    catalog &&
    !variables.loadError &&
    !catalog.owners.some((item) => item.error) &&
    !own.length &&
    !inherited.length &&
    editorAnchor !== "new",
  );

  function begin(key: string, entry?: AppVariableEntry, override = false) {
    setAnchor(key);
    variables.begin(entry, override);
  }

  useImperativeHandle(ref, () => ({
    edit(name, mode) {
      const entry =
        own.find((item) => item.name === name && item.mode === mode) ??
        own.find((item) => item.name === name);
      if (entry && !blocked) begin(rowKey(entry.source, entry.mode), entry);
    },
  }));

  function trigger(key: string) {
    return (node: HTMLElement | null) => {
      if (node) triggers.current.set(key, node);
      else triggers.current.delete(key);
    };
  }

  function cancel() {
    restoreFocus.current = anchor === "new" || !anchor ? "add" : anchor;
    variables.cancel();
  }

  function save() {
    if (!draft) return;
    restoreFocus.current = rowKey(
      { owner: draft.owner, name: draft.name },
      draft.storage,
    );
    void variables.save();
  }

  const addButton = (
    <Button
      ref={trigger("add")}
      type="button"
      variant="outline"
      size="sm"
      disabled={blocked || !canAdd}
      onClick={() => begin("new")}
    >
      <Plus data-icon="inline-start" />
      {m.settings_variables_add()}
    </Button>
  );

  const editor = draft ? (
    <form
      key="editor"
      aria-label={
        draft.editing ? m.variables_edit_title() : m.settings_variables_add()
      }
      className="flex min-w-0 flex-col bg-muted/40"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <AppVariableFields
        layout="rows"
        draft={draft}
        disabled={pending}
        onChange={variables.updateDraft}
        collisionAlternatives={catalog?.entries.filter((entry) =>
          sameSource(entry.source, { owner: draft.owner, name: draft.name }),
        )}
        nameError={variables.collision ? m.variables_name_taken() : null}
        usage={
          variables.currentEntry?.usedIn.length
            ? `${m.variables_known_usage()}: ${usageText(variables.currentEntry.usedIn, projectPath, projectName)}`
            : null
        }
        currentValue={
          variables.reviewed && variables.currentEntry
            ? valueText(variables.currentEntry)
            : null
        }
      />
      <Separator />
      {variables.stale || variables.error ? (
        <div className="px-4 pt-3">
          <Alert variant="destructive">
            <AlertDescription>
              <p>
                {variables.stale
                  ? m.variables_changed_outside()
                  : m.app_variables_save_error()}
              </p>
              {variables.stale ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void variables.reviewLatest()}
                  >
                    {m.variables_retry_draft()}
                  </Button>
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {variables.reviewed ? (
        <p role="status" className="px-4 pt-3 text-sm text-muted-foreground">
          {m.variables_reload_review()}
        </p>
      ) : null}
      <SettingsActions>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={cancel}
        >
          {m.settings_cancel()}
        </Button>
        <Button type="submit" disabled={pending || !variables.canSave}>
          {pending ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : null}
          {m.settings_save()}
        </Button>
      </SettingsActions>
    </form>
  ) : null;

  function entryRow(entry: AppVariableEntry) {
    const key = rowKey(entry.source, entry.mode);
    if (key === editorAnchor) return editor;
    const secret = entry.kind === "secret";
    return (
      <SettingsItem
        key={key}
        data-variable={entry.name}
        data-inherited={entry.inherited || undefined}
        className={entry.inherited ? "text-muted-foreground" : undefined}
        title={<span className="font-mono wrap-anywhere">{entry.name}</span>}
        description={
          <>
            <span className="block whitespace-pre-wrap wrap-anywhere">
              {valueText(entry)}
            </span>
            {entry.inherited ? (
              <span className="block">
                {m.variables_inherited_from_project()}
              </span>
            ) : null}
            {entry.usedIn.length ? (
              <span className="block wrap-anywhere">
                {m.variables_known_usage()}:{" "}
                {usageText(entry.usedIn, projectPath, projectName)}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            {entry.source.owner.scope !== "global" ? (
              <Badge variant="outline">
                {entry.mode === "git" ? "Git" : m.variables_local()}
              </Badge>
            ) : null}
            {secret ? (
              <Badge variant="secondary">{m.variables_secret()}</Badge>
            ) : null}
            {entry.collision ? (
              <Badge variant="destructive">{m.variables_conflict()}</Badge>
            ) : null}
            {entry.inherited ? (
              <>
                <Button
                  ref={trigger(key)}
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={blocked}
                  aria-label={m.variables_override_named({ name: entry.name })}
                  onClick={() => begin(key, entry, true)}
                >
                  {m.variables_override()}
                </Button>
                {onEditInProject ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={blocked}
                    aria-label={m.variables_edit_in_project_named({
                      name: entry.name,
                    })}
                    onClick={() => onEditInProject(entry)}
                  >
                    {m.variables_edit_in_project()}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  ref={trigger(key)}
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={blocked}
                  aria-label={m.settings_variables_edit_named({
                    name: entry.name,
                  })}
                  onClick={() => begin(key, entry)}
                >
                  {m.settings_variables_edit()}
                </Button>
                {!entry.collision ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={blocked}
                    aria-label={m.settings_variables_remove_named({
                      name: entry.name,
                    })}
                    onClick={(event) => {
                      removeTrigger.current = event.currentTarget;
                      variables.requestRemove(entry);
                    }}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </>
            )}
          </>
        }
      />
    );
  }

  return (
    <>
      <SettingsGroup
        title={m.settings_variables_title()}
        description={description}
        action={empty ? null : addButton}
        aria-busy={pending || (!catalog && !variables.loadError)}
        callout={
          variables.loadError || ownerError ? (
            <>
              {variables.loadError ? (
                <Alert>
                  <AlertTitle>{m.variables_load_error_title()}</AlertTitle>
                  <AlertDescription>
                    <p>{m.variables_load_error_retry()}</p>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void variables.refresh().catch(() => undefined)
                        }
                      >
                        {m.app_retry()}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => void variables.recover(undefined)}
                      >
                        {m.variables_recovery()}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {ownerError && catalog ? (
                <Alert>
                  <AlertTitle>{m.variables_owner_error_title()}</AlertTitle>
                  <AlertDescription>
                    <p className="wrap-anywhere">{ownerError}</p>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void variables.recover(catalog.defaultOwner)
                        }
                      >
                        {m.variables_recovery()}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null
        }
      >
        {editorAnchor === "new" ? editor : null}
        {own.map(entryRow)}
        {inherited.map(entryRow)}
        {!catalog && !variables.loadError
          ? [
              <SettingsRowSkeleton key="loading-first" />,
              <SettingsRowSkeleton key="loading-second" />,
            ]
          : null}
        {empty ? (
          <Empty key="empty" className="p-6">
            <EmptyHeader>
              <EmptyTitle>{m.settings_variables_empty_title()}</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>{addButton}</EmptyContent>
          </Empty>
        ) : null}
      </SettingsGroup>
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
          onCloseAutoFocus={(event) => {
            const target = removeTrigger.current?.isConnected
              ? removeTrigger.current
              : triggers.current.get("add");
            removeTrigger.current = null;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.settings_variables_remove_title({
                name: removing?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {spaceId
                ? m.variables_remove_inheritance()
                : m.settings_variables_remove_description()}
              {removing?.usedIn.length
                ? ` ${m.variables_known_usage()}: ${usageText(removing.usedIn, projectPath, projectName)}`
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
    </>
  );
}
