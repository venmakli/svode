import { useIdentityStore } from "../model";

export function useIdentityGateState() {
  const loaded = useIdentityStore((state) => state.loaded);
  const source = useIdentityStore((state) => state.source);

  return { loaded, source };
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
