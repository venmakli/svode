import { createFileRoute } from "@tanstack/react-router";
import { MainLayout } from "@/app/shell";
import { useAppLocale } from "@/features/settings";

export const Route = createFileRoute("/space")({
  component: LocalizedSpaceRoute,
});

function LocalizedSpaceRoute() {
  // TanStack retains matched route trees across parent renders, so the route
  // surface subscribes directly to the locale projection.
  useAppLocale();
  return <MainLayout />;
}
