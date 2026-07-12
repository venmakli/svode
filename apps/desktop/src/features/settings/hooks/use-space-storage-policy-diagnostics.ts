import { useCallback, useEffect, useRef, useState } from "react";
import { diagnoseLfsPolicy, type LfsPolicyDiagnostic } from "../api";
import { storageTargetKey } from "../model/storage-strategy";

interface UseSpaceStoragePolicyDiagnosticsOptions {
  open: boolean;
  projectPath: string;
  currentSpaceId: string | null;
  enabled: boolean;
}

export function useSpaceStoragePolicyDiagnostics({
  open,
  projectPath,
  currentSpaceId,
  enabled,
}: UseSpaceStoragePolicyDiagnosticsOptions) {
  const targetKey = storageTargetKey(projectPath, currentSpaceId);
  const active = open && enabled && Boolean(projectPath);
  const [diagnostic, setDiagnostic] = useState<LfsPolicyDiagnostic | null>(
    null,
  );
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestIdRef = useRef(0);
  const targetKeyRef = useRef(targetKey);
  const diagnosticTargetKeyRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  targetKeyRef.current = targetKey;
  activeRef.current = active;

  const load = useCallback(async () => {
    if (!activeRef.current || targetKeyRef.current !== targetKey) {
      return;
    }
    const requestId = ++requestIdRef.current;
    if (diagnosticTargetKeyRef.current !== targetKey) {
      setDiagnostic(null);
    }
    setLoading(true);
    setError(false);
    try {
      const next = await diagnoseLfsPolicy({
        projectPath,
        spaceId: currentSpaceId,
      });
      if (
        requestId === requestIdRef.current &&
        activeRef.current &&
        targetKeyRef.current === targetKey
      ) {
        setDiagnostic(next);
        setLoadedTargetKey(targetKey);
        diagnosticTargetKeyRef.current = targetKey;
      }
    } catch (err) {
      console.warn("diagnose_lfs_policy failed:", err);
      if (
        requestId === requestIdRef.current &&
        activeRef.current &&
        targetKeyRef.current === targetKey
      ) {
        if (diagnosticTargetKeyRef.current !== targetKey) {
          setDiagnostic(null);
        }
        setLoadedTargetKey(targetKey);
        setError(true);
      }
    } finally {
      if (
        requestId === requestIdRef.current &&
        activeRef.current &&
        targetKeyRef.current === targetKey
      ) {
        setLoading(false);
      }
    }
  }, [currentSpaceId, projectPath, targetKey]);

  useEffect(() => {
    if (!active) {
      requestIdRef.current += 1;
      setDiagnostic(null);
      setLoadedTargetKey(null);
      setLoading(false);
      setError(false);
      diagnosticTargetKeyRef.current = null;
      return;
    }
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [active, load]);

  return {
    lfsPolicyDiagnostic: loadedTargetKey === targetKey ? diagnostic : null,
    lfsPolicyDiagnosticLoading:
      loadedTargetKey === null || loadedTargetKey === targetKey
        ? loading
        : false,
    lfsPolicyDiagnosticError: loadedTargetKey === targetKey && error,
    reloadLfsPolicyDiagnostic: load,
  };
}
