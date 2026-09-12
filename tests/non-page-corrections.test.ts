import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { parseCommandArgs, UsageError, validatePositionals } from "../src/args.ts";
import { PlaneClient, PlaneError } from "../src/client.ts";
import { completeIssue, findIssues, formatFound, listIssues } from "../src/commands/issues.ts";
import { findState } from "../src/resolve.ts";
import { dateValue } from "../src/validation.ts";
import { runFixture } from "./fixture.ts";

for (const argv of [
  ["project", "rm", "Knowledge", "Base", "--yes"],
  ["project", "archive", "Knowledge", "Base"],
  ["update", "TEST-1", "--name", "New", "title"],
  ["delete", "TEST-1", "TEST-2", "--yes"],
  ["cycle", "transfer", "Old", "New", "Unexpected", "--project", "TEST"],
]) test(`surplus arguments fail before requests: ${argv.join(" ")}`, async () => {
  const trace: string[] = [];
  await expect(runFixture(argv, { trace })).rejects.toThrow("positional arguments");
  expect(trace).toEqual([]);
  const output = spawnSync(process.execPath, ["src/cli.ts", ...argv, "--config", "/dev/null"], {
    env: { PATH: process.env.PATH ?? "", PLANE_CONFIG: "/dev/null" }, encoding: "utf8", timeout: 5000,
  });
  expect(output.status).toBe(2);
  expect(output.stderr).toContain("Quote multiword names");
  expect(output.stderr).not.toContain("PLANE_URL");
});

test("quoted names and intentional variadic title/comment/search/bulk inputs remain accepted", async () => {
  for (const argv of [
    ["project", "rm", "Knowledge Base", "--yes"],
    ["create", "A", "multiword", "title", "--project", "TEST"],
    ["project", "create", "Knowledge", "Base", "--identifier", "KB"],
    ["comment", "TEST-1", "Multiword", "comment"],
    ["search", "Multiword", "search"],
    ["cycle", "add", "TEST-1", "TEST-2", "--project", "TEST", "--cycle", "First"],
    ["module", "add", "TEST-1", "TEST-2", "--project", "TEST", "--module", "First"],
  ]) {
    const args = parseCommandArgs(argv);
    expect(() => validatePositionals(args.path.join(" "), args)).not.toThrow();
  }
  const created = await runFixture(["create", "A", "multiword", "title", "--project", "TEST"]);
  expect(created.requests.find(row => row.method === "POST")?.body.name).toBe("A multiword title");
  const commented = await runFixture(["comment", "TEST-1", "Multiword", "comment"]);
  expect(commented.requests.find(row => row.method === "POST")?.body.comment_html).toBe("<p>Multiword comment</p>");
});

test("done retains the selected completed ID through case-colliding names", async () => {
  const states = [{ id: "backlog-id", name: "DONE", group: "backlog" }, { id: "completed-id", name: "Done", group: "completed" }];
  const project = { id: "11111111-1111-4111-8111-111111111111", name: "Test", identifier: "TEST" };
  const issue = { id: "issue", name: "Task", project: project.id, sequence_id: 1, priority: "none", state: "backlog-id" };
  const writes: unknown[] = [];
  const client = {
    listAll: async (path: string) => path.endsWith("/states/") ? states : [project],
    request: async (path: string, options: { method?: string; body?: object } = {}) => {
      if (options.method === "PATCH") { writes.push(options.body); return { ...issue, ...options.body }; }
      return path.startsWith("issues/") ? issue : project;
    },
  } as unknown as PlaneClient;
  const result = await completeIssue(client, parseCommandArgs(["done", "TEST-1"]));
  expect(writes).toEqual([{ state: "completed-id" }]);
  expect(result.group).toBe("completed");
  expect(() => findState(states, "done")).toThrow("Ambiguous state");
  expect(() => findState([states[0]!], "")).toThrow("Expected a state");
  expect(findState(states, "completed").id).toBe("completed-id");
  expect(findState(states, "COMPLETED-ID").id).toBe("completed-id");
});

for (const count of [0, 1, 10, 11, 20]) test(`search completeness is explicit for ${count} matches`, async () => {
  const hits = Array.from({ length: count }, (_, index) => ({ id: String(index), name: "Match", sequence_id: index + 1, project__identifier: "TEST" }));
  const calls: unknown[] = [];
  const client = { request: async (path: string, options: { query: { limit: number } }) => {
    calls.push({ path, ...options }); return { issues: hits.slice(0, options.query.limit) };
  } } as unknown as PlaneClient;
  const result = await findIssues(client, parseCommandArgs(["search", "Matching", "text"]));
  expect(calls).toEqual([{ path: "issues/search/", query: { search: "Matching text", limit: 11 } }]);
  expect(result.rows.length).toBe(Math.min(10, count));
  expect(result.limit).toBe(10);
  expect(result.hasMore).toBe(count > 10);
  expect(formatFound(result).includes("more exist")).toBe(count > 10);
  const complete = await findIssues(client, parseCommandArgs(["search", "Matching", "--limit", "20"]));
  expect(complete.rows.length).toBe(count);
  expect(complete.hasMore).toBe(false);
});

