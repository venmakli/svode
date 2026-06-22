import { Outlet } from "@tanstack/react-router";
import { IdentityDialog } from "@/features/identity";
import { useIdentityCheck } from "@/features/identity";
import { useIdentityGateState } from "@/features/identity";
import { SettingsDialogs } from "./settings-dialogs";

export function IdentityGate() {
  useIdentityCheck();
  const { loaded, source } = useIdentityGateState();

  if (!loaded) {
    return <div className="h-screen w-screen" />;
  }

  if (source === "missing") {
    return <IdentityDialog open={true} />;
  }

  return (
    <>
      <Outlet />
      <SettingsDialogs />
    </>
  );
}
