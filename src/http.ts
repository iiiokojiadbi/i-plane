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

/** Turns an IPv4 address into a number, or undefined when it is not one. */
const ipv4 = (value: string): number | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result;
};

/** curl accepts CIDR rules in --noproxy; a bare suffix match never matches one. */
const inCidr = (host: string, rule: string): boolean => {
  const [network, bits] = rule.split("/");
  if (network === undefined || bits === undefined) return false;
  const size = Number(bits);
  if (!Number.isInteger(size) || size < 0 || size > 32) return false;
  const target = ipv4(host);
  const base = ipv4(network);
  if (target === undefined || base === undefined) return false;
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
  return (target & mask) === (base & mask);
};

/**
 * Honours NO_PROXY the way curl does. Without this a LAN address would be sent
 * to a proxy that has no route back into the LAN — and the three shapes below
 * are exactly the ones a suffix match gets wrong.
 */
export const isExcluded = (hostname: string): boolean => {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (raw.trim() === "") return false;
  // A trailing dot is the same host: "example.com." and "example.com".
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  for (const entry of raw.split(/[,\s]+/)) {
    const rule = entry
      .trim()
      .toLowerCase()
      .replace(/^\./, "")
      .replace(/^\[|\]$/g, "");
    if (rule === "") continue;
    if (rule === "*") return true;
    if (rule.includes("/") && inCidr(host, rule)) return true;
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

  let undici: { fetch: FetchLike; ProxyAgent: new (uri: string) => unknown };
  try {
    undici = (await import("undici")) as unknown as typeof undici;
  } catch {
    // Not installed: the caller falls back to re-exec. An expected state.
    return undefined;
  }

  try {
    const dispatcher = new undici.ProxyAgent(proxy);
    return (input, init) =>
      undici.fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: unknown });
  } catch (cause) {
    /*
     * A malformed proxy URL is a configuration mistake, not a missing library.
     * Swallowing it here sent the caller down the fallback path and produced
     * "fetch failed", which says nothing about the actual cause.
     */
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Proxy setting is not a usable URL: ${proxy} (${reason})`);
  }
};

/** NODE_USE_ENV_PROXY landed in Node 24.0 and was backported to 22.21. */
const supportsEnvProxy = (): boolean => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
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
  if (!supportsEnvProxy()) {
    /*
     * Older runtimes have no way to reach a proxy from the built-in fetch, so
     * saying what to install beats a re-exec that changes nothing and a later
     * "fetch failed" that explains nothing.
     */
    throw new Error(
      `A proxy is configured, but Node ${process.versions.node} cannot use it with the built-in fetch. ` +
        "Install the optional dependency (npm install undici) or upgrade to Node 22.21 or newer.",
    );
  }

  const { spawnSync } = await import("node:child_process");
  const entry = process.argv[1];
  if (entry === undefined) return undefined;

  /*
   * execArgv travels with the child. Dropping it silently removed runtime flags
   * the caller chose — --use-system-ca among them, which is precisely what a
   * proxied corporate network needs.
   */
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, entry, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", I_PLANE_NO_REEXEC: "1" },
    },
  );
  return result.status ?? 1;
};
