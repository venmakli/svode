import { createFileRoute } from "@tanstack/react-router";
import { MainLayout } from "@/components/layout/main-layout";

export const Route = createFileRoute("/")({
  component: MainLayout,
});
