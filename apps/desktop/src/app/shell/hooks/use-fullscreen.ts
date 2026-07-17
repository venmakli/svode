import { useEffect, useState } from "react";
import {
  isCurrentAppWindowFullscreen,
  listenCurrentAppWindowTrafficLightInset,
} from "@/platform/native/window";

const FULLSCREEN_TRANSITION_RECOVERY_MS = 3_000;

export function useTrafficLightInset() {
  const [reserved, setReserved] = useState(true);

  useEffect(() => {
    let disposed = false;
    let lifecycleVersion = 0;
    let removeListener: (() => void) | null = null;
    let recoveryTimer: number | null = null;

    const clearRecovery = () => {
      if (recoveryTimer === null) return;
      window.clearTimeout(recoveryTimer);
      recoveryTimer = null;
    };

    const reconcile = async (expectedVersion: number) => {
      try {
        const isFullscreen = await isCurrentAppWindowFullscreen();
        if (!disposed && expectedVersion === lifecycleVersion) {
          setReserved(!isFullscreen);
        }
      } catch (error) {
        console.warn("read fullscreen state failed:", error);
      }
    };

    const applyInset = (nextReserved: boolean) => {
      if (disposed) return;
      const version = ++lifecycleVersion;
      clearRecovery();
      setReserved(nextReserved);
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        void reconcile(version);
      }, FULLSCREEN_TRANSITION_RECOVERY_MS);
    };

    const initialize = async () => {
      try {
        const unlisten =
          await listenCurrentAppWindowTrafficLightInset(applyInset);
        if (disposed) {
          unlisten();
          return;
        }
        removeListener = unlisten;
      } catch (error) {
        console.warn("listen to fullscreen lifecycle failed:", error);
      }

      if (!disposed && lifecycleVersion === 0) {
        await reconcile(0);
      }
    };

    void initialize();

    return () => {
      disposed = true;
      removeListener?.();
      clearRecovery();
    };
  }, []);

  return reserved;
}
