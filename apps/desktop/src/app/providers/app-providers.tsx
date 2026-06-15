import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { DogfoodUpdateNotifier } from "@/features/updates";
import { IdentityGate } from "./identity-gate";

export function AppProviders() {
  return (
    <ThemeProvider defaultTheme="system">
      <DogfoodUpdateNotifier />
      <IdentityGate />
      <Toaster />
    </ThemeProvider>
  );
}
