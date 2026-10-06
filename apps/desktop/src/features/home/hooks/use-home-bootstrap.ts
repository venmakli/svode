import { useEffect, useRef, useState } from "react";
import { useSpace } from "@/features/space";
import { useRootProjectWorkflow } from "./use-root-project-workflow";

/**
 * Home of a window: the first window of a launch may go on into the last
 * project; otherwise the projects load and Home is ready.
 */
export function useHomeBootstrap() {
  const { explicitHome, initializeHome } = useRootProjectWorkflow();
  const hasProjects = useSpace((state) => state.rootSpaces.length > 0);
  const [ready, setReady] = useState(explicitHome);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    let cancelled = false;
    void initializeHome().then((openedProject) => {
      if (!cancelled && !openedProject) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [initializeHome]);

  return { ready, hasProjects };
}
