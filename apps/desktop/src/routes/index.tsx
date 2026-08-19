import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/features/home";
import { useAppLocale } from "@/features/settings";

export const Route = createFileRoute("/")({
  component: LocalizedHomeRoute,
});

function LocalizedHomeRoute() {
  // TanStack retains matched route trees across parent renders, so the route
  // surface subscribes directly to the locale projection.
  useAppLocale();
  return <HomePage />;
}
