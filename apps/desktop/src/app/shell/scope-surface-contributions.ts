import { Bot, FileText, ListChecks, TableProperties } from "lucide-react";
import {
  hasScopeCapability,
  SCOPE_SURFACE_ORDER,
  type ScopeSurfaceContribution,
} from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

export function createScopeSurfaceContributions(): ScopeSurfaceContribution[] {
  const unavailable = () => m.scope_surface_unavailable();

  return [
    {
      id: "readme",
      order: SCOPE_SURFACE_ORDER.readme,
      presentations: ["full", "compact"],
      appliesTo: () => true,
      label: m.scope_surface_readme(),
      icon: FileText,
      render: () => null,
    },
    {
      id: "collection",
      order: SCOPE_SURFACE_ORDER.collection,
      presentations: ["full", "compact"],
      appliesTo: (owner) => hasScopeCapability(owner, "collection"),
      label: m.scope_surface_collection(),
      icon: TableProperties,
      render: () => null,
    },
    {
      id: "routines",
      order: SCOPE_SURFACE_ORDER.routines,
      presentations: ["full", "compact"],
      appliesTo: () => true,
      label: m.scope_surface_routines(),
      icon: ListChecks,
      render: unavailable,
    },
    {
      id: "agent",
      order: SCOPE_SURFACE_ORDER.agent,
      presentations: ["full"],
      appliesTo: (owner) => hasScopeCapability(owner, "space"),
      label: m.scope_surface_agent(),
      icon: Bot,
      render: unavailable,
    },
  ];
}
