import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { repositoryAccessDenialFromError } from "../api/repository-access-api";
import {
  allowsRepositoryMutation,
  blockingRepositoryAccessTargets,
  dedupeRepositoryAccessTargets,
  type RepositoryAccessRequest,
} from "../model/repository-access-consumer";
import { repositoryAccessOwner } from "../model/repository-access-owner";
import { repositoryAccessPresentation } from "../ui/repository-access-copy";

interface PendingRepositoryAccessRequest extends RepositoryAccessRequest {
  attemptId: number;
  phase: "loading" | "ready";
}

export function useRepositoryAccessPreflight() {
  const ownerVersion = useSyncExternalStore(
    repositoryAccessOwner.subscribe,
    repositoryAccessOwner.getVersion,
    repositoryAccessOwner.getVersion,
  );
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
  const blockers = useMemo(
    () => blockingRepositoryAccessTargets(targetViews),
    [targetViews],
  );
  const primaryBlocker = blockers[0] ?? null;
  const primaryPresentation = useMemo(
    () =>
      primaryBlocker
        ? repositoryAccessPresentation(primaryBlocker.access)
        : null,
    [primaryBlocker],
  );
  const readyToRetry =
    Boolean(pending) &&
    pending?.phase === "ready" &&
    blockers.length === 0 &&
    pending.continuation === "explicit";
  const checking = blockers.some(
    ({ access }) => access.verifying || access.snapshot?.status === "checking",
  );
  const busy = acting || pending?.phase === "loading" || checking;
  const open = pending?.phase === "ready";

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
          access.verifying || access.snapshot?.status === "checking",
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
        close();
        await nextRequest.onPlanChanged?.();
        return true;
      }

      const attemptId = ++attemptIdRef.current;
      const recoveryRequest: PendingRepositoryAccessRequest = {
        ...nextRequest,
        attemptId,
        continuation: "explicit",
        phase: "loading",
        targets: Object.freeze([...nextRequest.targets]),
      };
      setRecommendationsOpen(false);
      setPending(recoveryRequest);

      const knownTargets = dedupeRepositoryAccessTargets(
        recoveryRequest.targets,
        repositoryAccessOwner.getSnapshot,
      );
      const exactTargets = knownTargets.filter(
        ({ access }) => access.snapshot?.repositoryId === denial.repositoryId,
      );
      const targetsToRefresh =
        exactTargets.length > 0 ? exactTargets : knownTargets;
      await Promise.all(
        targetsToRefresh.map(({ target }) =>
          repositoryAccessOwner.refresh(target.repositoryPath),
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
    if (readyToRetry) {
      void runAction(async () => continueRequest(pending));
      return;
    }
    if (!primaryBlocker || !primaryPresentation) return;

    if (primaryPresentation.action === "verify") {
      void runAction(async () => {
        const verifyTargets = blockers.filter(({ access }) => {
          const presentation = repositoryAccessPresentation(access);
          return (
            presentation.action === "verify" ||
            access.verifying ||
            access.snapshot?.status === "checking"
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
    primaryBlocker,
    primaryPresentation,
    readyToRetry,
    runAction,
  ]);

  const openPrimarySettings = useCallback(() => {
    primaryBlocker?.target.openSettings?.();
  }, [primaryBlocker]);

  return useMemo(
    () => ({
      blockers,
      busy,
      close,
      open,
      openPrimarySettings,
      pending,
      primaryActionLabel: readyToRetry
        ? null
        : (primaryPresentation?.actionLabel ?? null),
      primaryHasSettings:
        Boolean(primaryBlocker?.target.openSettings) &&
        primaryPresentation?.action !== "authenticate" &&
        primaryPresentation?.action !== "edit_remote",
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
      openPrimarySettings,
      pending,
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
