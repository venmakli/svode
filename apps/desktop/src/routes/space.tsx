import { createFileRoute } from "@tanstack/react-router";
import { MainLayout } from "@/app/shell";

export const Route = createFileRoute("/space")({
  component: MainLayout,
});
