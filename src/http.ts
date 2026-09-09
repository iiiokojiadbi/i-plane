/*
 * Making requests work behind a proxy, without making anyone pay for it.
 *
 * Node's built-in fetch ignores HTTPS_PROXY. That is fine on a plain network and
 * fatal on one where the proxy is also the only resolver: the request dies with
 * ENOTFOUND while curl on the same host succeeds.
 *
 * Three paths, tried in order, and the common case costs nothing:
 *   1. No proxy in the environment, or the host is excluded — the built-in fetch.
 *   2. `undici` present (optional dependency) — its ProxyAgent, no extra process.
 *   3. Neither — re-exec once with NODE_USE_ENV_PROXY=1, which Node 24 understands.
 *      Costs about 140 ms, so it is the fallback rather than the default.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const proxyFor = (protocol: string): string | undefined => {
  const https = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const http = process.env.HTTP_PROXY ?? process.env.http_proxy;
  const chosen = protocol === "https:" ? (https ?? http) : (http ?? https);
  return chosen === undefined || chosen === "" ? undefined : chosen;
};

/**
 * Honours NO_PROXY the way curl does: a bare suffix match, plus "*" for
 * everything. Without this, a LAN address would be sent to a proxy that has no
 * route back into the LAN.
 */
export const isExcluded = (hostname: string): boolean => {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (raw.trim() === "") return false;
  const host = hostname.toLowerCase();
  for (const entry of raw.split(",")) {
    const rule = entry.trim().toLowerCase().replace(/^\./, "");
    if (rule === "") continue;
    if (rule === "*") return true;
    if (host === rule || host.endsWith(`.${rule}`)) return true;
  }
  return false;
};

export const needsProxy = (target: string): boolean => {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (isExcluded(url.hostname)) return false;
  return proxyFor(url.protocol) !== undefined;
};

/**
 * Returns a fetch that goes through the proxy, or undefined when this process
 * cannot do it without help. Never throws: an absent optional dependency is an
 * expected state, not a failure.
 */
export const proxyFetch = async (target: string): Promise<FetchLike | undefined> => {
  if (!needsProxy(target)) return undefined;
  if (process.env.NODE_USE_ENV_PROXY === "1") return undefined; // already handled by Node

  const url = new URL(target);
  const proxy = proxyFor(url.protocol);
  if (proxy === undefined) return undefined;

  try {
    const undici = (await import("undici")) as unknown as {
      fetch: FetchLike;
      ProxyAgent: new (uri: string) => unknown;
    };
    const dispatcher = new undici.ProxyAgent(proxy);
    return (input, init) =>
      undici.fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: unknown });
  } catch {
    return undefined;
  }
};

/**
 * Last resort: run this same command again with the variable Node reads at
 * startup. Returns the child's exit code, or undefined when re-exec does not
 * apply — already re-executed, no proxy needed, or nothing to gain.
 */
export const reExecWithProxy = async (target: string): Promise<number | undefined> => {
  if (!needsProxy(target)) return undefined;
  if (process.env.NODE_USE_ENV_PROXY === "1") return undefined;
  if (process.env.I_PLANE_NO_REEXEC === "1") return undefined;

  const { spawnSync } = await import("node:child_process");
  const entry = process.argv[1];
  if (entry === undefined) return undefined;

  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", I_PLANE_NO_REEXEC: "1" },
  });
  return result.status ?? 1;
};
