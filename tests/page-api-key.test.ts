import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { PlaneClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { guardSecret, printValue, warn } from "../src/output.ts";
import { openLive } from "../src/page-live.ts";
import { closeServers, server } from "./page-wire.ts";

const originalFetch = globalThis.fetch;
const noProxy = process.env.NO_PROXY;
const key = 'page-api-secret-"<&value';
const config = (url = "https://plane.test"): Config => ({
  url: { value: url, origin: "flag" },
  workspace: { value: "workspace", origin: "flag" },
  token: { value: key, origin: "flag" },
  configPath: "/dev/null",
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  closeServers();
  guardSecret("");
  if (noProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = noProxy;
});

test("page HTTP mutations use only the API key and never retry a rejected write", async () => {
  process.env.NO_PROXY = "*";
  for (const status of [401, 403, 500]) {
    const calls: Array<{ path: string; headers: Headers; redirect?: string }> = [];
    globalThis.fetch = (async (url, options) => {
      calls.push({ path: String(url), headers: new Headers(options?.headers), redirect: options?.redirect });
      return Response.json({ error: key }, { status });
    }) as typeof fetch;
    const error = await new PlaneClient(config()).request("projects/project/pages/page/", {
      method: "PATCH", body: { name: "Updated" },
    }).catch((cause: Error) => cause);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain(key);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("https://plane.test/api/v1/workspaces/workspace/projects/project/pages/page/");
    expect(calls[0]?.headers.get("X-API-Key")).toBe(key);
    expect(calls[0]?.headers.has("Cookie")).toBe(false);
    expect(calls[0]?.headers.has("X-CSRFToken")).toBe(false);
    expect(calls[0]?.redirect).toBe("error");
  }
});

test("live negotiates the release and sends key identity with explicit write intent", async () => {
  process.env.NO_PROXY = "*";
  const stub = await server();
  globalThis.fetch = (async () => Response.json({ release: "runtime-1" })) as typeof fetch;
  const client = new PlaneClient(config(stub.url));
  for (const writable of [false, true]) {
    const live = await openLive(client, "project", "page", { writable });
    live.destroy();
  }
  expect(stub.authentications).toHaveLength(2);
  for (const [index, auth] of stub.authentications.entries()) {
    expect(JSON.parse(auth.token)).toEqual({ apiKey: key, readOnly: index === 0 });
    expect(new URL(auth.url, stub.url).searchParams.get("forPlaneRelease")).toBe("runtime-1");
  }
});

test("live rejection opens exactly one connection without login fallback", async () => {
  process.env.NO_PROXY = "*";
  const stub = await server("denied");
  globalThis.fetch = (async () => Response.json({ release: "runtime-1" })) as typeof fetch;
  await expect(openLive(new PlaneClient(config(stub.url)), "project", "page")).rejects.toThrow("Live authentication was refused");
  expect(stub.connections()).toBe(1);
});

test("missing extension reports compatibility before opening the live connection", async () => {
  process.env.NO_PROXY = "*";
  const stub = await server();
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  await expect(openLive(new PlaneClient(config(stub.url)), "project", "page")).rejects.toThrow("require the for-plane API-key pages extension");
  expect(stub.connections()).toBe(0);
});

test("JSON, truncated text, HTML and warnings redact the one credential", async () => {
  process.env.NO_PROXY = "*";
  const client = new PlaneClient(config());
  const token = JSON.stringify({ apiKey: key, readOnly: true });
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let output = "";
  const capture = ((chunk: string) => { output += chunk; return true; }) as typeof stdout;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    printValue({ token }, true, () => "unused");
    printValue({ name: key }, false, (model) => model.name.slice(0, 12));
    const encoded = key.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    warn(encoded);
    globalThis.fetch = (async () => Response.json({ error: `${"x".repeat(270)}${key}` }, { status: 500 })) as typeof fetch;
    const error = await client.request("projects/project/pages/").catch((cause: Error) => cause);
    warn(error.message);
    for (const value of [key, JSON.stringify(key).slice(1, -1), encoded, key.slice(0, 12)])
      expect(output).not.toContain(value);
    expect(output).toContain("[token]");
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
});

test("CLI config exposes one access source and offline diagnostics guard the key", () => {
  const env = { ...process.env, PLANE_CONFIG: "/dev/null", PLANE_URL: "https://plane.test", PLANE_WORKSPACE: "workspace", PLANE_API_KEY: key,
    PLANE_LOGIN: "ignored", PLANE_PASSWORD: "ignored", PLANE_SESSION_CACHE: "/does-not-exist" };
  const result = spawnSync("bun", ["src/cli.ts", "config", "--json"], { env, encoding: "utf8" });
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).not.toHaveProperty("session");
  expect(result.stdout).not.toContain("ignored");
  const invalid = spawnSync("bun", ["src/cli.ts", "guide", `--${key}`], { env, encoding: "utf8" });
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).not.toContain(key);
  expect(invalid.stderr).toContain("[token]");
  const missing = spawnSync("bun", ["src/cli.ts", "pages", "APP"], { env: { ...env, PLANE_API_KEY: "", PLANE_TOKEN: "" }, encoding: "utf8" });
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain("PLANE_API_KEY");
});
