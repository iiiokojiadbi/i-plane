/*
 * HTTP client for the Plane REST API.
 *
 * Errors are the point here. An agent reading "request failed" has to guess and
 * retry; one reading "token rejected (401) — the key in ~/.config/plane/credentials
 * is not valid for this workspace" fixes it in one step.
 */

import type { Config } from "./config.ts";
import { connectionRoute, type FetchLike, isConnectionDenied, proxyFetch } from "./http.ts";
import { guardSecret, scrub } from "./output.ts";

/*
 * Anything on its way to a human or a log passes through here first. Node puts
 * the offending header value into its own error text, and a server can reflect a
 * token back in an error body — both bypassed the masking that only guarded
 * `i-plane config`. A leak in an error message is still a leak.
 */
const redact = (text: string, secret: string): string => {
  if (secret === "") return text;
  let safe = scrub(text).split(secret).join("[token]");
  // A token carrying a newline reaches Node's header validator in pieces.
  for (const piece of secret.split(/\s+/)) {
    if (piece.length >= 12) safe = safe.split(piece).join("[token]");
  }
  return safe;
};

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
  readonly config: Config;
  /** Resolved once per process: the choice cannot change between requests. */
  private transport: FetchLike | undefined;
  private transportReady = false;

  constructor(config: Config) {
    this.config = config;
    if (config.token.value) guardSecret(config.token.value);
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

    const limit = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /*
     * Transport selection happens before the timer starts. Starting it first
     * leaked a pending timer whenever proxy initialization threw, because the
     * throw escaped past the cleanup block.
     */
    const send = await this.fetcher(url.toString());

    const controller = new AbortController();
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), limit);
    // One deadline covers headers and body together. A fresh timer per phase
    // means a slow response can take twice what the caller allowed.
    const remaining = (): number => Math.max(0, limit - (Date.now() - started));

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
        redirect: "error",
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        clearTimeout(timeout);
        throw new PlaneError(`No answer from ${this.config.url.value} within ${limit / 1000}s.`);
      }
      /*
       * The cause carries the diagnosis — ENOTFOUND, ECONNREFUSED, a certificate
       * problem — and "fetch failed" alone leaves the caller with nothing to act
       * on. Both layers are reported, with the token stripped from each.
       */
      const reason = cause instanceof Error ? cause.message : String(cause);
      const inner = cause instanceof Error ? (cause.cause as Error | undefined) : undefined;
      const detail =
        inner === undefined
          ? reason
          : `${reason} (${[inner.name, (inner as { code?: string }).code, inner.message]
              .filter(Boolean)
              .join(" ")})`;
      clearTimeout(timeout);
      if (isConnectionDenied(cause)) {
        throw new PlaneError(
          redact(
            `Connection to ${this.config.url.value} ${connectionRoute(url.toString())} was denied by the operating system (EPERM/EACCES). ` +
              "Check sandbox network permissions and local firewall rules. No HTTP response was received from Plane.",
            this.config.token.value,
          ),
        );
      }
      throw new PlaneError(
        redact(`Cannot reach ${this.config.url.value}: ${detail}`, this.config.token.value),
      );
    }

    try {
      if (!response.ok) {
        // Error bodies get the same deadline as any other: a stalled 500 used
        // to hang with no limit at all.
        throw await this.describeFailure(response, remaining(), controller);
      }

      if (response.status === 204) return undefined as T;
      const text = await this.readBody(response, remaining(), controller);
      if (text === "") return undefined as T;
      return JSON.parse(text) as T;
    } catch (cause) {
      if (cause instanceof PlaneError) throw cause;
      throw new PlaneError(
        redact(
          `Expected JSON from ${url.pathname}: ${cause instanceof Error ? cause.message : String(cause)}`,
          this.config.token.value,
        ).slice(0, 200),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Reads a body under whatever is left of the request's deadline, and actually
   * stops the transfer when it runs out. Abandoning the race without aborting
   * left the connection and the stream open behind a command that had already
   * given up.
   */
  private async readBody(
    response: Response,
    limitMs: number,
    controller: AbortController,
  ): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        /*
         * Aborting is what actually stops the transfer. cancel() cannot run here
         * — text() holds the stream lock — so calling it only produced a
         * rejected promise nobody read.
         */
        controller.abort();
        reject(new PlaneError(`Response body stalled; gave up after ${limitMs / 1000}s.`));
      }, limitMs);
    });
    try {
      return await Promise.race([response.text(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Follows cursors so callers get every row, not the first page. */
  async listAll<T>(path: string, options: RequestOptions = {}): Promise<ReadonlyArray<T>> {
    const rows: T[] = [];
    const seen = new Set<string>();
    const initialCursor = options.query?.cursor;
    if (initialCursor !== undefined && initialCursor !== null) seen.add(String(initialCursor));
    let cursor: string | undefined;
    do {
      const page = await this.request<Page<T>>(path, {
        ...options,
        query: { ...options.query, ...(cursor === undefined ? {} : { cursor }) },
      });
      if (Array.isArray(page)) {
        rows.push(...(page as ReadonlyArray<T>));
        break;
      }
      if (
        !page ||
        !Array.isArray(page.results) ||
        (page.next_page_results !== undefined && typeof page.next_page_results !== "boolean")
      )
        throw new PlaneError(`Unexpected paginated response: ${path}`);
      rows.push(...page.results);
      if (page.next_page_results !== true) break;
      if (typeof page.next_cursor !== "string" || !page.next_cursor.trim())
        throw new PlaneError(`Missing or invalid pagination cursor: ${path}`);
      if (seen.has(page.next_cursor)) throw new PlaneError(`Repeated pagination cursor: ${path}`);
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    return rows;
  }

  private async describeFailure(
    response: Response,
    limitMs: number,
    controller: AbortController,
  ): Promise<PlaneError> {
    // An error body is read under the deadline too: a stalled 500 used to hang
    // with no limit at all.
    const body = await this.readBody(response, limitMs, controller).catch(() => "");
    // A server can echo the key back inside an error body.
    // Redact first, then truncate. Cutting first left the token's opening
    // characters visible whenever padding pushed it across the boundary.
    const detail = redact(body, this.config.token.value).slice(0, 300);
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
