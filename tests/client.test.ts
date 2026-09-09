/*
 * The client, the secret guard, and the registry-to-implementation agreement.
 *
 * These cover what a live instance cannot easily be made to do: echo a token
 * back, stall a body, answer a page with a bare array. All of it runs against a
 * stub transport rather than the network.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { PlaneClient, PlaneError } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { guardSecret, scrub } from "../src/output.ts";
import { ALL_COMMANDS, knownFlags } from "../src/registry.ts";

const TOKEN = "plane_api_0123456789abcdef0123";

/*
 * The client picks undici when a proxy applies, which would ignore the stub
 * below and send these tests to the network — three seconds each, and a pass
 * that proves nothing. Excluding everything keeps the transport on the global
 * fetch this file replaces.
 */
beforeAll(() => {
  process.env.NO_PROXY = "*";
});

const config = (): Config => ({
  url: { value: "https://plane.test", origin: "flag" },
  token: { value: TOKEN, origin: "flag" },
  workspace: { value: "w", origin: "flag" },
  configPath: "/dev/null",
});

/** Replaces global fetch for one call and restores it afterwards. */
const withFetch = async <T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const respond = (body: string, init: ResponseInit = {}): typeof fetch =>
  (async () => new Response(body, init)) as unknown as typeof fetch;

describe("the token never reaches text", () => {
  test("a body echoing the token is redacted in the error", async () => {
    const client = new PlaneClient(config());
    const error = await withFetch(
      respond(`server said ${TOKEN} was wrong`, { status: 500 }),
      () => client.request("projects/").catch((cause: unknown) => cause),
    );
    expect(error).toBeInstanceOf(PlaneError);
    // The status pins this to the intended failure: a test accepting any error
    // passed even when every request threw a connection failure instead.
    expect((error as PlaneError).status).toBe(500);
    expect((error as PlaneError).message).not.toContain(TOKEN);
    expect((error as PlaneError).message).toContain("[token]");
  });

  test("padding before the token cannot push it past truncation", async () => {
    // The message is truncated, so redaction has to happen first.
    const client = new PlaneClient(config());
    const error = await withFetch(
      respond(`${"x".repeat(280)}${TOKEN}`, { status: 500 }),
      () => client.request("projects/").catch((cause: unknown) => cause),
    );
    expect((error as PlaneError).status).toBe(500);
    expect((error as PlaneError).message).not.toContain(TOKEN.slice(0, 20));
    expect((error as PlaneError).message).toContain("[token]");
  });

  test("a 200 that is not JSON does not quote the token back", async () => {
    const client = new PlaneClient(config());
    const error = await withFetch(
      respond(`not json, token was ${TOKEN}`, { status: 200 }),
      () => client.request("projects/").catch((cause: unknown) => cause),
    );
    expect((error as PlaneError).message).toContain("Expected JSON");
    expect((error as PlaneError).message).not.toContain(TOKEN);
  });

  test("the output guard scrubs anything printed, including json payloads", () => {
    guardSecret(TOKEN);
    const payload = JSON.stringify({ id: "me", echo: TOKEN });
    expect(scrub(payload)).not.toContain(TOKEN);
    expect(scrub(payload)).toContain("[token]");
    guardSecret("");
  });
});

