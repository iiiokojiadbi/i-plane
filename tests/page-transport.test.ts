import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { AutoPageClient } from "../src/page-transport.ts";
import { PAGE_CAPABILITY_TTL, PageCapabilityCache, pageTransportReport } from "../src/page-cache.ts";
import { openLive } from "../src/page-live.ts";
import { guardSecret } from "../src/output.ts";
import { closeServers, server } from "./page-wire.ts";

const originalFetch = globalThis.fetch;
const envKeys = ["NO_PROXY", "PLANE_LOGIN", "PLANE_PASSWORD", "PLANE_PAGE_CACHE"];
let before: Record<string, string | undefined>, directory: string, now: number;
let calls: Array<{ path: string; headers: Headers; method: string }>;
let publicStatus: number, runtime: boolean | "disabled", logins: number, detailStatus: number;
let config: Config;
const list = "projects/project/pages/";
const publicList = "/api/v1/workspaces/workspace/projects/project/pages/";
const runtimePath = "/api/extensions/configuration/";
const cache = () => new PageCapabilityCache(config.url.value, directory, () => now);
const client = (refresh = false) => new AutoPageClient(config, { cache: cache(), refresh, sessionDirectory: join(directory, "sessions") });
beforeEach(async () => {
  before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  directory = await mkdtemp(join(tmpdir(), "ipl-transport-"));
  now = Date.now(); calls = []; publicStatus = 200; runtime = true; logins = 0; detailStatus = 200;
  config = { url: { value: "https://plane.test", origin: "flag" }, token: { value: "api-key-secret", origin: "flag" }, workspace: { value: "workspace", origin: "flag" }, configPath: "/dev/null" };
  process.env.NO_PROXY = "*";
  process.env.PLANE_PAGE_CACHE = directory;
  delete process.env.PLANE_LOGIN; delete process.env.PLANE_PASSWORD;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    if (path === runtimePath) return runtime ? Response.json({ release: "runtime-1", extensions: [{ id: "api-key-pages", enabled: runtime === true }] }) : new Response(null, { status: 404 });
    if (path === publicList && publicStatus !== 200) return new Response(null, { status: publicStatus });
    if (path === "/auth/get-csrf-token/") return Response.json({ csrf_token: "csrf-secret" }, { headers: { "Set-Cookie": "csrftoken=csrf-secret; Path=/" } });
    if (path === "/auth/sign-in/") { logins++; return new Response(null, { status: 302, headers: { "Set-Cookie": `session-id=session-secret-${logins}; Path=/` } }); }
    if (path === "/api/users/me/") return Response.json({ id: "user" });
    if (path.endsWith("/pages/missing/")) return new Response(null, { status: detailStatus });
    return Response.json([{ id: "page", name: "Page" }]);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch; closeServers(); guardSecret("");
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(directory, { recursive: true, force: true });
});
const credentials = () => { process.env.PLANE_LOGIN = "reader@example.test"; process.env.PLANE_PASSWORD = "password-secret"; };

