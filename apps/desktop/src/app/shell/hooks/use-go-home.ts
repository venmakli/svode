import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSpace } from "@/features/space";
import { passNavigationGuards } from "../navigation-guards";

/** Goes Home once the peek stack and the main area let the navigation pass. */
export function useGoHome() {
  const navigate = useNavigate();
  const goHome = useSpace((s) => s.goHome);
  return useCallback(async () => {
    if (!(await passNavigationGuards())) return;
    goHome();
    navigate({ to: "/" });
  }, [goHome, navigate]);
}
