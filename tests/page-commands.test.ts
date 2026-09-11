import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { parseCommandArgs } from "../src/args.ts";
import { dispatchPageCommand } from "../src/page-dispatch.ts";
import { runPageContent } from "../src/commands/page-content.ts";
import { outline, readFragment } from "../src/page-document.ts";
import type { PlaneClient } from "../src/client.ts";
import { ALL_COMMANDS } from "../src/registry.ts";
import heading from "./fixtures/pages/heading.json";
import replacement from "./fixtures/pages/replacement.json";
import { closeServers, server } from "./page-wire.ts";

const oldWrite = process.stdout.write,
  oldError = console.error,
  oldNoProxy = process.env.NO_PROXY;
let printed: string[] = [];
afterEach(() => {
  closeServers();
  process.stdout.write = oldWrite;
  console.error = oldError;
  printed = [];
  if (oldNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = oldNoProxy;
});
const capture = () => {
  process.stdout.write = ((chunk: string) => {
    printed.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.error = () => {};
};
const args = (words: string[]) => parseCommandArgs(words);
test("invalid page writes fail before any request, including empty block and false confirmation", async () => {
  let requests = 0;
  const client = {
    listAll: () => {
      requests++;
      throw new Error("unexpected request");
    },
    request: () => {
      requests++;
      throw new Error("unexpected request");
    },
  } as unknown as PlaneClient;
  for (const words of [
    ["page", "rm", "APP", "Page", "--yes=false"],
    ["page", "rm", "APP", "Page", "--yes", "--block="],
    ["page", "set", "APP", "Page", "--block=", "--text", "oops"],
    ["page", "set", "APP", "Page", "--file", "x", "--text", "y"],
    ["page", "set", "APP", "Page"],
    ["page", "set", "APP", "Page", "--force", "--text", "x"],
    ["page", "set", "APP", "Page", "--block", "a", "--if-match", "bad", "--text", "x"],
    ["page", "insert", "APP", "Page", "--after", "a", "--at-end", "--text", "x"],
    ["page", "insert", "APP", "Page", "--at-end=false", "--text", "x"],
    ["page", "read", "APP", "Page"],
    ["page", "create", "APP", "--text", "x"],
  ]) {
    const parsed = args(words);
    await expect(runPageContent(parsed.path.join(" "), client, parsed, true)).rejects.toThrow();
  }
  expect(requests).toBe(0);
});

test("failed content creation reports the created UUID without repeating POST", async () => {
  process.env.NO_PROXY = "*";
  const stub = await server("before");
  let posts = 0;
  const client = {
    config: { url: { value: stub.url }, workspace: { value: "workspace" }, token: { value: "page-api-secret" } },
    listAll: async () => [{ id: "project", identifier: "APP", name: "Project" }],
    request: async (path: string) => {
      if (path === "/live/convert-document") return heading.response;
      if (path === "/api/extensions/configuration/") return { release: "test-release" };
      posts++;
      return { id: "created-page-id", name: "Page" };
    },
  } as unknown as PlaneClient;
  await expect(
    runPageContent(
      "page create",
      client,
      args(["page", "create", "APP", "--name", "Page", "--text", heading.markdown]),
      true,
    ),
  ).rejects.toThrow("Page created-page-id was created");
  expect(posts).toBe(1);
});

test("failed deletion reports the archived page, and an already archived page is not archived again", async () => {
  let archived: string | null = null;
  const methods: string[] = [];
  const client = {
    listAll: async (path: string) =>
      path === "projects/"
        ? [{ id: "project", identifier: "APP", name: "Project" }]
        : [{ id: "page-id", name: "Page" }],
    request: async (path: string, options: { method?: string } = {}) => {
      const method = options.method ?? "GET";
      methods.push(method);
      if (path.endsWith("archive/")) {
        archived = "2026-01-01";
        return {};
      }
      if (method === "DELETE") throw new Error("Connection lost");
      return { id: "page-id", name: "Page", archived_at: archived };
    },
  } as unknown as PlaneClient;
  const invoke = () =>
    runPageContent("page rm", client, args(["page", "rm", "APP", "Page", "--yes"]), true);
  await expect(invoke()).rejects.toThrow(
    "Page page-id was archived, but deletion was not confirmed",
  );
  expect(methods).toEqual(["GET", "POST", "DELETE"]);
  methods.length = 0;
  await expect(invoke()).rejects.toThrow("deletion was not confirmed");
  expect(methods).toEqual(["GET", "DELETE"]);
});

test("unconfirmed archive reports UUID and does not attempt deletion", async () => {
  const methods: string[] = [];
  let archived = false;
  const client = {
    listAll: async (path: string) =>
      path === "projects/"
        ? [{ id: "project", identifier: "APP", name: "Project" }]
        : [{ id: "page-id", name: "Page" }],
    request: async (path: string, options: { method?: string } = {}) => {
      methods.push(options.method ?? "GET");
      if (path.endsWith("archive/")) {
        archived = true;
        throw new Error("response lost");
      }
      return { id: "page-id", name: "Page" };
    },
  } as unknown as PlaneClient;
  await expect(
    runPageContent("page rm", client, args(["page", "rm", "APP", "Page", "--yes"]), true),
  ).rejects.toThrow("Archiving page page-id was not confirmed");
  expect(archived).toBe(true);
  expect(methods).toEqual(["GET", "POST"]);
});
test("every page handler executes: JSON, file input, anchor edits, metadata CRUD and locking", async () => {
  capture();
  process.env.NO_PROXY = "*";
  const stub = await server();
  const page = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Page",
    description_html: "<p>Saved content</p>",
    is_locked: false,
  };
  const project = {
    id: "22222222-2222-4222-8222-222222222222",
    identifier: "APP",
    name: "Project",
  };
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const client = {
    config: { url: { value: stub.url }, workspace: { value: "workspace" }, token: { value: "page-api-secret" } },
    listAll: async (path: string) => (path === "projects/" ? [project] : [page]),
    request: async (path: string, options: { method?: string; body?: unknown } = {}) => {
      if (path === "/api/extensions/configuration/") return { release: "test-release" };
      if (path === "/live/convert-document") {
        const html = (options.body as { description_html: string }).description_html;
        return html === heading.html ? heading.response : replacement.response;
      }
      calls.push({ path, method: options.method ?? "GET", body: options.body });
      return page;
    },
  } as unknown as PlaneClient;
  const executed = new Set<string>();
  const run = async (words: string[]) => {
    const parsed = args(words);
    const name = parsed.path.join(" ");
    executed.add(name);
    await dispatchPageCommand(name, client, parsed, true);
    return JSON.parse(printed.at(-1)!);
  };
  const directory = await mkdtemp(join(tmpdir(), "page-input-"));
  try {
    const file = join(directory, "content.md");
    await writeFile(file, heading.markdown);
    expect(await run(["pages", "APP"])).toHaveLength(1);
    expect((await run(["page", "show", "APP", "Page"])).markdown).toBe("Saved content");
    const created = await run(["page", "create", "APP", "--name", "Page", "--file", file]);
    expect(created.delivery).toBe("acknowledged");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ name: "Page", access: 0 });
    const rows = await run(["page", "outline", "APP", "Page"]);
    expect(rows).toHaveLength(2);
    const first = rows[0].anchor;
    const read = await run(["page", "read", "APP", "Page", "--block", first]);
    expect(read.markdown).toBe("# Heading");
    const replaced = await run([
      "page",
      "set",
      "APP",
      "Page",
      "--block",
      first,
      "--if-match",
      read.fingerprint,
      "--text",
      replacement.markdown,
    ]);
    expect(replaced.delivery).toBe("acknowledged");
    await expect(
      run([
        "page",
        "set",
        "APP",
        "Page",
        "--block",
        first,
        "--if-match",
        read.fingerprint,
        "--text",
        replacement.markdown,
      ]),
    ).rejects.toThrow("content changed");
    await run([
      "page",
      "set",
      "APP",
      "Page",
      "--block",
      first,
      "--if-match",
      read.fingerprint,
      "--force",
      "--text",
      replacement.markdown,
    ]);
    await run(["page", "insert", "APP", "Page", "--after", first, "--text", replacement.markdown]);
    await run(["page", "insert", "APP", "Page", "--at-end", "--text", replacement.markdown]);
    const unstamped = new Y.XmlElement("paragraph");
    stub.fragment.insert(0, [unstamped]);
    expect((await run(["page", "stamp", "APP", "Page"])).stamped).toBe(1);
    expect((await run(["page", "stamp", "APP", "Page"])).delivery).toBe("unchanged");
    await run(["page", "rm", "APP", "Page", "--block", first, "--yes"]);
    expect(outline(stub.fragment).some((row) => row.anchor === first)).toBe(false);
    page.is_locked = true;
    await expect(run(["page", "set", "APP", "Page", "--text", heading.markdown])).rejects.toThrow(
      "locked",
    );
    page.is_locked = false;
    await run(["page", "set", "APP", "Page", "--text", heading.markdown]);
    expect(readFragment(stub.fragment).markdown).toContain("# Heading");
    await run(["page", "rm", "APP", "Page", "--yes"]);
    expect(calls.at(-1)?.method).toBe("DELETE");
    expect(calls.at(-2)?.path).toEndWith("/archive/");
    expect(calls.at(-2)?.method).toBe("POST");
    expect([...executed].sort()).toEqual(
      ALL_COMMANDS.filter((command) => command.name === "pages" || command.name.startsWith("page "))
        .map((command) => command.name)
        .sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
