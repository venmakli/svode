import { useEffect, useRef, useState } from "react";
import {
  getParentAuthChallenge,
  refreshGitPublication,
  retryParentPublication,
} from "../api/git-publication-actions";
import { saveGitRemoteCredentials } from "../api/git-actions";
import {
  useGitStore,
  type GitAuthChallenge,
  type GitRemoteAuthCredentials,
} from "../model";
import { parentRecoveryAction } from "../model/publication";
import { repositoryAccessOwner } from "../model/repository-access-owner";
import * as m from "@/paraglide/messages.js";

export function useParentPublication(spacePath: string | null) {
  const publication = useGitStore((s) =>
    spacePath ? s.publications[spacePath] : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [verifiedChallenge, setVerifiedChallenge] =
    useState<GitAuthChallenge | null>(null);
  const active = useRef<object | null>(null);
  useEffect(() => {
    const identity = {};
    active.current = identity;
    setBusy(false);
    setError(null);
    setAuthOpen(false);
    setVerifiedChallenge(null);
    if (spacePath) void refreshGitPublication(spacePath).catch(() => {});
    return () => {
      active.current = null;
    };
  }, [spacePath]);
  const action = parentRecoveryAction(publication);
  const challenge =
    publication?.parent.result?.type === "AuthRequired"
      ? publication.parent.result.challenge
      : verifiedChallenge;
  async function run() {
    if (!spacePath || !publication || busy || action === "none") return;
    if (action === "authenticate" && challenge) {
      setAuthOpen(true);
      return;
    }
    const identity = active.current;
    setBusy(true);
    setError(null);
    try {
      if (action === "verify") {
        const snapshot = await repositoryAccessOwner.verify(
          publication.parent.repository,
        );
        if (active.current !== identity) return;
        await refreshGitPublication(spacePath);
        if (snapshot?.reason === "auth_required") {
          const nextChallenge = await getParentAuthChallenge(
            publication.parent.repository,
          );
          if (active.current !== identity) return;
          setVerifiedChallenge(nextChallenge);
          setAuthOpen(!!nextChallenge);
        }
      } else {
        await retryParentPublication(spacePath, publication);
      }
    } catch {
      if (active.current === identity) setError(m.git_publication_failed());
      await refreshGitPublication(spacePath).catch(() => {});
    } finally {
      if (active.current === identity) setBusy(false);
    }
  }
  async function saveAuthAndRetry(credentials: GitRemoteAuthCredentials) {
    if (!spacePath || !publication || !challenge?.remoteUrl || busy) return;
    const identity = active.current;
    setBusy(true);
    setError(null);
    try {
      await saveGitRemoteCredentials({
        ...credentials,
        remoteUrl: challenge.remoteUrl,
      });
      if (active.current !== identity) return;
      const access = await repositoryAccessOwner.verify(
        publication.parent.repository,
      );
      if (active.current !== identity) return;
      if (access?.status !== "writable" && access?.status !== "local") {
        setError(m.git_remote_auth_invalid_error());
        return;
      }
      await retryParentPublication(spacePath, publication);
      if (active.current === identity) setAuthOpen(false);
    } catch {
      if (active.current === identity) setError(m.git_publication_failed());
    } finally {
      if (active.current === identity) setBusy(false);
    }
  }
  const label =
    action === "verify"
      ? m.git_publication_verify()
      : action === "authenticate"
        ? m.git_publication_auth_action()
        : action === "resolve"
          ? m.git_publication_continue()
          : m.git_publication_retry();
  return {
    publication,
    action,
    label,
    busy,
    error,
    run,
    authOpen,
    setAuthOpen,
    challenge,
    saveAuthAndRetry,
  };
}
