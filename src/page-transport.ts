import { UsageError } from "./args.ts";
import { PlaneClient, PlaneError, type RequestOptions } from "./client.ts";
import type { Config } from "./config.ts";
import { type PageCapability, PageCapabilityCache } from "./page-cache.ts";
import type { SessionClient } from "./session.ts";

export interface LiveCredentials {
  token: string;
  release?: string;
}
export interface PageClient {
  readonly config: Config;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  listAll<T>(path: string, options?: RequestOptions): Promise<ReadonlyArray<T>>;
  preparePages?(projectId: string): Promise<void>;
  liveCredentials?(writable: boolean, refresh?: boolean): Promise<LiveCredentials | undefined>;
}
interface RuntimeConfiguration {
  release: string | null;
  extensions: Array<{ id: string; enabled: boolean }>;
}

/** Choose capabilities, never fall back from an authorization failure. */
export class AutoPageClient implements PageClient {
  readonly config: Config;
  private readonly api: PlaneClient;
  private readonly cache: PageCapabilityCache;
  private readonly sessionDirectory: string | undefined;
  private selection?: PageCapability;
  private initialized = false;
  private sessionClient?: SessionClient;
  private prepared = new Set<string>();
  private firstLists = new Map<string, unknown>();
  private readonly refresh: boolean;

  constructor(
    config: Config,
    options: { refresh?: boolean; cache?: PageCapabilityCache; sessionDirectory?: string } = {},
  ) {
    this.config = config;
    this.api = new PlaneClient(config);
    this.cache = options.cache ?? new PageCapabilityCache(config.url.value);
    this.refresh = options.refresh ?? false;
    this.sessionDirectory = options.sessionDirectory;
  }

  private async runtime(): Promise<RuntimeConfiguration | undefined> {
    let value: RuntimeConfiguration;
    try {
      value = await this.api.request<RuntimeConfiguration>("/api/extensions/configuration/");
    } catch (error) {
      if (error instanceof PlaneError && error.status === 404) return undefined;
      throw error;
    }
    if (
      !value ||
      !Array.isArray(value.extensions) ||
      !value.extensions.every(
        (entry) => entry && typeof entry.id === "string" && typeof entry.enabled === "boolean",
      ) ||
      !(value.release === null || typeof value.release === "string")
    )
      throw new PlaneError("Invalid extension configuration; page access could not be determined.");
    return value;
  }

  private async selectSession(original?: PlaneError): Promise<void> {
    const runtime = await this.runtime();
    if (runtime?.extensions.some((entry) => entry.id === "api-key-pages" && entry.enabled)) {
      if (original) throw original;
      throw new UsageError(
        "This Plane supports API-key pages. Set PLANE_API_KEY or --token before using page commands.",
      );
    }
    this.selection = await this.cache.write(
      "session",
      runtime ? "extension-disabled" : "missing-route",
      !!runtime,
      !!this.config.token.value,
    );
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.refresh) await this.cache.clear();
    this.selection = this.refresh ? undefined : await this.cache.read();
    // A selection made without a key cannot suppress a newly configured key probe.
    if (this.config.token.value && this.selection && !this.selection.keyProbe)
      this.selection = undefined;
    if (!this.config.token.value) {
      if (this.selection?.mode === "api-key")
        throw new UsageError("Set PLANE_API_KEY or --token to use this instance's API-key pages.");
      if (!this.selection) await this.selectSession();
    }
    this.initialized = true;
  }

  private async session(): Promise<SessionClient> {
    if (!this.sessionClient) {
      const [{ SessionClient }, { resolveSessionConfig }] = await Promise.all([
        import("./session.ts"),
        import("./session-config.ts"),
      ]);
      this.sessionClient = new SessionClient(
        resolveSessionConfig(this.config, this.sessionDirectory),
      );
    }
    return this.sessionClient;
  }

  async preparePages(projectId: string): Promise<void> {
    await this.initialize();
    if (this.prepared.has(projectId)) return;
    if (!this.selection) {
      const path = `projects/${projectId}/pages/`;
      try {
        const rows = await this.api.request<unknown>(path);
        this.validateList(rows, path);
        this.selection = await this.cache.write("api-key", "public-list", true, true);
        this.firstLists.set(path, rows);
      } catch (error) {
        if (!(error instanceof PlaneError) || error.status !== 404) throw error;
        await this.selectSession(error);
      }
    }
    if (this.selection?.mode === "session") await this.session();
    this.prepared.add(projectId);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.initialize();
    const match = /^projects\/([^/]+)\/pages\//.exec(path);
    if (match?.[1]) await this.preparePages(match[1]);
    if (this.selection?.mode === "session") return (await this.session()).request<T>(path, options);
    if ((options.method ?? "GET") === "GET" && !options.query && this.firstLists.has(path)) {
      const rows = this.firstLists.get(path);
      this.firstLists.delete(path);
      return rows as T;
    }
    try {
      return await this.api.request<T>(path, options);
    } catch (error) {
      if (
        error instanceof PlaneError &&
        error.status === 404 &&
        /^projects\/[^/]+\/pages\/$/.test(path) &&
        (options.method ?? "GET") === "GET" &&
        !options.query?.cursor
      ) {
        await this.cache.clear();
        await this.selectSession(error);
        return (await this.session()).request<T>(path, options);
      }
      throw error;
    }
  }

  private validateList(
    value: unknown,
    path: string,
  ): asserts value is
    | { results: unknown[]; next_page_results?: boolean; next_cursor?: string }
    | unknown[] {
    if (
      !Array.isArray(value) &&
      (!value ||
        typeof value !== "object" ||
        !("results" in value) ||
        !Array.isArray(value.results))
    )
      throw new PlaneError(`Unexpected page list response: ${path}`);
  }

  async listAll<T>(path: string, options: RequestOptions = {}): Promise<ReadonlyArray<T>> {
    const rows: T[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const value = await this.request<unknown>(
        path,
        cursor ? { ...options, query: { ...options.query, cursor } } : options,
      );
      this.validateList(value, path);
      if (Array.isArray(value)) return [...rows, ...(value as T[])];
      rows.push(...(value.results as T[]));
      cursor = value.next_page_results ? value.next_cursor : undefined;
      if (cursor) {
        if (seen.has(cursor)) throw new PlaneError("Page API repeated a pagination cursor.");
        seen.add(cursor);
      }
    } while (cursor);
    return rows;
  }

  async liveCredentials(writable: boolean, refresh = false): Promise<LiveCredentials | undefined> {
    if (this.selection?.mode !== "session") return undefined;
    const client = await this.session();
    const session = await client.session(refresh);
    // Always negotiate the current release, including an upgrade within the cache TTL.
    const runtime = await this.runtime();
    if (runtime && !runtime.release)
      throw new PlaneError("The for-plane runtime has no active extension release.");
    return {
      token: JSON.stringify({
        id: session.userId,
        cookie: `session-id=${session.sessionId}; csrftoken=${session.csrf}`,
        readOnly: !writable,
      }),
      ...(runtime?.release ? { release: runtime.release } : {}),
    };
  }
}
