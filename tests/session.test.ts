import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../src/config.ts";
import { resolveSessionConfig, type SessionConfig } from "../src/session-config.ts";
import { guardSecret, printValue, scrub, warn } from "../src/output.ts";
import { cookieHeader, SessionClient } from "../src/session.ts";
import { LiveDocument } from "../src/page-live.ts";

let directory: string;
const originalFetch = globalThis.fetch;
let originalNoProxy: string | undefined;
const password = 'secret-password-"quoted"';
const config = (): SessionConfig => ({
  url: { value: "https://plane.test", origin: "flag" },
  token: { value: "api-secret-value", origin: "flag" },
  workspace: { value: "test", origin: "flag" },
  configPath: "/dev/null",
  login: { value: "reader@example.test", origin: "file" },
  password: { value: password, origin: "file" },
  cacheDirectory: directory,
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ipl-session-"));
  originalNoProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = "*";
  guardSecret("");
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = originalNoProxy;
  guardSecret("");
  await rm(directory, { recursive: true, force: true });
});

const transport = (options: { expired?: boolean; denied?: boolean } = {}) => {
  const calls: Array<{ path: string; headers: Headers; body: string; method: string }> = [];
  let logins = 0;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const headers = new Headers(init?.headers);
    calls.push({ path, headers, body: String(init?.body ?? ""), method: init?.method ?? "GET" });
    if (path === "/auth/get-csrf-token/")
      return Response.json(
        { csrf_token: "csrf-token-secret" },
        { headers: { "Set-Cookie": "csrftoken=csrf-token-secret; Path=/; Max-Age=86400" } },
      );
    if (path === "/auth/sign-in/") {
      logins++;
      if (options.denied)
        return new Response(null, { status: 302, headers: { Location: "/?error=invalid" } });
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": `session-id=session-secret-${logins}; Path=/; Max-Age=86400`,
          Location: "/",
        },
      });
    }
    if (path === "/api/users/me/") return Response.json({ id: "user-id" });
    if (options.expired && headers.get("cookie")?.includes("session-secret-1"))
      return Response.json({ error: "expired" }, { status: 401 });
    if (path.endsWith("bad/"))
      return Response.json(
        { error: password, cookie: "session-secret-1", csrf: "csrf-token-secret" },
        { status: 500 },
      );
    return Response.json([{ id: "page-id", name: "Page" }]);
  }) as typeof fetch;
  return { calls, logins: () => logins };
};

