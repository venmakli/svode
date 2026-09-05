import { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppVariables } from "../hooks/use-app-variables";
import type {
  AppVariableEntry,
  AppVariableKind,
  AppVariablesContext,
} from "../model";

interface VariableDraft {
  name: string;
  kind: AppVariableKind;
  value: string;
  editing: boolean;
  bindReference?: string;
  preservesSecret: boolean;
}

export function AppVariablesSection({
  context,
}: {
  context?: AppVariablesContext;
}) {
  const variables = useAppVariables(context);
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const entries = variables.catalog?.entries ?? [];
  const unresolved = (variables.catalog?.context ?? []).filter(
    (reference) => !reference.resolved,
  );
  const validName = draft ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.name) : false;
  const canSave = Boolean(
    draft &&
    validName &&
    (draft.kind === "variable" ||
      draft.preservesSecret ||
      draft.value.length > 0),
  );

  const entryNames = entries.map((entry) => entry.name);

  function beginCreate(name = "", bindReference?: string) {
    setDraft({
      name,
      kind: "variable",
      value: "",
      editing: false,
      bindReference,
      preservesSecret: false,
    });
  }

  function beginEdit(entry: AppVariableEntry) {
    setDraft({
      name: entry.name,
      kind: entry.kind,
      value: entry.kind === "variable" ? (entry.value ?? "") : "",
      editing: true,
      preservesSecret: entry.kind === "secret" && entry.hasValue,
    });
  }

  async function saveDraft() {
    if (!draft || !canSave) return;
    await variables.save({
      name: draft.name,
      kind: draft.kind,
      value:
        draft.kind === "secret" && draft.preservesSecret && draft.value === ""
          ? undefined
          : draft.value,
    });
    if (draft.bindReference) {
      await variables.bind(draft.bindReference, draft.name);
    }
    setDraft(null);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {m.settings_variables_title()}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {m.settings_variables_description()}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => beginCreate()}
          disabled={variables.pending}
        >
          <Plus data-icon="inline-start" />
          {m.settings_variables_add()}
        </Button>
      </div>

      {unresolved.length > 0 ? (
        <Alert>
          <KeyRound data-icon="inline-start" />
          <AlertTitle>{m.settings_variables_missing_title()}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{m.settings_variables_missing_description()}</span>
            {unresolved.map((reference) => (
              <div
                key={reference.referenceName}
                className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2"
              >
                <code className="mr-auto text-xs">
                  {reference.referenceName}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    beginCreate(
                      reference.referenceName,
                      reference.referenceName,
                    )
                  }
                >
                  {m.settings_variables_create_named({
                    name: reference.referenceName,
                  })}
                </Button>
                {entryNames.length > 0 ? (
                  <Select
                    value={
                      entries.some(
                        (entry) => entry.name === reference.entryName,
                      )
                        ? reference.entryName
                        : undefined
                    }
                    onValueChange={(entryName) =>
                      void variables.bind(reference.referenceName, entryName)
                    }
                    disabled={variables.pending}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={m.settings_variables_select_existing({
                        name: reference.referenceName,
                      })}
                    >
                      <SelectValue
                        placeholder={m.settings_variables_select()}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {entryNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {draft ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {draft.editing
                ? m.settings_variables_edit()
                : m.settings_variables_add()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={draft.name.length > 0 && !validName}>
                <FieldLabel htmlFor="app-variable-name">
                  {m.settings_variables_name()}
                </FieldLabel>
                <Input
                  id="app-variable-name"
                  value={draft.name}
                  disabled={draft.editing || variables.pending}
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      name: event.target.value.toUpperCase(),
                    })
                  }
                />
                <FieldDescription>
                  {m.settings_variables_name_hint()}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>{m.settings_variables_kind()}</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={draft.kind}
                  onValueChange={(kind) => {
                    if (kind === "variable" || kind === "secret")
                      setDraft({ ...draft, kind });
                  }}
                >
                  <ToggleGroupItem value="variable">
                    {m.settings_variables_kind_variable()}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="secret">
                    {m.settings_variables_kind_secret()}
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="app-variable-value">
                  {m.settings_variables_value()}
                </FieldLabel>
                <Input
                  id="app-variable-value"
                  type={draft.kind === "secret" ? "password" : "text"}
                  value={draft.value}
                  disabled={variables.pending}
                  placeholder={
                    draft.kind === "secret" && draft.preservesSecret
                      ? m.settings_variables_secret_unchanged()
                      : undefined
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, value: event.target.value })
                  }
                />
                <FieldDescription>
                  {draft.kind === "secret"
                    ? m.settings_variables_secret_hint()
                    : m.settings_variables_value_hint()}
                </FieldDescription>
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setDraft(null)}
                  disabled={variables.pending}
                >
                  {m.settings_cancel()}
                </Button>
                <Button
                  onClick={() => void saveDraft()}
                  disabled={!canSave || variables.pending}
                >
                  {m.settings_save()}
                </Button>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}

      {entries.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRound />
            </EmptyMedia>
            <EmptyTitle>{m.settings_variables_empty_title()}</EmptyTitle>
            <EmptyDescription>
              {m.settings_variables_empty_description()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.settings_variables_name()}</TableHead>
                <TableHead>{m.settings_variables_kind()}</TableHead>
                <TableHead>{m.settings_variables_value()}</TableHead>
                <TableHead>{m.settings_variables_used_in()}</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">
                    {m.settings_variables_actions()}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell>
                    <code className="text-xs">{entry.name}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {entry.kind === "secret"
                        ? m.settings_variables_kind_secret()
                        : m.settings_variables_kind_variable()}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-40 truncate" title={entry.value}>
                    {entry.kind === "secret"
                      ? entry.hasValue
                        ? "••••••••"
                        : m.settings_variables_missing()
                      : entry.value}
                  </TableCell>
                  <TableCell className="max-w-52 whitespace-normal text-xs text-muted-foreground">
                    {entry.usedIn.length > 0
                      ? entry.usedIn
                          .map(
                            (usage) =>
                              `${lastPathPart(usage.ownerDirectory)} · ${usage.referenceName}`,
                          )
                          .join(", ")
                      : m.settings_variables_not_used()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={m.settings_variables_edit_named({
                          name: entry.name,
                        })}
                        onClick={() => beginEdit(entry)}
                      >
                        {m.settings_variables_edit()}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={m.settings_variables_remove_named({
                              name: entry.name,
                            })}
                          >
                            <Trash2 />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {m.settings_variables_remove_title({
                                name: entry.name,
                              })}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {m.settings_variables_remove_description()}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>
                              {m.settings_cancel()}
                            </AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => void variables.remove(entry.name)}
                            >
                              {m.settings_variables_remove()}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function lastPathPart(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
