import type {
  AttachmentOwnerInput,
  AttachmentRow,
  AttachmentsSnapshot,
  AttachmentsSourceState,
} from "./types";
import { sameRuntimePath } from "./types";

export interface AttachmentBranch {
  target: AttachmentRow;
  snapshot?: AttachmentsSnapshot;
  loading: boolean;
  error: string | null;
  request: number;
}

export interface AttachmentSourceView {
  state: AttachmentsSourceState;
  branches: ReadonlyMap<string, AttachmentBranch>;
  expanded: ReadonlySet<string>;
}

// One mounted owner owns root, branch requests and the reachable target inventory.
export class AttachmentSourceSession {
  private active = true;
  private rootRequest = 0;
  private branchRequest = 0;
  private observed = new Set<string>();
  private peekAncestors = new Set<string>();
  private view: AttachmentSourceView = {
    state: { phase: "initial" },
    branches: new Map(),
    expanded: new Set(),
  };

  constructor(
    private readonly owner: AttachmentOwnerInput,
    private readonly read: (
      input: AttachmentOwnerInput,
    ) => Promise<AttachmentsSnapshot>,
    private readonly publish: (
      view: AttachmentSourceView,
      inventory: AttachmentsSnapshot | null,
    ) => void,
  ) {}

  dispose() {
    this.active = false;
  }
  get current() {
    return this.view;
  }

  inventory(): AttachmentsSnapshot | null {
    if (this.view.state.phase !== "ready") return null;
    const root = this.view.state.snapshot;
    const rows = [...root.rows];
    const generations = [root.generation];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (!row.ownerPath) continue;
      const branch = this.view.branches.get(row.ownerPath);
      if (branch?.snapshot && sameBranchTarget(row, branch.target)) {
        rows.push(...branch.snapshot.rows);
        generations.push(`${row.ownerPath}:${branch.snapshot.generation}`);
      }
    }
    return { ...root, rows, generation: generations.join("\0") };
  }

  private emit() {
    const inventory = this.inventory();
    const targets = new Map(
      inventory?.rows
        .filter((row) => row.ownerPath)
        .map((row) => [row.ownerPath!, row]),
    );
    const branches = new Map(this.view.branches);
    const expanded = new Set(this.view.expanded);
    for (const [path, branch] of branches) {
      const target = targets.get(path);
      if (!target || !sameBranchTarget(target, branch.target)) {
        branches.delete(path);
        expanded.delete(path);
      }
    }
    this.view = { ...this.view, branches, expanded };
    this.publish(this.view, this.inventory());
  }

  async refreshRoot() {
    const request = ++this.rootRequest;
    try {
      const snapshot = await this.read(this.owner);
      if (!this.active || request !== this.rootRequest) return;
      if (!this.matchesOwner(snapshot))
        throw new Error("Attachments owner changed");
      this.view = {
        ...this.view,
        state: { phase: "ready", snapshot, refreshError: null },
      };
    } catch (error) {
      if (!this.active || request !== this.rootRequest) return;
      const message = sourceError(error);
      this.view = {
        ...this.view,
        state:
          this.view.state.phase === "ready"
            ? { ...this.view.state, refreshError: message }
            : { phase: "blocking_error", message },
      };
    }
    this.emit();
  }

  invalidate() {
    this.rootRequest++;
    this.view = {
      ...this.view,
      branches: new Map(
        [...this.view.branches].map(([path, branch]) => [
          path,
          { ...branch, request: ++this.branchRequest },
        ]),
      ),
    };
  }

  private visibleBranches() {
    const paths = new Set([...this.observed, ...this.peekAncestors]);
    if (this.view.state.phase !== "ready") return paths;
    const visit = (rows: readonly AttachmentRow[]) => {
      for (const row of rows) {
        if (!row.ownerPath || !this.view.expanded.has(row.ownerPath)) continue;
        paths.add(row.ownerPath);
        visit(this.view.branches.get(row.ownerPath)?.snapshot?.rows ?? []);
      }
    };
    visit(this.view.state.snapshot.rows);
    for (const path of this.observed)
      visit(this.view.branches.get(path)?.snapshot?.rows ?? []);
    return paths;
  }

  async refresh() {
    await this.refreshRoot();
    // Parent snapshots settle before descendants so removed nodes cannot republish.
    const paths = [...this.view.branches.keys()].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const path of paths) {
      if (this.visibleBranches().has(path)) await this.loadBranch(path);
    }
  }

  observe(path: string) {
    this.observed.add(path);
    void this.refreshBranchTree(path);
    return () => {
      this.observed.delete(path);
    };
  }

  toggle(path: string) {
    const expanded = new Set(this.view.expanded);
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    this.view = { ...this.view, expanded };
    this.emit();
    if (expanded.has(path)) void this.refreshBranchTree(path);
  }

  retainPeekTarget(row: AttachmentRow) {
    this.peekAncestors = new Set(
      [...this.view.branches.keys()].filter((path) =>
        row.path.startsWith(`${path}/`),
      ),
    );
    return () => {
      this.peekAncestors.clear();
    };
  }

  private async refreshBranchTree(path: string) {
    await this.loadBranch(path);
    if (
      !this.active ||
      (!this.view.expanded.has(path) && !this.observed.has(path))
    )
      return;
    const children = this.view.branches.get(path)?.snapshot?.rows ?? [];
    for (const child of children) {
      if (child.ownerPath && this.view.expanded.has(child.ownerPath))
        await this.refreshBranchTree(child.ownerPath);
    }
  }

  async loadBranch(path: string) {
    const target = this.inventory()?.rows.find((row) => row.ownerPath === path);
    if (!target || !this.active) return;
    const request = ++this.branchRequest;
    const previous = this.view.branches.get(path);
    const branch: AttachmentBranch = {
      target,
      request,
      loading: true,
      error: null,
      ...(previous && sameBranchTarget(target, previous.target)
        ? { snapshot: previous.snapshot }
        : {}),
    };
    this.view = {
      ...this.view,
      branches: new Map(this.view.branches).set(path, branch),
    };
    this.emit();
    try {
      const snapshot = await this.read({ ...this.owner, branchPath: path });
      if (!this.isCurrentBranch(path, request, target)) return;
      if (!this.matchesOwner(snapshot))
        throw new Error("Attachments owner changed");
      this.view = {
        ...this.view,
        branches: new Map(this.view.branches).set(path, {
          ...branch,
          snapshot,
          loading: false,
        }),
      };
    } catch (error) {
      if (!this.isCurrentBranch(path, request, target)) return;
      this.view = {
        ...this.view,
        branches: new Map(this.view.branches).set(path, {
          ...branch,
          loading: false,
          error: sourceError(error),
        }),
      };
    }
    this.emit();
  }

  private isCurrentBranch(
    path: string,
    request: number,
    target: AttachmentRow,
  ) {
    const current = this.inventory()?.rows.find(
      (row) => row.ownerPath === path,
    );
    return (
      this.active &&
      this.view.branches.get(path)?.request === request &&
      Boolean(current && sameBranchTarget(current, target))
    );
  }

  private matchesOwner(snapshot: AttachmentsSnapshot) {
    return (
      sameRuntimePath(snapshot.owner.projectPath, this.owner.projectPath) &&
      snapshot.owner.spaceId === this.owner.spaceId &&
      snapshot.owner.ownerPath === this.owner.ownerPath
    );
  }
}

function sameBranchTarget(left: AttachmentRow, right: AttachmentRow) {
  return (
    left.key === right.key &&
    left.kind === right.kind &&
    left.contentPath === right.contentPath &&
    left.hasApp === right.hasApp
  );
}

function sourceError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
