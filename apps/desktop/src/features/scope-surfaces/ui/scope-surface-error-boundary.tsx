import { Component, type ReactNode } from "react";
import * as m from "@/paraglide/messages.js";

interface ScopeSurfaceErrorBoundaryProps {
  children: ReactNode;
}

interface ScopeSurfaceErrorBoundaryState {
  hasError: boolean;
}

export class ScopeSurfaceErrorBoundary extends Component<
  ScopeSurfaceErrorBoundaryProps,
  ScopeSurfaceErrorBoundaryState
> {
  state: ScopeSurfaceErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ScopeSurfaceErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <div className="p-6 text-sm">{m.scope_surface_render_error()}</div>;
    }

    return this.props.children;
  }
}
