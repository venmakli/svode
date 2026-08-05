import { LoaderCircle } from "lucide-react";

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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as m from "@/paraglide/messages.js";

import type { AgentActorSaveCandidate } from "../hooks/use-agent-actor-catalog-save";

export function AgentActorSaveDialog({
  candidates,
  failure,
  pending,
  selectedOwnerPath,
  onClose,
  onConfirm,
  onSelect,
}: {
  candidates: readonly AgentActorSaveCandidate[];
  failure: string | null;
  pending: boolean;
  selectedOwnerPath: string | null;
  onClose(): void;
  onConfirm(): void;
  onSelect(ownerPath: string): void;
}) {
  if (candidates.length === 0) return null;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.agent_actors_save_catalog_title()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.agent_actors_save_catalog_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {candidates.length > 1 ? (
          <Field>
            <FieldLabel>{m.agent_actors_field_space()}</FieldLabel>
            <Select value={selectedOwnerPath ?? ""} onValueChange={onSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={m.agent_actors_field_space()} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {candidates.map((candidate) => (
                    <SelectItem
                      key={candidate.ownerPath}
                      value={candidate.ownerPath}
                    >
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {m.agent_actors_save_catalog_warning()}
            </FieldDescription>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">
            {m.agent_actors_save_catalog_warning()}
          </p>
        )}
        {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onClose}>
            {m.agent_actors_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !selectedOwnerPath}
            onClick={onConfirm}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.agent_actors_save_catalog_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
