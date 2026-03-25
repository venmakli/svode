import { createFileRoute } from "@tanstack/react-router";
import { MainLayout } from "@/features/layout/main-layout";

export const Route = createFileRoute("/workspace")({
  component: MainLayout,
});
