import type { Page } from "./types";
import type { SavePageFieldOptions } from "./field-save";

interface FieldDraft {
  value: unknown;
  options: SavePageFieldOptions;
}
export interface ReadmeWriteOptions {
  page: Page | null;
  canWrite: boolean;
  create: () => Promise<Page>;
  save: (
    page: Page,
    field: string,
    value: unknown,
    options: SavePageFieldOptions,
  ) => Promise<unknown>;
  flushFields: () => Promise<void>;
}

export class ReadmeWriteSession {
  constructor(readonly targetKey = "") {}
  private active = true;
  private options: ReadmeWriteOptions | null = null;
  private page: Page | null = null;
  private creation: Promise<Page> | null = null;
  private creationRequested = false;
  private drafts = new Map<string, FieldDraft>();
  private writes = new Set<Promise<unknown>>();
  private error: unknown = null;
  private listeners = new Set<() => void>();
  private snapshot = {
    drafts: new Map<string, FieldDraft>(),
    writeError: null as string | null,
  };

  configure(options: ReadmeWriteOptions) {
    this.options = options;
    this.page = options.page;
  }
  activate() {
    this.active = true;
  }
  dispose() {
    this.active = false;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private notify() {
    this.snapshot = {
      drafts: new Map(this.drafts),
      writeError: this.error ? String(this.error) : null,
    };
    if (this.active) for (const listener of this.listeners) listener();
  }
  private writable() {
    if (!this.active || !this.options?.canWrite)
      throw new Error("Page is not editable");
    return this.options;
  }
  createReadme = (): Promise<Page> => {
    const options = this.writable();
    if (this.page) {
      this.creationRequested = false;
      if (!this.drafts.size && this.error) {
        this.error = null;
        this.notify();
      }
      return Promise.resolve(this.page);
    }
    if (this.creation) return this.creation;
    this.creationRequested = true;
    const request = options
      .create()
      .then((created) => {
        this.writable();
        this.page = created;
        this.creationRequested = false;
        if (!this.drafts.size) this.error = null;
        return created;
      })
      .catch((error: unknown) => {
        this.error = error;
        throw error;
      })
      .finally(() => {
        this.creation = null;
        this.notify();
      });
    this.creation = request;
    return request;
  };
  private saveDraft(field: string, draft: FieldDraft) {
    const request = (async () => {
      const target = this.page ?? (await this.createReadme());
      const options = this.writable();
      if (this.drafts.get(field) !== draft) return;
      await options.save(target, field, draft.value, draft.options);
      if (this.drafts.get(field) === draft) this.drafts.delete(field);
      if (!this.drafts.size) this.error = null;
    })()
      .catch((error: unknown) => {
        if (this.drafts.get(field) === draft) this.error = error;
        throw error;
      })
      .finally(() => {
        this.writes.delete(request);
        this.notify();
      });
    this.writes.add(request);
    return request;
  }
  updateField = async (
    field: string,
    value: unknown,
    options: SavePageFieldOptions = {},
  ) => {
    this.writable();
    if (
      !this.page &&
      !this.creationRequested &&
      (value === "" || value === null)
    )
      return;
    const draft = { value, options };
    this.drafts.set(field, draft);
    this.notify();
    await this.saveDraft(field, draft);
  };
  flush = async () => {
    if (this.creation) await this.creation;
    await this.options?.flushFields();
    await Promise.all([...this.writes]);
    if (this.error) throw this.error;
  };
  retry = async () => {
    this.writable();
    if (this.creationRequested) await this.createReadme();
    await Promise.all(
      [...this.drafts].map(([field, draft]) => this.saveDraft(field, draft)),
    );
    await this.flush();
  };
}
