import { useIdentityStore } from "../model";

export function useIdentityGateState() {
  const loaded = useIdentityStore((state) => state.loaded);
  const loading = useIdentityStore((state) => state.loading);
  const loadError = useIdentityStore((state) => state.loadError);
  const source = useIdentityStore((state) => state.source);
  const retryLoad = useIdentityStore((state) => state.load);

  return { loaded, loading, loadError, source, retryLoad };
}

export function useGlobalIdentity() {
  return useIdentityStore((state) => state.global);
}

export function useSaveGlobalIdentity() {
  return useIdentityStore((state) => state.saveGlobal);
}

export function useIdentityRefreshNotifier() {
  return useIdentityStore((state) => state.bumpRefreshVersion);
}
