import { UsageError } from "./args.ts";
import { PlaneClient, PlaneError, type RequestOptions } from "./client.ts";
import type { Config } from "./config.ts";
import {
  type NodeReaderCapability,
  PAGE_CAPABILITY_TTL,
  type PageCapability,
  PageCapabilityCache,
} from "./page-cache.ts";
import { type PageTarget, pagePlacement } from "./page-placement.ts";
import type { SessionClient } from "./session.ts";

export class PageIdentityChanged extends PlaneError {}

export interface LiveCredentials {
  token: string;
  release?: string;
}
export interface PageClient {
  readonly config: Config;
  beginPageCommand?(): void;
  markPageMutation?(): void;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  listAll<T>(path: string, options?: RequestOptions): Promise<ReadonlyArray<T>>;
  preparePages?(target: PageTarget): Promise<"changed-identity" | undefined>;
  liveCredentials?(writable: boolean, refresh?: boolean): Promise<LiveCredentials | undefined>;
  nodeReaders?(): Promise<readonly string[]>;
}

export function assertNodeReaders(required: readonly string[], supported: readonly string[]): void {
  const missing = required.filter((name) => !supported.includes(name));
  if (missing.length)
    throw new PlaneError(
      `The server has not confirmed a reader that preserves ${missing.join(", ")}. This node cannot be written safely; no document changes were sent.`,
    );
}
interface RuntimeConfiguration {
  release: string | null;
  extensions: Array<{ id: string; enabled: boolean }>;
  coreVersion?: string;
  protocolVersion?: number;
  readerFingerprint?: string;
}
const readerIdentity = (runtime: RuntimeConfiguration | undefined): string =>
  JSON.stringify(
    runtime
      ? {
          coreVersion: runtime.coreVersion ?? null,
          protocolVersion: runtime.protocolVersion ?? null,
          release: runtime.release,
          fingerprint: runtime.readerFingerprint ?? null,
        }
      : null,
  );

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
  private commandScope = false;
  private mutationStarted = false;
  private readerCapability?: NodeReaderCapability;
  private readonly wiki: boolean;

  constructor(
    config: Config,
    options: {
      refresh?: boolean;
      cache?: PageCapabilityCache;
      sessionDirectory?: string;
      placement?: "wiki";
    } = {},
  ) {
    this.config = config;
    this.api = new PlaneClient(config);
    this.wiki = options.placement === "wiki";
    this.cache =
      options.cache ??
      new PageCapabilityCache(config.url.value, undefined, undefined, options.placement);
    this.refresh = options.refresh ?? false;
    this.sessionDirectory = options.sessionDirectory;
  }

  beginPageCommand(): void {
    this.commandScope = true;
    this.mutationStarted = false;
  }
  markPageMutation(): void {
    this.mutationStarted = true;
  }

  async nodeReaders(): Promise<readonly string[]> {
    await this.initialize();
    // Recheck the current runtime even on a cache hit: a rollback must not inherit
    // a positive preservation claim from the previously installed adapter.
    const runtime = await this.runtime();
    const runtimeIdentity = readerIdentity(runtime);
    const cached = this.readerCapability ?? this.selection?.nodeReaders;
    if (cached?.runtimeIdentity === runtimeIdentity && cached.expiresAt > Date.now())
      return cached.nodes;
    const nodes: string[] = [];
    if (runtime) {
      let value: unknown;
      let missing = false;
      try {
        value = await this.api.request<unknown>("/api/extensions/node-readers/");
      } catch (error) {
        if (!(error instanceof PlaneError) || error.status !== 404) throw error;
        missing = true;
      }
      if (!missing) {
        if (
          !value ||
          typeof value !== "object" ||
          !("schemaVersion" in value) ||
          value.schemaVersion !== 1 ||
          !("coreVersion" in value) ||
          typeof value.coreVersion !== "string" ||
          value.coreVersion !== runtime.coreVersion ||
          !("protocolVersion" in value) ||
          value.protocolVersion !== 1 ||
          value.protocolVersion !== runtime.protocolVersion ||
          !("release" in value) ||
          value.release !== runtime.release ||
          !("fingerprint" in value) ||
          typeof value.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
          value.fingerprint !== runtime.readerFingerprint ||
          !("readers" in value) ||
          !Array.isArray(value.readers) ||
          value.readers.length > 128
        )
          throw new PlaneError(
            "Invalid or mismatched document reader inventory; preservation is not confirmed.",
          );
        const ids = new Set<string>();
        for (const reader of value.readers) {
          if (
            !reader ||
            typeof reader.id !== "string" ||
            !/^[a-z][a-z0-9-]*$/.test(reader.id) ||
            ids.has(reader.id) ||
            !Number.isSafeInteger(reader.formatVersion) ||
            reader.formatVersion < 1 ||
            !Array.isArray(reader.nodeNames) ||
            !reader.nodeNames.length ||
            !reader.nodeNames.every(
              (name: unknown) =>
                typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(name),
            )
          )
            throw new PlaneError(
              "Invalid document reader declaration; preservation is not confirmed.",
            );
          ids.add(reader.id);
          if (reader.formatVersion === 1) nodes.push(...reader.nodeNames);
        }
        if (nodes.length > 128 || new Set(nodes).size !== nodes.length)
          throw new PlaneError(
            "Invalid document reader inventory; duplicate or excessive node names.",
          );
      }
    }
    const checkedAt = Date.now();
    this.readerCapability = {
      runtimeIdentity,
      nodes,
      checkedAt,
      expiresAt: checkedAt + PAGE_CAPABILITY_TTL,
    };
    if (this.selection)
      this.selection = await this.cache.writeNodeReaders(this.selection, this.readerCapability);
    return nodes;
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
      !(value.release === null || (typeof value.release === "string" && value.release.length > 0))
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
      this.readerCapability,
    );
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.refresh) await this.cache.clear();
    if (this.wiki) {
      if (!this.config.token.value)
        throw new UsageError("Wiki commands require PLANE_API_KEY or --token.");
      const runtime = await this.runtime();
      if (
        !runtime?.release ||
        !["workspace-wiki", "api-key-pages"].every((id) =>
          runtime.extensions.some((entry) => entry.id === id && entry.enabled),
        )
      )
        throw new PlaneError(
          "Wiki commands are not supported by this server: enabled workspace-wiki and API-key pages are required.",
        );
      const cached = await this.cache.read();
      this.selection = await this.cache.write(
        "api-key",
        "wiki-runtime",
        true,
        true,
        cached?.nodeReaders,
      );
      this.initialized = true;
      return;
    }
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

  async preparePages(target: PageTarget): Promise<"changed-identity" | undefined> {
    const placement = pagePlacement(target);
    if ((placement.kind === "wiki") !== this.wiki)
      throw new PlaneError("Page client placement mismatch.");
    await this.initialize();
    if (placement.kind === "wiki") return;
    const projectId = placement.projectId;
    if (this.prepared.has(projectId)) return;
    const initialMode = this.selection?.mode ?? "api-key";
    if (!this.selection) {
      const path = `projects/${projectId}/pages/`;
      try {
        const rows = await this.api.request<unknown>(path);
        this.validateList(rows, path);
        this.selection = await this.cache.write(
          "api-key",
          "public-list",
          true,
          true,
          this.readerCapability,
        );
        this.firstLists.set(path, rows);
      } catch (error) {
        if (!(error instanceof PlaneError) || error.status !== 404) throw error;
        await this.selectSession(error);
      }
    }
    if (this.selection?.mode === "session") await this.session();
    this.prepared.add(projectId);
    if (initialMode !== this.selection?.mode) return "changed-identity";
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (this.wiki && /(?:^|\/)projects(?:\/|$)/.test(path))
      throw new PlaneError("Wiki commands cannot use project routes.");
    await this.initialize();
    const match = /^projects\/([^/]+)\/pages\//.exec(path);
    if (match?.[1]) await this.preparePages(match[1]);
    if ((options.method ?? "GET") !== "GET" && path !== "/live/convert-document")
      this.markPageMutation();
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
        if (this.commandScope) {
          if (this.mutationStarted)
            throw new PlaneError(
              "Page access changed after a mutation started. Inspect the page before retrying; no writes were replayed.",
            );
          throw new PageIdentityChanged(
            "Page access changed; resolve project references again under the selected identity.",
          );
        }
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
    if (runtime && !runtime.release && runtime.extensions.length)
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