test("search rejects malformed successful responses instead of reporting no results", async () => {
  for (const answer of [undefined, {}, { issues: {} }])
    await expect(findIssues({ request: async () => answer } as unknown as PlaneClient, parseCommandArgs(["search", "text"]))).rejects.toThrow("expected an issues array");
});

for (const value of ["-1", "1.5", "", "Infinity", "9007199254740992"]) test(`invalid list/search limit ${JSON.stringify(value)} fails before requests`, async () => {
  let calls = 0;
  const client = { listAll: async () => { calls++; return []; }, request: async () => { calls++; return {}; } } as unknown as PlaneClient;
  await expect(listIssues(client, parseCommandArgs(["list", "TEST", `--limit=${value}`]))).rejects.toBeInstanceOf(UsageError);
  await expect(findIssues(client, parseCommandArgs(["search", "text", `--limit=${value}`]))).rejects.toBeInstanceOf(UsageError);
  expect(calls).toBe(0);
});
test("list retains zero while search enforces its documented positive bound", async () => {
  const result = await runFixture(["list", "TEST", "--limit", "0"]);
  expect(result.model.rows).toEqual([]); expect(result.model.total).toBe(2);
  for (const value of ["0", "1001"])
    await expect(findIssues({ request: () => { throw new Error("Unexpected request"); } } as unknown as PlaneClient, parseCommandArgs(["search", "text", "--limit", value]))).rejects.toBeInstanceOf(UsageError);
});

for (const pages of [
  [{ results: [], next_page_results: true, next_cursor: "same" }, { results: [], next_page_results: true, next_cursor: "same" }],
  [{ results: [], next_page_results: true, next_cursor: "a" }, { results: [], next_page_results: true, next_cursor: "b" }, { results: [], next_page_results: true, next_cursor: "a" }],
]) test(`pagination rejects a repeated cursor after ${pages.length} calls`, async () => {
  let calls = 0;
  const stub = { request: async () => { const page = pages[calls++]; if (!page) throw new Error("Collector exceeded the test bound"); return page; } };
  await expect(PlaneClient.prototype.listAll.call(stub as PlaneClient, "projects/")).rejects.toThrow("Repeated pagination cursor");
  expect(calls).toBe(pages.length);
});
for (const page of [undefined, {}, { results: {} }, { results: [], next_page_results: "true" }, { results: [], next_page_results: true }, { results: [], next_page_results: true, next_cursor: "" }])
  test(`malformed pagination cannot claim completeness: ${JSON.stringify(page)}`, async () => {
    await expect(PlaneClient.prototype.listAll.call({ request: async () => page } as unknown as PlaneClient, "projects/")).rejects.toBeInstanceOf(PlaneError);
  });
test("pagination preserves multi-page rows, array tails and initial-cursor progress checks", async () => {
  let calls = 0; const queries: unknown[] = [];
  const result = await PlaneClient.prototype.listAll.call({ request: async (_path: string, options: unknown) => {
    queries.push(options); return ++calls === 1 ? { results: [{ id: 1 }], next_page_results: true, next_cursor: "next" } : [{ id: 2 }];
  } } as unknown as PlaneClient, "projects/", { query: { per_page: 100 } });
  expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  expect(queries).toEqual([{ query: { per_page: 100 } }, { query: { per_page: 100, cursor: "next" } }]);
  await expect(PlaneClient.prototype.listAll.call({ request: async () => ({ results: [], next_page_results: true, next_cursor: "initial" }) } as unknown as PlaneClient, "projects/", { query: { cursor: "initial" } })).rejects.toThrow("Repeated pagination cursor");
});

test("calendar dates reject year zero while preserving valid boundary years and leap days", async () => {
  expect(() => dateValue("0000-01-01", "due")).toThrow(UsageError);
  for (const value of ["0001-01-01", "9999-12-31", "2024-02-29"])
    expect(dateValue(value, "due")).toBe(value);
  for (const argv of [
    ["update", "TEST-1", "--due", "0000-01-01"],
    ["cycle", "create", "Bad date", "--project", "TEST", "--start", "0000-01-01", "--end", "0000-01-02"],
    ["intake", "update", "TEST-1", "--project", "TEST", "--status", "snoozed", "--snooze-until", "0000-01-01"],
  ]) {
    const trace: string[] = [];
    await expect(runFixture(argv, { trace })).rejects.toThrow("YYYY-MM-DD");
    expect(trace.some(path => /^(POST|PATCH|DELETE) /.test(path))).toBe(false);
  }
});


test("unknown commands retain their own diagnostic when arguments are present", () => {
  const output = spawnSync(process.execPath, ["src/cli.ts", "unknown-command", "argument", "--config", "/dev/null"], {
    env: { PATH: process.env.PATH ?? "", PLANE_CONFIG: "/dev/null" }, encoding: "utf8", timeout: 5000,
  });
  expect(output.status).toBe(2);
  expect(output.stderr).toContain('No command "unknown-command"');
});
