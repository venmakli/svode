import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import { repositoryAccessDenialFromError } from "../api/repository-access-api";
import type {
  RepositoryAccessBlocker,
  RepositoryAccessDenial,
} from "../model/repository-access";
import {
  allowsRepositoryMutation,
  blockingRepositoryAccessTargets,
  dedupeRepositoryAccessTargets,
  type RepositoryAccessRequest,
  type RepositoryAccessTarget,
  type RepositoryAccessTargetView,
} from "../model/repository-access-consumer";
import { repositoryAccessOwner } from "../model/repository-access-owner";
import {
  repositoryOwner,
  repositorySettingsOpener,
  type RepositoryOwnerContext,
} from "../model/repository-owner";
import { repositoryAccessPresentation } from "../ui/repository-access-copy";

interface PendingRepositoryAccessRequest extends RepositoryAccessRequest {
  attemptId: number;
  /** A late denial the recovery set answers; readiness never outruns it. */
  denial?: RepositoryAccessDenial;
  phase: "loading" | "ready";
  planChanged?: boolean;
}

export function useRepositoryAccessPreflight() {
  const ownerVersion = useSyncExternalStore(
    repositoryAccessOwner.subscribe,
    repositoryAccessOwner.getVersion,
    repositoryAccessOwner.getVersion,
  );
  const ownerContext = useSpace(
    (state): RepositoryOwnerContext => ({
      projectName: state.activeRootName,
      projectPath: state.activeRootPath,
      spaces: state.spaces,
    }),
  );
  const ownerContextRef = useRef(ownerContext);
  const [pending, setPending] = useState<PendingRepositoryAccessRequest | null>(
    null,
  );
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const attemptIdRef = useRef(0);
  const actionPromiseRef = useRef<Promise<void> | null>(null);
  const pendingTargets = pending?.targets ?? null;
  const retainedPaths = useMemo(
    () =>
      pendingTargets
        ? [...new Set(pendingTargets.map((target) => target.repositoryPath))]
        : [],
    [pendingTargets],
  );

  const targetViews = useMemo(() => {
    void ownerVersion;
    return pending
      ? dedupeRepositoryAccessTargets(
          pending.targets,
          repositoryAccessOwner.getSnapshot,
        )
      : [];
  }, [ownerVersion, pending]);
  const projectPath = ownerContext.projectPath;
  const blockers = useMemo(() => {
    const blocking = blockingRepositoryAccessTargets(targetViews);
    const unresolved = pending?.denial
      ? unresolvedDenialView(pending.denial, targetViews, projectPath)
      : null;
    return unresolved ? [...blocking, unresolved] : blocking;
  }, [pending, projectPath, targetViews]);
  const primaryBlocker =
    blockers.find(({ target }) => target.repositoryPath) ?? null;
  const primaryPresentation = useMemo(
    () =>
      primaryBlocker
        ? repositoryAccessPresentation(primaryBlocker.access)
        : null,
    [primaryBlocker],
  );
  const planChanged = Boolean(pending?.planChanged);
  const readyToRetry =
    Boolean(pending) &&
    pending?.phase === "ready" &&
    !planChanged &&
    blockers.length === 0 &&
    pending.continuation === "explicit";
  const checking = blockers.some(
    ({ access }) =>
      access.verifying ||
      (!access.error && access.snapshot?.status === "checking"),
  );
  const busy = acting || pending?.phase === "loading" || checking;
  const open = pending?.phase === "ready";

  useEffect(() => {
    ownerContextRef.current = ownerContext;
  }, [ownerContext]);

  useEffect(() => {
    if (retainedPaths.length === 0) return;
    const releases = retainedPaths.map((repositoryPath) =>
      repositoryAccessOwner.retain(repositoryPath, { refresh: false }),
    );
    return () => releases.forEach((release) => release());
  }, [retainedPaths]);

  const close = useCallback(() => {
    attemptIdRef.current += 1;
    actionPromiseRef.current = null;
    setActing(false);
    setRecommendationsOpen(false);
    setPending(null);
  }, []);

  const continueRequest = useCallback(
    async (request: PendingRepositoryAccessRequest) => {
      if (request.attemptId !== attemptIdRef.current) return;
      setPending(null);
      setRecommendationsOpen(false);
      await request.continue();
    },
    [],
  );

  const maybeContinueAutomatically = useCallback(
    async (request: PendingRepositoryAccessRequest) => {
      const currentTargets = dedupeRepositoryAccessTargets(
        request.targets,
        repositoryAccessOwner.getSnapshot,
      );
      if (
        request.continuation === "automatic" &&
        currentTargets.every(({ access }) => allowsRepositoryMutation(access))
      ) {
        await continueRequest(request);
      }
    },
    [continueRequest],
  );

  const joinCheckingTargets = useCallback(
    async (request: PendingRepositoryAccessRequest) => {
      const checkingTargets = dedupeRepositoryAccessTargets(
        request.targets,
        repositoryAccessOwner.getSnapshot,
      ).filter(
        ({ access }) =>
          access.verifying ||
          (!access.error && access.snapshot?.status === "checking"),
      );
      if (checkingTargets.length === 0) return;
      await Promise.all(
        checkingTargets.map(({ target }) =>
          repositoryAccessOwner.verify(target.repositoryPath),
        ),
      );
      await maybeContinueAutomatically(request);
    },
    [maybeContinueAutomatically],
  );

  const request = useCallback(
    async (nextRequest: RepositoryAccessRequest) => {
      const attemptId = ++attemptIdRef.current;
      const normalizedRequest: PendingRepositoryAccessRequest = {
        ...nextRequest,
        attemptId,
        phase: "loading",
        targets: Object.freeze([...nextRequest.targets]),
      };
      setRecommendationsOpen(false);
      setPending(normalizedRequest);
      await Promise.all(
        normalizedRequest.targets.map((target) =>
          repositoryAccessOwner.refresh(target.repositoryPath),
        ),
      );
      if (attemptId !== attemptIdRef.current) return;

      const currentTargets = dedupeRepositoryAccessTargets(
        normalizedRequest.targets,
        repositoryAccessOwner.getSnapshot,
      );
      if (
        currentTargets.every(({ access }) => allowsRepositoryMutation(access))
      ) {
        if (normalizedRequest.continuation === "automatic") {
          await continueRequest(normalizedRequest);
        } else {
          setPending({ ...normalizedRequest, phase: "ready" });
        }
        return;
      }

      const readyRequest = { ...normalizedRequest, phase: "ready" as const };
      setPending(readyRequest);
      await joinCheckingTargets(readyRequest);
    },
    [continueRequest, joinCheckingTargets],
  );

  const recoverFromError = useCallback(
    async (error: unknown, nextRequest: RepositoryAccessRequest) => {
      const denial = repositoryAccessDenialFromError(error);
      if (!denial) return false;
      if (denial.reason === "mutation_plan_changed") {
        if (nextRequest.onPlanChanged) {
          close();
          await nextRequest.onPlanChanged();
          return true;
        }
        // Without a domain review to return to, the consumer stays blocked
        // in a visible state whose retry plans the action again.
        attemptIdRef.current += 1;
        setRecommendationsOpen(false);
        setPending({
          ...nextRequest,
          attemptId: attemptIdRef.current,
          continuation: "explicit",
          phase: "ready",
          planChanged: true,
          targets: Object.freeze([...nextRequest.targets]),
        });
        return true;
      }

      const blockerTargets = denial.blockers.map((blocker) =>
        blockerTarget(blocker, ownerContextRef.current),
      );
      const attemptId = ++attemptIdRef.current;
      const recoveryRequest: PendingRepositoryAccessRequest = {
        ...nextRequest,
        attemptId,
        continuation: "explicit",
        denial,
        phase: "loading",
        targets: Object.freeze([...nextRequest.targets, ...blockerTargets]),
      };
      setRecommendationsOpen(false);
      setPending(recoveryRequest);

      const deniedIds = new Set([
        denial.repositoryId,
        ...denial.blockers.map(({ repositoryId }) => repositoryId),
      ]);
      const knownTargets = dedupeRepositoryAccessTargets(
        nextRequest.targets,
        repositoryAccessOwner.getSnapshot,
      );
      const exactTargets = knownTargets.filter(({ access }) =>
        deniedIds.has(access.snapshot?.repositoryId ?? ""),
      );
      const unreadTargets = knownTargets.filter(
        ({ access }) => !access.snapshot,
      );
      const targetsToRefresh =
        exactTargets.length > 0 || blockerTargets.length > 0
          ? [
              ...exactTargets.map(({ target }) => target),
              ...unreadTargets.map(({ target }) => target),
              ...blockerTargets,
            ]
          : knownTargets.map(({ target }) => target);
      await Promise.all(
        [
          ...new Set(targetsToRefresh.map((target) => target.repositoryPath)),
        ].map((repositoryPath) =>
          repositoryAccessOwner.refresh(repositoryPath),
        ),
      );
      if (attemptId === attemptIdRef.current) {
        setPending({ ...recoveryRequest, phase: "ready" });
      }
      return true;
    },
    [close],
  );

  const runAction = useCallback((action: () => Promise<void>) => {
    if (actionPromiseRef.current) return actionPromiseRef.current;
    setActing(true);
    const promise = action().finally(() => {
      if (actionPromiseRef.current === promise) {
        actionPromiseRef.current = null;
        setActing(false);
      }
    });
    actionPromiseRef.current = promise;
    return promise;
  }, []);

  const runPrimaryAction = useCallback(() => {
    if (!pending || busy) return;
    if (readyToRetry || planChanged) {
      void runAction(async () => continueRequest(pending));
      return;
    }
    if (!primaryBlocker || !primaryPresentation) return;

    if (primaryPresentation.action === "verify") {
      void runAction(async () => {
        const verifyTargets = blockers.filter(({ access, target }) => {
          const presentation = repositoryAccessPresentation(access);
          return (
            Boolean(target.repositoryPath) &&
            (presentation.action === "verify" ||
              access.verifying ||
              access.snapshot?.status === "checking")
          );
        });
        await Promise.all(
          verifyTargets.map(({ target }) =>
            repositoryAccessOwner.verify(target.repositoryPath),
          ),
        );
        await maybeContinueAutomatically(pending);
      });
      return;
    }
    if (
      primaryPresentation.action === "authenticate" ||
      primaryPresentation.action === "edit_remote"
    ) {
      primaryBlocker.target.openSettings?.();
      return;
    }
    if (primaryPresentation.action === "recommendations") {
      setRecommendationsOpen(true);
    }
  }, [
    blockers,
    busy,
    continueRequest,
    maybeContinueAutomatically,
    pending,
    planChanged,
    primaryBlocker,
    primaryPresentation,
    readyToRetry,
    runAction,
  ]);

  return useMemo(
    () => ({
      blockers,
      busy,
      close,
      open,
      pending,
      planChanged,
      primaryActionLabel:
        readyToRetry || planChanged
          ? null
          : (primaryPresentation?.actionLabel ?? null),
      primaryBlocker,
      /** The primary action itself opens the primary blocker's settings. */
      primaryOpensSettings:
        primaryPresentation?.action === "authenticate" ||
        primaryPresentation?.action === "edit_remote",
      readyToRetry,
      recommendationsOpen,
      recoverFromError,
      request,
      runPrimaryAction,
      targetViews,
    }),
    [
      blockers,
      busy,
      close,
      open,
      pending,
      planChanged,
      primaryBlocker,
      primaryPresentation,
      readyToRetry,
      recommendationsOpen,
      recoverFromError,
      request,
      runPrimaryAction,
      targetViews,
    ],
  );
}