describe("deadlines", () => {
  test("a stalled success body gives up rather than hanging", async () => {
    const stalled = (async () =>
      new Response(
        new ReadableStream({
          start() {
            // Never enqueues, never closes.
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const client = new PlaneClient(config());
    const started = Date.now();
    const error = await withFetch(stalled, () =>
      client.request("projects/", { timeoutMs: 60 }).catch((cause: unknown) => cause),
    );
    expect(error).toBeInstanceOf(PlaneError);
    // Names the timeout specifically: "any error" passed even when the request
    // failed instantly for an unrelated reason.
    expect((error as PlaneError).message).toMatch(/stalled|within/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a stalled error body gives up too", async () => {
    // A 500 whose body never completes used to hang with no limit at all.
    const stalled = (async () =>
      new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 500 },
      )) as unknown as typeof fetch;

    const client = new PlaneClient(config());
    const started = Date.now();
    const error = await withFetch(stalled, () =>
      client.request("projects/", { timeoutMs: 60 }).catch((cause: unknown) => cause),
    );
    expect(error).toBeInstanceOf(PlaneError);
    /*
     * The status is already known here, so the error names it rather than the
     * timeout — the point of the fix is that the command stops waiting at all.
     * Before it, a 500 whose body never completed hung with no limit.
     */
    expect((error as PlaneError).status).toBe(500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("pagination", () => {
  test("a bare array on a later page keeps the earlier rows", async () => {
    let call = 0;
    const seen: Array<string | null> = [];
    const paged = (async (input: string) => {
      call += 1;
      seen.push(new URL(input).searchParams.get("cursor"));
      return call === 1
        ? new Response(
            JSON.stringify({ results: [{ id: 1 }], next_page_results: true, next_cursor: "c" }),
            { status: 200 },
          )
        : new Response(JSON.stringify([{ id: 2 }]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new PlaneClient(config());
    const rows = await withFetch(paged, () => client.listAll<{ id: number }>("projects/"));
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
    // Without this the test passed even when the cursor was never sent, and the
    // second page was simply the first one again.
    expect(seen).toEqual([null, "c"]);
  });

  test("cursors are followed to the end", async () => {
    let call = 0;
    const seen: Array<string | null> = [];
    const paged = (async (input: string) => {
      call += 1;
      seen.push(new URL(input).searchParams.get("cursor"));
      const last = call === 3;
      return new Response(
        JSON.stringify({
          results: [{ id: call }],
          next_page_results: !last,
          next_cursor: last ? undefined : `c${call}`,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new PlaneClient(config());
    const rows = await withFetch(paged, () => client.listAll<{ id: number }>("projects/"));
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(seen).toEqual([null, "c1", "c2"]);
  });
});

describe("errors say what to do", () => {
  const cases: ReadonlyArray<[number, RegExp]> = [
    [401, /token rejected/i],
    [403, /token rejected/i],
    [404, /not found/i],
    [429, /rate limited/i],
  ];
  for (const [status, expected] of cases) {
    test(`${status} names the problem`, async () => {
      const client = new PlaneClient(config());
      const error = await withFetch(respond("{}", { status }), () =>
        client.request("projects/").catch((cause: unknown) => cause),
      );
      expect((error as PlaneError).message).toMatch(expected);
      expect((error as PlaneError).status).toBe(status);
    });
  }

  test("an unreachable host reports the underlying cause, not just 'fetch failed'", async () => {
    const failing = (async () => {
      const error = new Error("fetch failed");
      (error as Error & { cause?: unknown }).cause = Object.assign(new Error("getaddrinfo"), {
        code: "ENOTFOUND",
      });
      throw error;
    }) as unknown as typeof fetch;

    const client = new PlaneClient(config());
    const error = await withFetch(failing, () =>
      client.request("projects/").catch((cause: unknown) => cause),
    );
    expect((error as PlaneError).message).toContain("ENOTFOUND");
  });
});

describe("the registry agrees with what commands accept", () => {
  // A flag missing from the registry is rejected before the implementation ever
  // sees it, so `list --project CLOUD` failed while the code supported it.
  test("every example in the registry uses only flags that command declares", () => {
    for (const command of ALL_COMMANDS) {
      const allowed = knownFlags(command);
      for (const example of command.examples ?? []) {
        for (const flag of example.match(/--[a-z-]+/g) ?? []) {
          expect({ command: command.name, flag, allowed: [...allowed] }).toEqual({
            command: command.name,
            flag,
            allowed: expect.arrayContaining([flag.replace(/^--/, "")]),
          });
        }
      }
    }
  });

  test("commands taking a project reference declare --project", () => {
    for (const name of [
      "list",
      "show",
      "states",
      "labels",
      "create",
      "update",
      "done",
      "delete",
      "comment",
    ]) {
      const command = ALL_COMMANDS.find((entry) => entry.name === name);
      expect(command).toBeDefined();
      expect([...knownFlags(command as (typeof ALL_COMMANDS)[number])]).toContain("project");
    }
  });

  test("done accepts what update accepts, because it delegates to it", () => {
    const done = ALL_COMMANDS.find((entry) => entry.name === "done");
    const update = ALL_COMMANDS.find((entry) => entry.name === "update");
    const doneFlags = knownFlags(done as (typeof ALL_COMMANDS)[number]);
    for (const flag of knownFlags(update as (typeof ALL_COMMANDS)[number])) {
      // --state is the one thing done decides for itself; everything else it
      // forwards, so refusing those flags would refuse working calls.
      if (flag === "state") continue;
      expect([...doneFlags]).toContain(flag);
    }
  });

  test("every command declares --json", () => {
    for (const command of ALL_COMMANDS) {
      expect([...knownFlags(command)]).toContain("json");
    }
  });
});
