import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import {
  createAgentActorId,
  mutateAgentActor,
  previewAgentActorDeleteReferences,
  toAgentActorMutationActor,
  toAgentActorModeDto,
} from "../api/agent-actors-api";
import {
  actorPersistenceNeedsAttention,
  actorRootPointerDescription,
} from "../lib/persistence-feedback";
import {
  agentActorState,
  isAgentActorPortableUnchanged,
  uniqueAgentActorName,
} from "../model/agent-actor-draft";
import type {
  AgentActorCatalogSnapshot,
  AgentActorDeleteReferenceState,
  AgentActorItem,
  AgentActorMutationApplied,
  AgentActorState,
} from "../model/agent-actor-types";
import { agentActorItemId } from "../ui/agent-actors-presentation";

/** A write the repository access refused, and how to run it again. */
export interface AgentActorAccessDenial {
  item: AgentActorItem | null;
  kind: "create" | "update" | "delete";
  ownerPath: string;
  retry(): void | Promise<void>;
}

/** The state an Agent's write left, by the version it left. */
type Written = Map<string, { state: AgentActorState; version: string }>;

/**
 * The writes of Agents (Stage 11 `04`, 4.I): each property is saved at once,
 * and a creation is a write too. The writes of one Agent run one after
 * another, each from the version and the state the previous one left. A
 * write applies while its Agent is at the version it was read at, whatever
 * else changed in the catalog; a changed Agent is a conflict without a
 * write, after which the catalog is read again. A write rejects with the
 * reason it was not saved.
 */
