import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PROPERTY_TYPES, STATUS_GROUPS } from "../lib/utils";
import type { Column, PropertyType } from "../model/types";
import * as m from "@/paraglide/messages.js";
import {
  deferStateUpdate,
  parseOptions,
  type BaseDialogProps,
} from "./schema-dialog-utils";

export function AddColumnDialog({
  open,
  onOpenChange,
  collectionPath,
  onSubmit,
}: BaseDialogProps & {
  collectionPath?: string | null;
  onSubmit: (column: Column) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const [options, setOptions] = useState("");
  const [prefix, setPrefix] = useState("");
  const [actorMultiple, setActorMultiple] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    return deferStateUpdate(() => {
      if (!open) {
        setName("");
        setType("text");
        setOptions("");
        setPrefix("");
        setActorMultiple(false);
        setIsSaving(false);
      }
    });
  }, [open]);

  const needsOptions =
    type === "select" || type === "multi_select" || type === "status";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.property_dialog_add_column_title()}</DialogTitle>
          <DialogDescription>
            {m.property_dialog_add_column_desc()}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-column-type">
              {m.property_dialog_type()}
            </Label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as PropertyType)}
            >
              <SelectTrigger id="property-column-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PROPERTY_TYPES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-column-name">
              {m.property_dialog_name()}
            </Label>
            <Input
              id="property-column-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={m.editor_frontmatter_key_placeholder()}
            />
          </div>
          {needsOptions ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="property-column-options">
                {m.property_dialog_options()}
              </Label>
              <Textarea
                id="property-column-options"
                value={options}
                onChange={(event) => setOptions(event.target.value)}
                placeholder={
                  type === "status"
                    ? "Backlog | gray | todo\nTodo | blue | todo\nIn progress | yellow | in_progress\nDone | green | done"
                    : "Low | gray\nMedium | yellow\nHigh | red"
                }
              />
            </div>
          ) : null}
          {type === "unique_id" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="property-column-prefix">
                {m.property_unique_id_prefix()}
              </Label>
              <Input
                id="property-column-prefix"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="ISSUE"
              />
            </div>
          ) : null}
          {type === "actor" ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={actorMultiple}
                onCheckedChange={(checked) =>
                  setActorMultiple(checked === true)
                }
              />
              {m.property_actor_multiple()}
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.project_cancel()}
          </Button>
          <Button
            disabled={!name.trim() || isSaving}
            onClick={() => {
              setIsSaving(true);
              const column: Column = {
                name: name.trim(),
                type,
                options: needsOptions ? parseOptions(options, type) : undefined,
                relation:
                  type === "relation" ? collectionPath || "." : undefined,
                prefix:
                  type === "unique_id" && prefix.trim()
                    ? prefix.trim()
                    : undefined,
                next: type === "unique_id" ? 1 : undefined,
                multiple: type === "actor" ? actorMultiple : undefined,
              };
              void onSubmit(column).finally(() => setIsSaving(false));
            }}
          >
            {m.editor_frontmatter_add()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChangeTypeDialog({
  open,
  onOpenChange,
  column,
  collectionPath,
  onSubmit,
}: BaseDialogProps & {
  column: Column | null;
  collectionPath?: string | null;
  onSubmit: (
    newType: PropertyType,
    conversionStrategy?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [type, setType] = useState<PropertyType>("text");
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [prefix, setPrefix] = useState("");
  const [actorMultiple, setActorMultiple] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    return deferStateUpdate(() => {
      if (column) {
        setType(column.type);
        setPrefix(column.prefix ?? "");
        setActorMultiple(Boolean(column.multiple));
        setGroups(
          Object.fromEntries(
            (column.options ?? []).map((option) => [
              option.name,
              option.group ?? "todo",
            ]),
          ),
        );
      }
    });
  }, [column]);

  const needsStatusGroups = column?.type === "select" && type === "status";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.property_dialog_change_type_title()}</DialogTitle>
          <DialogDescription>
            {m.property_dialog_change_type_desc()}
          </DialogDescription>
        </DialogHeader>
        <Select
          value={type}
          onValueChange={(value) => setType(value as PropertyType)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PROPERTY_TYPES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {needsStatusGroups ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {m.property_dialog_status_groups()}
            </p>
            {(column.options ?? []).map((option) => (
              <div
                key={option.name}
                className="grid grid-cols-[1fr_10rem] items-center gap-2"
              >
                <span className="min-w-0 truncate text-sm">{option.name}</span>
                <Select
                  value={groups[option.name] ?? "todo"}
                  onValueChange={(group) =>
                    setGroups((current) => ({
                      ...current,
                      [option.name]: group,
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {STATUS_GROUPS.map((group) => (
                        <SelectItem key={group.value} value={group.value}>
                          {group.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        ) : null}
        {type === "unique_id" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="property-change-prefix">
              {m.property_unique_id_prefix()}
            </Label>
            <Input
              id="property-change-prefix"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder="ISSUE"
            />
          </div>
        ) : null}
        {type === "actor" ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={actorMultiple}
              onCheckedChange={(checked) => setActorMultiple(checked === true)}
            />
            {m.property_actor_multiple()}
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.project_cancel()}
          </Button>
          <Button
            disabled={!column || isSaving}
            onClick={() => {
              setIsSaving(true);
              void onSubmit(
                type,
                needsStatusGroups
                  ? { groups }
                  : type === "relation"
                    ? { relation: collectionPath || "." }
                    : type === "unique_id"
                      ? { prefix: prefix.trim() || null }
                      : type === "actor"
                        ? { multiple: actorMultiple }
                        : undefined,
              ).finally(() => setIsSaving(false));
            }}
          >
            {m.settings_save()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameColumnDialog({
  open,
  onOpenChange,
  column,
  onSubmit,
}: BaseDialogProps & {
  column: Column | null;
  onSubmit: (newName: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    return deferStateUpdate(() => setName(column?.name ?? ""));
  }, [column]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.property_dialog_rename_column_title()}</DialogTitle>
          <DialogDescription>
            {m.property_dialog_rename_column_desc()}
          </DialogDescription>
        </DialogHeader>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.project_cancel()}
          </Button>
          <Button
            disabled={
              !column ||
              !name.trim() ||
              name.trim() === column?.name ||
              isSaving
            }
            onClick={() => {
              setIsSaving(true);
              void onSubmit(name.trim()).finally(() => setIsSaving(false));
            }}
          >
            {m.space_rename()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteColumnDialog({
  open,
  onOpenChange,
  column,
  onSubmit,
}: BaseDialogProps & {
  column: Column | null;
  onSubmit: (deleteValues: boolean) => Promise<void>;
}) {
  const [deleteValues, setDeleteValues] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.property_dialog_delete_column_title()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.property_dialog_delete_column_desc({ name: column?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={deleteValues}
            onCheckedChange={(checked) => setDeleteValues(checked === true)}
          />
          {m.property_dialog_delete_values()}
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.file_delete_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!column}
            onClick={() => void onSubmit(deleteValues)}
          >
            {m.file_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
