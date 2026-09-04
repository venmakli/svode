import {
  Bot,
  FileText,
  ListChecks,
  Paperclip,
  PanelsTopLeft,
  TableProperties,
  UsersRound,
} from "lucide-react";
import {
  hasScopeCapability,
  ScopeSurfaceUnavailable,
  SCOPE_SURFACE_ORDER,
  type ScopeSurfaceContribution,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";
import { createElement } from "react";
import * as m from "@/paraglide/messages.js";

type ScopeSurfaceRenderer = ScopeSurfaceContribution["render"];
type ScopeSurfaceRenderers = Partial<
  Record<ScopeSurfaceId, ScopeSurfaceRenderer>
>;

export function createScopeSurfaceContributions(
  renderers: ScopeSurfaceRenderers = {},
): ScopeSurfaceContribution[] {
  const unavailable = () => createElement(ScopeSurfaceUnavailable);

  return [
    {
      id: "readme",
      order: SCOPE_SURFACE_ORDER.readme,
      presentations: ["full", "compact"],
      appliesTo: () => true,
      label: m.scope_surface_readme(),
      icon: FileText,
      render: renderers.readme ?? (() => null),
    },
    {
      id: "app",
      order: SCOPE_SURFACE_ORDER.app,
      presentations: ["full", "compact"],
      appliesTo: (owner) => hasScopeCapability(owner, "app"),
      label: m.scope_surface_app(),
      icon: PanelsTopLeft,
      fillAvailableSpace: true,
      render: renderers.app ?? unavailable,
    },
    {
      id: "attachments",
      order: SCOPE_SURFACE_ORDER.attachments,
      presentations: ["full"],
      appliesTo: (owner) => hasScopeCapability(owner, "space"),
      label: m.scope_surface_attachments(),
      icon: Paperclip,
      render: renderers.attachments ?? unavailable,
    },
    {
      id: "actors",
      order: SCOPE_SURFACE_ORDER.actors,
      presentations: ["full"],
      appliesTo: (owner) => hasScopeCapability(owner, "space"),
      label: m.scope_surface_actors(),
      icon: UsersRound,
      render: renderers.actors ?? unavailable,
    },
    {
      id: "collection",
      order: SCOPE_SURFACE_ORDER.collection,
      presentations: ["full", "compact"],
      appliesTo: (owner) => hasScopeCapability(owner, "collection"),
      label: m.scope_surface_collection(),
      icon: TableProperties,
      render: renderers.collection ?? (() => null),
    },
    {
      id: "routines",
      order: SCOPE_SURFACE_ORDER.routines,
      presentations: ["full", "compact"],
      appliesTo: (owner) =>
        hasScopeCapability(owner, "space") ||
        hasScopeCapability(owner, "collection"),
      label: m.scope_surface_routines(),
      icon: ListChecks,
      render: renderers.routines ?? unavailable,
    },
    {
      id: "context",
      order: SCOPE_SURFACE_ORDER.context,
      presentations: ["full"],
      appliesTo: (owner) => hasScopeCapability(owner, "space"),
      label: m.scope_surface_context(),
      icon: Bot,
      render: renderers.context ?? unavailable,
    },
  ];
}
