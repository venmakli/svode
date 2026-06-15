import { Outlet } from "@tanstack/react-router";
import { IdentityDialog } from "@/features/identity/identity-dialog";
import { useIdentityCheck } from "@/features/identity/use-identity-check";
import { useIdentityStore } from "@/features/identity/identity-store";
import { SettingsDialogs } from "./settings-dialogs";

export function IdentityGate() {
  useIdentityCheck();
  const loaded = useIdentityStore((state) => state.loaded);
  const source = useIdentityStore((state) => state.source);

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
