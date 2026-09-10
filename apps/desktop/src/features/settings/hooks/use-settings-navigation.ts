import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SettingsDestination,
  SettingsLeaveGuard,
} from "../model/settings-destination";

export function useSettingsNavigation(
  request: SettingsDestination,
  onClose: () => void,
) {
  const [destination, setDestination] = useState(request);
  const leaveGuard = useRef<SettingsLeaveGuard | null>(null);
  const lastRequest = useRef(request);
  const registerLeaveGuard = useCallback((guard: SettingsLeaveGuard) => {
    leaveGuard.current = guard;
    return () => {
      if (leaveGuard.current === guard) leaveGuard.current = null;
    };
  }, []);
  const navigate = useCallback((next: SettingsDestination) => {
    if (leaveGuard.current && !leaveGuard.current()) return;
    setDestination(next);
  }, []);
  useEffect(() => {
    if (lastRequest.current === request) return;
    const transition = window.setTimeout(() => {
      lastRequest.current = request;
      navigate(request);
    }, 0);
    return () => window.clearTimeout(transition);
  }, [request, navigate]);
  const close = useCallback(() => {
    if (leaveGuard.current && !leaveGuard.current()) return;
    onClose();
  }, [onClose]);
  return { destination, navigate, close, registerLeaveGuard };
}