export type RepositoryAccessPreflightController = ReturnType<
  typeof useRepositoryAccessPreflight
>;

function blockerTarget(
  blocker: RepositoryAccessBlocker,
  context: RepositoryOwnerContext,
): RepositoryAccessTarget {
  const owner = repositoryOwner(blocker.repositoryPath, context);
  return {
    displayName: owner.displayName,
    displayPath: owner.displayPath,
    repositoryPath: blocker.repositoryPath,
    openSettings: repositorySettingsOpener(owner.settingsPath),
  };
}

/**
 * A denial without a repository location that no target resolves to stays a
 * blocker: an unknown repository never lets the recovery report readiness.
 */
function unresolvedDenialView(
  denial: RepositoryAccessDenial,
  targetViews: readonly RepositoryAccessTargetView[],
  projectPath: string | null,
): RepositoryAccessTargetView | null {
  if (denial.blockers.length > 0) return null;
  if (
    targetViews.some(
      ({ access }) => access.snapshot?.repositoryId === denial.repositoryId,
    )
  )
    return null;
  return {
    access: {
      error: null,
      loading: false,
      snapshot: {
        checkedAt: null,
        expiresAt: null,
        generation: 0,
        lastKnownStatus: null,
        reason:
          denial.reason === "none" || denial.reason === "mutation_plan_changed"
            ? null
            : denial.reason,
        repositoryId: denial.repositoryId,
        status:
          denial.status === "local" || denial.status === "writable"
            ? "unknown"
            : denial.status,
      },
      spacePath: "",
      verifying: false,
    },
    target: {
      displayName: m.git_access_blocker_unknown_repository(),
      displayPath: "",
      repositoryPath: "",
      openSettings: repositorySettingsOpener(projectPath),
    },
  };
}