export function useAgentActorMutations({
  projectPath,
  refresh,
  saveCatalog,
  snapshot,
  onAccessDenied,
}: {
  projectPath: string;
  refresh(): void | Promise<void>;
  saveCatalog(ownerPath: string): void;
  snapshot: AgentActorCatalogSnapshot | null;
  onAccessDenied?(
    error: unknown,
    denial: AgentActorAccessDenial,
  ): boolean | Promise<boolean>;
}) {
  const chains = useRef(new Map<string, Promise<unknown>>());
  const written = useRef(new Map<string, Written>());
  const [deleteActor, setDeleteActor] = useState<AgentActorItem | null>(null);
  const [deleteReferences, setDeleteReferences] =
    useState<AgentActorDeleteReferenceState>({ phase: "idle" });
  const deletePreviewRequestRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * The version and the state of an Agent read at `seen`, after the writes
   * of this window that started from it.
   */
  const current = useCallback(
    (key: string, seen: string, read: AgentActorState) => {
      const writes = written.current.get(key);
      let version = seen;
      let state = read;
      const visited = new Set<string>();
      for (
        let next = writes?.get(version);
        next && !visited.has(version);
        next = writes?.get(version)
      ) {
        visited.add(version);
        version = next.version;
        state = next.state;
      }
      return { state, version };
    },
    [],
  );

  const write = useCallback(
    (
      item: AgentActorItem,
      change: (state: AgentActorState) => AgentActorState,
      seen: string = item.version,
    ): Promise<void> => {
      const key = agentActorItemId(item);
      const previous = chains.current.get(key) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          const base = current(key, seen, agentActorState(item));
          const next = change(base.state);
          const mutation = isAgentActorPortableUnchanged(next, base.state)
            ? ({
                kind: "set_mode",
                actorId: item.id,
                mode: toAgentActorModeDto(next.mode),
              } as const)
            : ({
                kind: "update",
                actor: toAgentActorMutationActor({ ...next, id: item.id }),
                mode: toAgentActorModeDto(next.mode),
              } as const);
          let result: Awaited<ReturnType<typeof mutateAgentActor>>;
          try {
            result = await mutateAgentActor({
              expectedVersion: base.version,
              mutation,
              ownerPath: item.ownerPath,
              projectPath,
            });
          } catch (error) {
            await onAccessDenied?.(error, {
              item,
              kind: "update",
              ownerPath: item.ownerPath,
              retry: () =>
                void write(item, change, seen).catch(() => undefined),
            });
            throw new Error(errorMessage(error), { cause: error });
          }
          if (result === "stale") {
            void refresh();
            throw new Error(m.agent_actors_property_stale());
          }
          if ("blocked" in result) {
            throw new Error(
              result.blocked || m.agent_actors_mutation_blocked(),
            );
          }
          if (result.version) {
            const writes = written.current.get(key) ?? new Map();
            writes.set(base.version, {
              state: { ...next, name: next.name.trim() },
              version: result.version,
            });
            written.current.set(key, writes);
          }
          showPersistenceAttention(result, () => saveCatalog(item.ownerPath));
          void refresh();
        });
      chains.current.set(key, run);
      const release = () => {
        if (chains.current.get(key) === run) chains.current.delete(key);
      };
      run.then(release, release);
      return run;
    },
    [current, onAccessDenied, projectPath, refresh, saveCatalog],
  );

  /**
   * Creates an Agent in the catalog of `ownerPath` as a page is created:
   * "New agent" (or "New agent 2", … while the catalog has that name)
   * without a description, bound to the participant's agent. Resolves to its
   * item id once the catalog shows it; null when it was not created.
   */
  const create = useCallback(
    async (ownerPath: string): Promise<string | null> => {
      if (!snapshot) return null;
      setPending(true);
      try {
        const name = uniqueAgentActorName(
          m.agent_actors_new_name(),
          snapshot.items
            .filter((item) => item.ownerPath === ownerPath)
            .map((item) => item.name),
        );
        const id = await createAgentActorId();
        const result = await mutateAgentActor({
          expectedVersion: null,
          mutation: {
            kind: "create",
            actor: toAgentActorMutationActor({
              binding: { kind: "participant" },
              description: null,
              id,
              name,
            }),
            mode: null,
          },
          ownerPath,
          projectPath,
        });
        if (result === "stale" || "blocked" in result) {
          toast.error(m.agent_actors_create_failed(), {
            description:
              result === "stale"
                ? m.agent_actors_property_stale()
                : result.blocked,
          });
          return null;
        }
        showPersistenceAttention(result, () => saveCatalog(ownerPath));
        await refresh();
        return agentActorItemId({ id, ownerPath });
      } catch (error) {
        if (
          await onAccessDenied?.(error, {
            item: null,
            kind: "create",
            ownerPath,
            retry: () => void create(ownerPath),
          })
        ) {
          return null;
        }
        toast.error(m.agent_actors_create_failed(), {
          description: errorMessage(error),
        });
        return null;
      } finally {
        setPending(false);
      }
    },
    [onAccessDenied, projectPath, refresh, saveCatalog, snapshot],
  );

  const closeDelete = useCallback(() => {
    ++deletePreviewRequestRef.current;
    setDeleteActor(null);
    setDeleteReferences({ phase: "idle" });
  }, []);
  const openDelete = useCallback(
    (item: AgentActorItem) => {
      const requestId = ++deletePreviewRequestRef.current;
      setFailure(null);
      setDeleteActor(item);
      setDeleteReferences({ phase: "loading" });
      void previewAgentActorDeleteReferences(
        projectPath,
        item.ownerPath,
        item.id,
      ).then(
        (preview) => {
          if (requestId !== deletePreviewRequestRef.current) return;
          setDeleteReferences({
            diagnostics: preview.diagnostics,
            phase: "ready",
            references: preview.references,
          });
        },
        (error: unknown) => {
          if (requestId !== deletePreviewRequestRef.current) return;
          setDeleteReferences({ phase: "error", message: errorMessage(error) });
        },
      );
    },
    [projectPath],
  );

  const confirmDelete = useCallback(
    async (item: AgentActorItem) => {
      setPending(true);
      setFailure(null);
      try {
        const key = agentActorItemId(item);
        const result = await mutateAgentActor({
          expectedVersion: current(key, item.version, agentActorState(item))
            .version,
          mutation: { kind: "delete", actorId: item.id },
          ownerPath: item.ownerPath,
          projectPath,
        });
        if (result === "stale") {
          setFailure(m.agent_actors_property_stale());
          void refresh();
          return;
        }
        if ("blocked" in result) {
          setFailure(result.blocked);
          return;
        }
        showPersistenceAttention(result, () => saveCatalog(item.ownerPath));
        closeDelete();
        await refresh();
      } catch (error) {
        if (
          await onAccessDenied?.(error, {
            item,
            kind: "delete",
            ownerPath: item.ownerPath,
            retry: () => openDelete(item),
          })
        ) {
          return;
        }
        setFailure(errorMessage(error));
      } finally {
        setPending(false);
      }
    },
    [
      closeDelete,
      current,
      onAccessDenied,
      openDelete,
      projectPath,
      refresh,
      saveCatalog,
    ],
  );

  return {
    closeDelete,
    confirmDelete,
    create,
    deleteActor,
    deleteReferences,
    failure,
    openDelete,
    pending,
    write,
  };
}

/**
 * A write that left its commit to the user, or whose commit failed, says so
 * with the way to save the catalog; a committed write needs no notice.
 */
function showPersistenceAttention(
  result: AgentActorMutationApplied,
  saveCatalog: () => void,
) {
  const rootNeedsAttention = actorPersistenceNeedsAttention(
    result.rootPointer ?? undefined,
  );
  if (
    !actorPersistenceNeedsAttention(result.persistence) &&
    !rootNeedsAttention
  )
    return;
  const action = { label: m.agent_actors_save_catalog(), onClick: saveCatalog };
  const description = rootNeedsAttention
    ? actorRootPointerDescription(result.rootPointer ?? undefined)
    : undefined;
  if (result.persistence.status === "failed") {
    toast.error(m.agent_actors_mutation_commit_failed(), {
      action,
      description: [result.persistence.message, description]
        .filter(Boolean)
        .join(" "),
    });
  } else if (result.persistence.status === "pending") {
    toast.info(m.agent_actors_mutation_pending(), { action, description });
  } else {
    toast.warning(m.agent_actors_mutation_saved(), { action, description });
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return m.agent_actors_mutation_blocked();
}
