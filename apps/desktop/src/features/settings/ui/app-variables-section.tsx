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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AppVariableFields } from "./app-variable-fields";
import {
  createVariableDraft,
  editVariableDraft,
  canSaveVariableDraft,
  variableDraftInput,
  type VariableDraft,
} from "../model/app-variable-draft";
import { useAppVariables } from "../hooks/use-app-variables";
import type { AppVariableEntry } from "../model";

export function AppVariablesSection() {
  const variables = useAppVariables();
  const [draft, setDraft] = useState<VariableDraft | null>(null);
  const entries = variables.catalog?.entries ?? [];
  const canSave = Boolean(draft && canSaveVariableDraft(draft));

  function beginCreate() {
    setDraft(createVariableDraft());
  }
  function beginEdit(entry: AppVariableEntry) {
    setDraft(editVariableDraft(entry));
  }
  async function saveDraft() {
    if (!draft || !canSave) return;
    await variables.save(variableDraftInput(draft));
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
            <div className="flex flex-col gap-4">
              <AppVariableFields
                draft={draft}
                disabled={variables.pending}
                onChange={setDraft}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setDraft(null)}
                  disabled={variables.pending}
                >
                  {m.settings_cancel()}
                </Button>
                <Button
                  onClick={() => void saveDraft().catch(() => undefined)}
                  disabled={!canSave || variables.pending}
                >
                  {m.settings_save()}
                </Button>
              </div>
            </div>
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
                  <TableCell className="max-w-52 whitespace-normal break-all text-xs text-muted-foreground">
                    {entry.usedIn.length > 0
                      ? entry.usedIn
                          .map(
                            (usage) =>
                              `${usage.referenceName.startsWith("S3 ") ? usage.ownerDirectory : lastPathPart(usage.ownerDirectory)} · ${usage.referenceName}`,
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