test("session is cached privately and reused across clients", async () => {
  const stub = transport();
  const first = new SessionClient(config());
  expect(await first.listAll("projects/p/pages/")).toHaveLength(1);
  expect(await new SessionClient(config()).listAll("projects/p/pages/")).toHaveLength(1);
  expect(stub.logins()).toBe(1);
  expect((await stat(first.cachePath)).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect(await readFile(first.cachePath, "utf8")).not.toContain(password);
  expect(stub.calls.find((call) => call.path === "/auth/sign-in/")?.body).toContain(
    "csrfmiddlewaretoken=",
  );
});
test("one 401 refreshes the cookie and preserves both secrets in the guard", async () => {
  const stub = transport({ expired: true });
  const client = new SessionClient(config());
  expect(await client.request("projects/")).toHaveLength(1);
  expect(stub.logins()).toBe(2);
  const safe = scrub(
    `session-secret-1 session-secret-2 csrf-token-secret api-secret-value ${password} ${JSON.stringify(password)}`,
  );
  for (const secret of [
    "session-secret-1",
    "session-secret-2",
    "csrf-token-secret",
    "api-secret-value",
    password,
  ])
    expect(safe).not.toContain(secret);
});
test("mutations carry session, csrf and referer but no API-key header", async () => {
  const stub = transport();
  await new SessionClient(config()).request("projects/p/pages/", {
    method: "POST",
    body: { name: "Page" },
  });
  const request = stub.calls.at(-1)!;
  expect(request.headers.get("cookie")).toContain(
    "session-id=session-secret-1; csrftoken=csrf-token-secret",
  );
  expect(request.headers.get("X-CSRFToken")).toBe("csrf-token-secret");
  expect(request.headers.get("Referer")).toBe("https://plane.test/");
  expect(request.headers.has("X-API-Key")).toBe(false);
});
test("failed sign-in has no cookie cache or password in its error", async () => {
  transport({ denied: true });
  const client = new SessionClient(config());
  await expect(client.session()).rejects.toThrow("Plane sign-in failed");
  await expect(stat(client.cachePath)).rejects.toThrow();
});
test("server error bodies redact every active secret", async () => {
  transport();
  const error = await new SessionClient(config()).request("bad/").catch((error) => error);
  expect(error.status).toBe(500);
  expect(error.message).not.toContain(password);
  expect(error.message).not.toContain("session-secret-1");
  expect(error.message).toContain("[token]");
});
test("credential modes are separate", () => {
  const before = {
    PLANE_LOGIN: process.env.PLANE_LOGIN,
    PLANE_PASSWORD: process.env.PLANE_PASSWORD,
    PLANE_API_KEY: process.env.PLANE_API_KEY,
    PLANE_TOKEN: process.env.PLANE_TOKEN,
  };
  try {
    process.env.PLANE_LOGIN = "user";
    process.env.PLANE_PASSWORD = password;
    delete process.env.PLANE_API_KEY;
    delete process.env.PLANE_TOKEN;
    const input = { configPath: "/dev/null", url: "https://plane.test", workspace: "test" };
    expect(resolveSessionConfig(resolveConfig(input, true), directory).token.value).toBe("");
    expect(() => resolveConfig(input)).toThrow("No token");
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("actual JSON, truncated output and warnings mask all session generations and the WebSocket token", async () => {
  transport({ expired: true });
  const client = new SessionClient(config());
  await client.request("projects/");
  const session = await client.session();
  const token = JSON.stringify({ id: session.userId, cookie: cookieHeader(session) });
  const live = new LiveDocument("ws://127.0.0.1:1/live", "page", token);
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  let output = "";
  const capture = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    const values = [
      password,
      "api-secret-value",
      "session-secret-1",
      "session-secret-2",
      "csrf-token-secret",
      token,
    ];
    printValue({ values }, true, () => "unused");
    for (const value of values)
      printValue({ name: value }, false, (model) => model.name.slice(0, 10));
    warn(`Warning after success: ${values.join(" ")}`);
    const error = await client.request("bad/").catch((error) => error);
    warn(error.message);
    for (const value of values) expect(output).not.toContain(value);
    expect(output).not.toContain("secret-pas");
    expect(output).toContain("[token]");
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    live.destroy();
  }
});

test("CSRF and invalid JSON errors do not replay mutations or leak cookies", async () => {
  transport();
  const client = new SessionClient(config());
  await client.session();
  const original = globalThis.fetch;
  let mutations = 0;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path.endsWith("csrf/")) {
      mutations++;
      return Response.json({ error: "CSRF csrf-token-secret session-secret-1" }, { status: 403 });
    }
    if (path.endsWith("broken/"))
      return new Response("broken JSON session-secret-1 " + password, { status: 200 });
    return original(input, init);
  }) as typeof fetch;
  const csrf = await client
    .request("csrf/", { method: "POST", body: { name: "Page" } })
    .catch((error) => error);
  expect(csrf.status).toBe(403);
  expect(csrf.message).toContain("CSRF");
  expect(csrf.message).not.toContain("session-secret-1");
  expect(mutations).toBe(1);
  const broken = await client.request("broken/").catch((error) => error);
  expect(broken.message).not.toContain(password);
  expect(broken.message).not.toContain("session-secret-1");
});

test("form-urlencoded passwords echoed by a transport error are masked", async () => {
  transport();
  const original = globalThis.fetch;
  const password = "a b!c";
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if (new URL(input).pathname === "/auth/sign-in/")
      throw new Error(`invalid request body: ${init?.body}`);
    return original(input, init);
  }) as typeof fetch;
  const client = new SessionClient({ ...config(), password: { value: password, origin: "file" } });
  const error = await client.session().catch((error) => error);
  expect(error.message).not.toContain("a+b%21c");
  expect(error.message).not.toContain(password);
  expect(error.message).toContain("[token]");
});


test("session deadline covers a stalled body and does not replay a mutation", async () => {
  transport();
  const client = new SessionClient(config());
  await client.session();
  let mutations = 0;
  globalThis.fetch = (async () => {
    mutations++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  }) as typeof fetch;
  await expect(client.request("projects/p/pages/", { method: "POST", body: { name: "Page" }, timeoutMs: 20 })).rejects.toThrow("timed out");
  expect(mutations).toBe(1);
});

test("session network and server failures do not refresh or replay writes", async () => {
  const stub = transport();
  const client = new SessionClient(config());
  await client.session();
  for (const status of [0, 404, 500]) {
    let mutations = 0;
    globalThis.fetch = (async () => {
      mutations++;
      if (!status) throw new Error("connection closed");
      return new Response(null, { status });
    }) as typeof fetch;
    await expect(client.request("projects/p/pages/", { method: "POST" })).rejects.toThrow(status ? String(status) : "connection closed");
    expect(mutations).toBe(1); expect(stub.logins()).toBe(1);
  }
});
