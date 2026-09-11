import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PlaneError, type RequestOptions } from "./client.ts";
import { connectionRoute, isConnectionDenied, proxyFetch } from "./http.ts";
import { guardSecret, scrub } from "./output.ts";
import type { SessionConfig } from "./session-config.ts";

export interface Session {
  readonly userId: string;
  readonly sessionId: string;
  readonly csrf: string;
  readonly expiresAt: number;
}
interface RawReply {
  status: number;
  headers: Headers;
  text: string;
}
const DEADLINE = 20000;
const guardSession = (session: Session): Session => {
  guardSecret(session.sessionId);
  guardSecret(session.csrf);
  guardSecret(cookieHeader(session));
  return session;
};
export const cookieHeader = (session: Session): string =>
  `session-id=${session.sessionId}; csrftoken=${session.csrf}`;
export const cacheFile = (baseUrl: string, login: string, directory: string): string =>
  join(
    directory,
    `${createHash("sha256")
      .update(JSON.stringify([baseUrl, login]))
      .digest("hex")}.json`,
  );

const loadSession = async (path: string): Promise<Session | undefined> => {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: Session & { version?: number };
    try {
      const info = await file.stat();
      if ((info.mode & 0o077) !== 0 || !info.isFile() || info.size > 16384) return undefined;
      value = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
    if (
      value.version !== 1 ||
      typeof value.userId !== "string" ||
      !value.userId ||
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      typeof value.csrf !== "string" ||
      !value.csrf ||
      /[;\r\n]/.test(value.sessionId + value.csrf) ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt)
    )
      return undefined;
    guardSession(value);
    return value.expiresAt > Date.now() ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Session-authenticated API, deliberately independent of the public API client. */
export class SessionClient {
  readonly config: SessionConfig;
  readonly cachePath: string;
  private current?: Session;
  private flight?: Promise<Session>;
  constructor(config: SessionConfig) {
    this.config = config;
    this.cachePath = cacheFile(config.url.value, config.login.value, config.cacheDirectory);
    guardSecret(config.password.value);
    if (config.token.value) guardSecret(config.token.value);
  }

  async raw(path: string, init: RequestInit = {}, timeoutMs = DEADLINE): Promise<RawReply> {
    const url = `${this.config.url.value}${path}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const send = (await proxyFetch(url)) ?? fetch;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PlaneError(`Session request timed out after ${timeoutMs / 1000}s: ${path}`));
        }, timeoutMs);
      });
      return await Promise.race([
        (async () => {
          const response = await send(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal,
          });
          return {
            status: response.status,
            headers: response.headers,
            text: await response.text(),
          };
        })(),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof PlaneError) throw error;
      const reason = isConnectionDenied(error)
        ? `Connection ${connectionRoute(url)} denied by the operating system; check sandbox network permissions.`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new PlaneError(scrub(`Session request failed: ${reason}`));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private parse<T>(reply: RawReply, path: string): T {
    if (reply.status < 200 || reply.status >= 300) {
      const hint =
        reply.status === 403 ? " Check page permissions, lock state and CSRF credentials." : "";
      throw new PlaneError(
        scrub(`Plane session API answered ${reply.status} for ${path}.${hint} ${reply.text}`).slice(
          0,
          450,
        ),
        reply.status,
      );
    }
    if (!reply.text || reply.status === 204) return undefined as T;
    try {
      return JSON.parse(reply.text) as T;
    } catch {
      throw new PlaneError(`Expected JSON from session API: ${path}`);
    }
  }

  private async authenticate(): Promise<Session> {
    const cookies = new Map<string, string>();
    let expiresAt = Date.now() + 86400000;
    const receive = (headers: Headers) => {
      for (const header of headers.getSetCookie()) {
        const [pair = ""] = header.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim(),
          value = pair.slice(eq + 1).trim();
        if (eq < 1 || !["session-id", "csrftoken"].includes(name)) continue;
        if (/[;\r\n]/.test(value)) throw new PlaneError("Invalid session cookie received.");
        if (value) guardSecret(value);
        cookies.set(name, value);
        const age = /(?:^|;)\s*max-age=(-?\d+)/i.exec(header)?.[1];
        if (age !== undefined) expiresAt = Math.min(expiresAt, Date.now() + Number(age) * 1000);
      }
    };
    const csrfReply = await this.raw("/auth/get-csrf-token/");
    receive(csrfReply.headers);
    const csrf =
      this.parse<{ csrf_token?: string }>(csrfReply, "/auth/get-csrf-token/").csrf_token ??
      cookies.get("csrftoken");
    if (!csrf) throw new PlaneError("Plane did not provide a CSRF token.");
    guardSecret(csrf);
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) guardSecret(cookie);
    const reply = await this.raw("/auth/sign-in/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${this.config.url.value}/`,
        Cookie: cookie,
      },
      body: new URLSearchParams({
        csrfmiddlewaretoken: csrf,
        email: this.config.login.value,
        password: this.config.password.value,
      }).toString(),
    });
    receive(reply.headers);
    const sessionId = cookies.get("session-id"),
      csrfCookie = cookies.get("csrftoken");
    if (![200, 302, 303].includes(reply.status) || !sessionId || !csrfCookie)
      throw new PlaneError(
        "Plane sign-in failed. Check PLANE_LOGIN and PLANE_PASSWORD; this authentication flow requires password sign-in.",
        reply.status,
      );
    const provisional = guardSession({ userId: "", sessionId, csrf: csrfCookie, expiresAt });
    const me = this.parse<{ id?: string }>(
      await this.raw("/api/users/me/", { headers: { Cookie: cookieHeader(provisional) } }),
      "/api/users/me/",
    );
    if (!me.id) throw new PlaneError("Session was not authenticated: no user identifier returned.");
    return guardSession({ ...provisional, userId: me.id });
  }

  async session(refresh = false): Promise<Session> {
    if (!refresh && this.current && this.current.expiresAt > Date.now()) return this.current;
    if (this.flight) return this.flight;
    const previous = this.current;
    this.flight = (async () => {
      const cached = await loadSession(this.cachePath);
      if (cached && (!refresh || cached.sessionId !== previous?.sessionId)) return cached;
      try {
        await mkdir(this.config.cacheDirectory, { recursive: true, mode: 0o700 });
        const directory = await lstat(this.config.cacheDirectory);
        if (!directory.isDirectory() || directory.isSymbolicLink())
          throw new Error("Invalid session cache directory");
        await chmod(this.config.cacheDirectory, 0o700);
      } catch {
        throw new PlaneError(
          `Cannot write session cache in ${this.config.cacheDirectory}. Set PLANE_SESSION_CACHE or --session-cache to a private writable directory.`,
        );
      }
      const lockPath = `${this.cachePath}.lock`;
      const started = Date.now();
      let lock: FileHandle | undefined;
      while (!lock) {
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if ((error as { code?: string }).code !== "EEXIST")
            throw new PlaneError("Cannot lock the session cache.");
          const info = await stat(lockPath).catch(() => undefined);
          if (info && Date.now() - info.mtimeMs > 90000) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
          if (Date.now() - started > 10000)
            throw new PlaneError("Another command is refreshing the session; retry shortly.");
          await delay(100);
        }
      }
      try {
        const newer = await loadSession(this.cachePath);
        if (newer && (!refresh || newer.sessionId !== previous?.sessionId)) return newer;
        const session = await this.authenticate();
        const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify({ version: 1, ...session }));
          } finally {
            await file.close();
          }
          await rename(temporary, this.cachePath);
        } finally {
          await unlink(temporary).catch(() => {});
        }
        return session;
      } finally {
        await lock.close();
        await unlink(lockPath).catch(() => {});
      }
    })();
    try {
      this.current = await this.flight;
      return this.current;
    } finally {
      this.flight = undefined;
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const route = path.startsWith("/")
      ? path
      : `/api/workspaces/${encodeURIComponent(this.config.workspace.value)}/${path}`;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) query.set(key, String(value));
    const target = query.size ? `${route}?${query}` : route;
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.session(attempt === 1);
      const reply = await this.raw(
        target,
        {
          method: options.method ?? "GET",
          headers: {
            Cookie: cookieHeader(session),
            "X-CSRFToken": session.csrf,
            Referer: `${this.config.url.value}/`,
            Accept: "application/json",
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        },
        options.timeoutMs,
      );
      if (reply.status === 401 && attempt === 0) continue;
      return this.parse<T>(reply, route);
    }
    throw new PlaneError("Session authentication failed after one refresh.", 401);
  }

  async listAll<T>(path: string, options: RequestOptions = {}): Promise<ReadonlyArray<T>> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request<unknown>(path, {
        ...options,
        query: { ...options.query, ...(cursor ? { cursor } : {}) },
      });
      if (Array.isArray(page)) return [...rows, ...page];
      if (!page || typeof page !== "object" || !("results" in page) || !Array.isArray(page.results))
        throw new PlaneError(`Unexpected list response from session API: ${path}`);
      rows.push(...page.results);
      const next = page as { next_page_results?: boolean; next_cursor?: string };
      cursor = next.next_page_results ? next.next_cursor : undefined;
      if (cursor) {
        if (seen.has(cursor)) throw new PlaneError("Session API repeated a pagination cursor.");
        seen.add(cursor);
      }
    } while (cursor);
    return rows;
  }
}