test("first API list is reused and API-only commands do not need session settings", async () => {
  expect(await client().listAll(list)).toHaveLength(1);
  expect(calls.map(call => call.path)).toEqual([publicList]);
  expect((await cache().read())?.mode).toBe("api-key");
  await client().request(`${list}missing/`);
  expect(calls.map(call => call.path)).toEqual([publicList, `${publicList}missing/`]);
  expect(logins).toBe(0);
  expect(calls.every(call => !call.headers.has("Cookie"))).toBe(true);
});
for (const status of [401, 403, 429, 500]) test(`public list ${status} never logs in or caches a session selection`, async () => {
  credentials(); publicStatus = status; runtime = false;
  const error = await client().listAll(list).catch(error => error);
  expect(error.status).toBe(status); expect(logins).toBe(0);
  expect(calls.map(call => call.path)).toEqual([publicList]);
  expect(await cache().read()).toBeUndefined();
});
test("hidden permission 404 is not mistaken for a missing public route", async () => {
  credentials(); publicStatus = 404;
  const error = await client().listAll(list).catch(error => error);
  expect(error.status).toBe(404); expect(logins).toBe(0); expect(await cache().read()).toBeUndefined();
});
test("detail 404 never changes a working API selection", async () => {
  credentials(); detailStatus = 404;
  await expect(client().request(`${list}missing/`)).rejects.toMatchObject({ status: 404 });
  expect(calls.map(call => call.path)).toEqual([publicList, `${publicList}missing/`]);
  expect((await cache().read())?.mode).toBe("api-key"); expect(logins).toBe(0);
});
for (const available of [false, "disabled"] as const) test(`absent API route with runtime=${available} selects session and keeps it per instance`, async () => {
  credentials(); publicStatus = 404; runtime = available;
  expect(await client().listAll(list)).toHaveLength(1);
  expect(logins).toBe(1);
  const last = calls.at(-1)!;
  expect(last.path).toBe(publicList.replace("/v1", ""));
  expect(last.headers.get("Cookie")).toContain("session-secret-1");
  expect(last.headers.has("X-API-Key")).toBe(false);
  calls = [];
  await client().listAll(list);
  expect(calls).toHaveLength(1); expect(logins).toBe(1);
  const report = await pageTransportReport(config.url.value);
  expect(report.mode).toBe("session"); expect(report.reason).toMatch(/absent|unavailable/);
  expect(await new PageCapabilityCache("https://other.test", directory).read()).toBeUndefined();
});
test("missing fallback credentials explain both required settings", async () => {
  publicStatus = 404; runtime = false;
  await expect(client().listAll(list)).rejects.toThrow("PLANE_LOGIN and PLANE_PASSWORD");
  expect(logins).toBe(0); expect((await cache().read())?.mode).toBe("session");
});
test("vanilla session-only configuration works without an API key", async () => {
  credentials(); runtime = false; config.token.value = "";
  await client().listAll(list);
  expect(calls[0]?.path).toBe(runtimePath);
  expect(calls.some(call => call.path === publicList)).toBe(false);
  expect(logins).toBe(1);
});
test("extension instance without key never reads session credentials", async () => {
  credentials(); config.token.value = "";
  await expect(client().listAll(list)).rejects.toThrow("PLANE_API_KEY");
  expect(logins).toBe(0); expect(calls).toHaveLength(1);
});
for (const reset of [false, true]) test(`extension installation is discovered by ${reset ? "explicit reset" : "expiry"}`, async () => {
  credentials(); runtime = false; publicStatus = 404;
  await client().listAll(list);
  runtime = true; publicStatus = 200; calls = [];
  if (!reset) now += PAGE_CAPABILITY_TTL;
  await client(reset).listAll(list);
  expect(calls.map(call => call.path)).toEqual([publicList]);
  expect((await cache().read())?.mode).toBe("api-key");
});
test("a newly supplied key rechecks a selection obtained without a key", async () => {
  credentials(); runtime = false; publicStatus = 404; config.token.value = "";
  await client().listAll(list);
  config.token.value = "new-key"; runtime = true; publicStatus = 200; calls = [];
  await client().listAll(list); expect(calls.map(call => call.path)).toEqual([publicList]);
});
test("API removal switches only a list read, never replays a mutation", async () => {
  credentials(); await client().listAll(list);
  publicStatus = 404; runtime = false; calls = [];
  await expect(client().request(list, { method: "POST", body: { name: "New" } })).rejects.toMatchObject({ status: 404 });
  expect(calls).toHaveLength(1); expect(logins).toBe(0);
  await client().listAll(list); expect(logins).toBe(1);
});
test("invalid runtime configuration prevents speculative fallback", async () => {
  credentials(); publicStatus = 404;
  const fetcher = globalThis.fetch;
  globalThis.fetch = (async (url, init) => String(url).endsWith(runtimePath) ? Response.json({ release: "bad" }) : fetcher(url, init)) as typeof fetch;
  await expect(client().listAll(list)).rejects.toThrow("Invalid extension configuration");
  expect(logins).toBe(0); expect(await cache().read()).toBeUndefined();
});
test("capability cache is private, contains no credentials and ignores malformed or symlinked files", async () => {
  await client().listAll(list);
  expect((await stat(cache().path)).mode & 0o777).toBe(0o600);
  const saved = await readFile(cache().path, "utf8"); expect(saved).not.toContain(config.token.value); expect(saved).not.toContain(config.url.value);
  await writeFile(cache().path, '{}'); expect(await cache().read()).toBeUndefined();
  const target = join(directory, "target"); await writeFile(target, saved, { mode: 0o600 });
  await rm(cache().path); await symlink(target, cache().path); expect(await cache().read()).toBeUndefined();
});
test("unwritable cache does not block API access", async () => {
  const invalid = new PageCapabilityCache(config.url.value, "/dev/null/invalid");
  expect(await new AutoPageClient(config, { cache: invalid }).listAll(list)).toHaveLength(1);
});
test("config refresh clears cached selection without logging in", async () => {
  await cache().write("session", "missing-route", false, true);
  const report = await pageTransportReport(config.url.value, true);
  expect(report.mode).toBe("unknown"); expect(await cache().read()).toBeUndefined(); expect(calls).toHaveLength(0);
});
test("vanilla live sends cookies and user identity without extension release", async () => {
  credentials(); runtime = false; publicStatus = 404;
  const stub = await server(); config.url.value = stub.url;
  const live = await openLive(client(), "project", "page", { writable: true }); live.destroy();
  expect(JSON.parse(stub.authentications[0]!.token)).toEqual({ id: "user", cookie: "session-id=session-secret-1; csrftoken=csrf-secret", readOnly: false });
  expect(new URL(stub.authentications[0]!.url, stub.url).searchParams.has("forPlaneRelease")).toBe(false);
});
test("definite session live rejection refreshes once before any write", async () => {
  credentials(); runtime = false; publicStatus = 404;
  const stub = await server("denied"); config.url.value = stub.url;
  await expect(openLive(client(), "project", "page")).rejects.toThrow("authentication was refused");
  expect(stub.connections()).toBe(2); expect(logins).toBe(2);
});

