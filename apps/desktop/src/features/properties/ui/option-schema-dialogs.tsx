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
import { COLOR_NAMES, STATUS_GROUPS } from "../lib/utils";
import type { Column, PropertyOption } from "../model/types";
import * as m from "@/paraglide/messages.js";
import {
  deferStateUpdate,
  type BaseDialogProps,
} from "./schema-dialog-utils";

export function AddOptionDialog({
  open,
  onOpenChange,
  column,
  onSubmit,
}: BaseDialogProps & {
  column: Column | null;
  onSubmit: (option: PropertyOption) => Promise<void>;
}) {
  const [option, setOption] = useState<PropertyOption>({
    name: "",
    color: "neutral",
  });
  useEffect(() => {
    return deferStateUpdate(() => {
      if (!open) setOption({ name: "", color: "neutral" });
    });
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.property_dialog_add_option_title()}</DialogTitle>
          <DialogDescription>{column?.name ?? ""}</DialogDescription>
        </DialogHeader>
        <OptionFields
          option={option}
          showGroup={column?.type === "status"}
          onChange={setOption}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.project_cancel()}
          </Button>
          <Button
            disabled={!option.name.trim()}
            onClick={() => void onSubmit(option)}
          >
            {m.editor_frontmatter_add()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameOptionDialog({
  open,
  onOpenChange,
  option,
  onSubmit,
}: BaseDialogProps & {
  option: PropertyOption | null;
  onSubmit: (newName: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  useEffect(
    () => deferStateUpdate(() => setName(option?.name ?? "")),
    [option],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.property_dialog_rename_option_title()}</DialogTitle>
          <DialogDescription>
            {m.property_dialog_rename_option_desc()}
          </DialogDescription>
        </DialogHeader>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.project_cancel()}
          </Button>
          <Button
            disabled={!option || !name.trim()}
            onClick={() => void onSubmit(name.trim())}
          >
            {m.space_rename()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteOptionDialog({
  open,
  onOpenChange,
  option,
  onSubmit,
}: BaseDialogProps & {
  option: PropertyOption | null;
  onSubmit: (deleteValues: boolean) => Promise<void>;
}) {
  const [deleteValues, setDeleteValues] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.property_dialog_delete_option_title()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.property_dialog_delete_option_desc({ name: option?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={deleteValues}
            onCheckedChange={(checked) => setDeleteValues(checked === true)}
          />
          {m.property_dialog_delete_option_values()}
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.file_delete_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!option}
            onClick={() => void onSubmit(deleteValues)}
          >
            {m.file_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OptionFields({
  option,
  showGroup,
  onChange,
}: {
  option: PropertyOption;
  showGroup: boolean;
  onChange: (option: PropertyOption) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="property-option-name">{m.property_dialog_name()}</Label>
        <Input
          id="property-option-name"
          value={option.name}
          onChange={(event) =>
            onChange({ ...option, name: event.target.value })
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{m.property_dialog_color()}</Label>
        <Select
          value={option.color ?? "neutral"}
          onValueChange={(color) =>
            onChange({ ...option, color: color as PropertyOption["color"] })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {COLOR_NAMES.map((color) => (
                <SelectItem key={color} value={color}>
                  {color}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {showGroup ? (
        <div className="flex flex-col gap-1.5">
          <Label>{m.property_dialog_group()}</Label>
          <Select
            value={option.group ?? "todo"}
            onValueChange={(group) =>
              onChange({ ...option, group: group as PropertyOption["group"] })
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
      ) : null}
    </div>
  );
}
