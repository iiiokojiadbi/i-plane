/*
 * HTTP client for the Plane REST API.
 *
 * Errors are the point here. An agent reading "request failed" has to guess and
 * retry; one reading "token rejected (401) — the key in ~/.config/plane/credentials
 * is not valid for this workspace" fixes it in one step.
 */

import type { Config } from "./config.ts";
import { type FetchLike, proxyFetch } from "./http.ts";

export class PlaneError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "PlaneError";
    this.status = status;
  }
}

export interface Page<T> {
  readonly results: ReadonlyArray<T>;
  readonly total_count?: number;
  readonly next_cursor?: string;
  readonly next_page_results?: boolean;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** Milliseconds. Generous enough for a slow home link, short enough to notice a hang. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class PlaneClient {
  private readonly config: Config;
  /** Resolved once per process: the choice cannot change between requests. */
  private transport: FetchLike | undefined;
  private transportReady = false;

  constructor(config: Config) {
    this.config = config;
  }

  private async fetcher(target: string): Promise<FetchLike> {
    if (!this.transportReady) {
      this.transport = await proxyFetch(target);
      this.transportReady = true;
    }
    return this.transport ?? fetch;
  }

  /** Path is appended to /api/v1/workspaces/<slug>/ unless it starts with a slash. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const base = path.startsWith("/")
      ? `${this.config.url.value}${path}`
      : `${this.config.url.value}/api/v1/workspaces/${this.config.workspace.value}/${path}`;

    const url = new URL(base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const send = await this.fetcher(url.toString());

    let response: Response;
    try {
      response = await send(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          "X-API-Key": this.config.token.value,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new PlaneError(
          `No answer from ${this.config.url.value} within ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s.`,
        );
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new PlaneError(`Cannot reach ${this.config.url.value}: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw await this.describeFailure(response);

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PlaneError(`Expected JSON from ${url.pathname}, got ${text.slice(0, 120)}`);
    }
  }

  /** Follows cursors so callers get every row, not the first page. */
  async listAll<T>(path: string, options: RequestOptions = {}): Promise<ReadonlyArray<T>> {
    const rows: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<Page<T>>(path, {
        ...options,
        query: { ...options.query, ...(cursor === undefined ? {} : { cursor }) },
      });
      // Some endpoints answer with a bare array rather than a page.
      if (Array.isArray(page)) return page as ReadonlyArray<T>;
      rows.push(...(page.results ?? []));
      cursor = page.next_page_results === true ? page.next_cursor : undefined;
    } while (cursor !== undefined);
    return rows;
  }

  private async describeFailure(response: Response): Promise<PlaneError> {
    const body = await response.text().catch(() => "");
    const detail = body.slice(0, 300);
    switch (response.status) {
      case 401:
      case 403:
        return new PlaneError(
          `Token rejected (${response.status}). The key from ${this.config.configPath} ` +
            `is not valid for workspace "${this.config.workspace.value}".`,
          response.status,
        );
      case 404:
        return new PlaneError(
          `Not found (404): ${response.url}. Check the workspace slug ` +
            `("${this.config.workspace.value}") and the project identifier.`,
          404,
        );
      case 429:
        return new PlaneError("Rate limited (429). Plane allows 60 API calls a minute.", 429);
      default:
        return new PlaneError(
          `Plane answered ${response.status}${detail === "" ? "" : `: ${detail}`}`,
          response.status,
        );
    }
  }
}
