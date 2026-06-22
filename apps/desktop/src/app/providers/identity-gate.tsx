import { Outlet } from "@tanstack/react-router";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { IdentityDialog } from "@/features/identity";
import { useIdentityCheck } from "@/features/identity";
import { useIdentityGateState } from "@/features/identity";
import { SettingsDialogs } from "./settings-dialogs";

export function IdentityGate() {
  useIdentityCheck();
  const { loaded, loading, loadError, source, retryLoad } =
    useIdentityGateState();

  if (loadError) {
    return (
      <IdentityLoadError
        loading={loading}
        onRetry={() => {
          void retryLoad().catch((err) => {
            console.error("load global identity failed:", err);
          });
        }}
      />
    );
  }

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

function IdentityLoadError({
  loading,
  onRetry,
}: {
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col gap-3 text-center">
        <h1 className="text-lg font-semibold">
          {m.identity_load_error_title()}
        </h1>
        <p className="text-sm text-muted-foreground">
          {m.identity_load_error_description()}
        </p>
        <div className="pt-1">
          <Button onClick={onRetry} disabled={loading}>
            {m.identity_load_retry()}
          </Button>
        </div>
      </div>
    </div>
  );
}