test("runtime permission failures after list 404 cannot trigger login", async () => {
  credentials(); publicStatus = 404;
  const fetcher = globalThis.fetch;
  for (const status of [401, 403, 500]) {
    globalThis.fetch = (async (url, init) => String(url).endsWith(runtimePath) ? new Response(null, { status }) : fetcher(url, init)) as typeof fetch;
    await expect(client().listAll(list)).rejects.toMatchObject({ status });
    expect(logins).toBe(0); expect(await cache().read()).toBeUndefined();
  }
});
test("page pagination does not merge API-key and session identities after a later 404", async () => {
  credentials(); runtime = false;
  globalThis.fetch = (async (url) => {
    if (new URL(String(url)).searchParams.has("cursor")) return new Response(null, { status: 404 });
    return Response.json({ results: [{ id: "public-page" }], next_page_results: true, next_cursor: "next" });
  }) as typeof fetch;
  await expect(client().listAll(list)).rejects.toMatchObject({ status: 404 });
  expect(logins).toBe(0); expect((await cache().read())?.mode).toBe("api-key");
});
test("valid pagination reuses the probe and detects repeated cursors", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return Response.json({ results: [{ id: "page" }], next_page_results: true, next_cursor: "same" });
  }) as typeof fetch;
  await expect(client().listAll(list)).rejects.toThrow("repeated a pagination cursor");
  expect(urls).toHaveLength(2);
});
test("stale session live selection still negotiates a newly installed runtime release", async () => {
  credentials(); publicStatus = 404; runtime = false;
  const stub = await server(); config.url.value = stub.url;
  const selected = client(); await selected.preparePages("project");
  runtime = true;
  const live = await openLive(selected, "project", "page"); live.destroy();
  const auth = stub.authentications[0]!;
  expect(JSON.parse(auth.token).cookie).toContain("session-secret");
  expect(new URL(auth.url, stub.url).searchParams.get("forPlaneRelease")).toBe("runtime-1");
});
test("empty successful runtime response is not an absent route", async () => {
  credentials(); publicStatus = 404;
  const fetcher = globalThis.fetch;
  globalThis.fetch = (async (url, init) => String(url).endsWith(runtimePath) ? new Response(null, { status: 204 }) : fetcher(url, init)) as typeof fetch;
  await expect(client().listAll(list)).rejects.toThrow("Invalid extension configuration");
  expect(logins).toBe(0); expect(await cache().read()).toBeUndefined();
});
test("instance cache canonicalizes default ports and trailing slashes", async () => {
  await cache().write("api-key", "public-list", true, true);
  expect((await new PageCapabilityCache("https://plane.test:443/", directory, () => now).read())?.mode).toBe("api-key");
});

test("cold and cached session selection resolve project names under the same identity", async () => {
  const { projectOfPage } = await import("../src/commands/page-data.ts");
  credentials(); runtime = false; publicStatus = 404;
  const fetcher = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/workspaces/workspace/projects/") return Response.json([{ id: "account-a-project", name: "Knowledge", identifier: "KA" }]);
    if (path === "/api/workspaces/workspace/projects/") return Response.json([{ id: "account-b-project", name: "Knowledge", identifier: "KB" }]);
    if (path === "/api/v1/workspaces/workspace/projects/account-a-project/pages/") return new Response(null, { status: 404 });
    return fetcher(url, init);
  }) as typeof fetch;
  expect((await projectOfPage(client(), "Knowledge")).id).toBe("account-b-project");
  expect((await projectOfPage(client(), "Knowledge")).id).toBe("account-b-project");
});

test("capability cache ignores FIFOs without waiting for a writer", async () => {
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [cache().path]);
  expect(await cache().read()).toBeUndefined();
});
test("adapter with no installed package keeps stock session live available", async () => {
  credentials(); publicStatus = 404;
  const stub = await server(); config.url.value = stub.url;
  const fetcher = globalThis.fetch;
  globalThis.fetch = (async (url, init) => String(url).endsWith(runtimePath) ? Response.json({ release: null, extensions: [] }) : fetcher(url, init)) as typeof fetch;
  const selected = client();
  const live = await openLive(selected, "project", "page"); live.destroy();
  expect((await cache().read())?.mode).toBe("session");
  expect(new URL(stub.authentications[0]!.url, stub.url).searchParams.has("forPlaneRelease")).toBe(false);
});
