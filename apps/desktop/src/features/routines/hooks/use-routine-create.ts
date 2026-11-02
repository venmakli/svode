import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import { createRoutine, type RoutineOwnerInput } from "../api/routines-api";
import { routineMutationWarningDescription } from "../lib/routine-mutation-warning";
import {
  createRoutineDraft,
  defaultRoutineName,
} from "../model/routine-create";
import type { RoutineCatalogSnapshot, RoutineItem } from "../model/types";
import { routineErrorMessage } from "./use-routine-catalog";

/** Names a concurrent create may have taken before the owner gives up. */
const MAX_NAME_ATTEMPTS = 5;

/**
 * Creates a Routine as a page is created: its file in the owner's
 * `.routines/` at once, under the first free default name ("New routine",
 * "New routine 2"…), manual and without an executor. An abandoned draft
 * stays a file. It rejects with the reason the Routine was not created.
 */
export function useRoutineCreate({
  owner,
  onCreated,
}: {
  owner: RoutineOwnerInput;
  onCreated(created: {
    itemId: string;
    snapshot: RoutineCatalogSnapshot;
  }): void;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const create = useCallback(
    async (items: readonly RoutineItem[]) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        // A name another create took meanwhile moves to the next number.
        const taken: string[] = [];
        for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
          const name = defaultRoutineName(m.routines_new_name(), items, taken);
          let result: Awaited<ReturnType<typeof createRoutine>>;
          try {
            result = await createRoutine(owner, createRoutineDraft(name));
          } catch (reason) {
            throw new Error(routineErrorMessage(reason), { cause: reason });
          }
          if (result.status === "name_conflict") {
            taken.push(name);
            continue;
          }
          if (result.status !== "applied") {
            throw new Error(
              result.status === "blocked" && result.message
                ? result.message
                : m.routines_mutation_blocked(),
            );
          }
          if (result.warnings.length > 0) {
            toast.warning(m.routines_create_applied_warning(), {
              description: result.warnings
                .map(routineMutationWarningDescription)
                .join("\n"),
            });
          }
          const item = result.snapshot.items.find(
            (candidate) => candidate.routineId === result.routineId,
          );
          if (!item) throw new Error(m.routines_mutation_blocked());
          onCreated({ itemId: item.id, snapshot: result.snapshot });
          return;
        }
        throw new Error(m.routines_mutation_blocked());
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [onCreated, owner],
  );

  return { create, pending };
}
