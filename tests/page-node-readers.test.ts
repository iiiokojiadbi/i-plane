import { expect, test } from "bun:test";
import * as Y from "yjs";
import { parseCommandArgs } from "../src/args.ts";
import { PlaneError } from "../src/client.ts";
import { runPageContent } from "../src/commands/page-content.ts";
import { prepareMarkdown, readFragment, stamp } from "../src/page-document.ts";
import { editDocument } from "../src/page-edit.ts";
import type { PageClient } from "../src/page-transport.ts";
import review from "./fixtures/pages/knowledge-review.json";
import heading from "./fixtures/pages/heading.json";

test("unknown node preservation refuses every Markdown write before conversion, creation or live traffic", async () => {
  let requests = 0;
  const client = {
    listAll: async () => [{ id: "project", identifier: "APP", name: "Project" }],
    request: async () => { requests++; throw new Error("Unexpected request"); },
  } as unknown as PageClient;
  for (const words of [
    ["page", "create", "APP", "--name", "Page"],
    ["page", "set", "APP", "Page"],
    ["page", "set", "APP", "Page", "--block", "block", "--force"],
    ["page", "insert", "APP", "Page", "--at-end"],
  ]) {
    const args = parseCommandArgs([...words, "--text", review.markdown, "--allow-loss"]);
    const error = await runPageContent(args.path.join(" "), client, args, true).catch(error => error);
    expect(error).toBeInstanceOf(PlaneError);
    expect(error.message).toContain("has not confirmed a reader that preserves knowledgeReview");
  }
  expect(requests).toBe(0);
});

test("nested review fences require confirmation, while ordinary code examples and raw HTML do not", async () => {
  let conversions = 0;
  const client = { request: async () => { conversions++; return heading.response; } } as unknown as PageClient;
  for (const markdown of [review.markdown.split("\n").map(line => "> " + line).join("\n"),
    "- Item\n\n" + review.markdown.split("\n").map(line => "  " + line).join("\n")])
    await expect(prepareMarkdown(client, markdown)).rejects.toThrow("knowledgeReview");
  expect(conversions).toBe(0);
  for (const markdown of [heading.markdown, "````text\n" + review.markdown + "\n````", review.html]) {
    const result = await prepareMarkdown(client, markdown); result.doc.destroy();
  }
  expect(conversions).toBe(3);
});

test("reader access errors remain access errors and cannot start conversion", async () => {
  let conversions = 0;
  for (const status of [401, 403]) {
    const error = new PlaneError("Reader discovery access denied", status);
    const client = { nodeReaders: async () => { throw error; }, request: async () => { conversions++; } } as unknown as PageClient;
    await expect(prepareMarkdown(client, review.markdown)).rejects.toBe(error);
  }
  expect(conversions).toBe(0);
});

test("an edit cannot indirectly retain an unsupported review node; explicit removal remains possible", async () => {
  const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(review.response.description_binary, "base64"));
  const fragment = doc.getXmlFragment("default"); doc.transact(() => stamp(fragment));
  const before = Y.encodeStateAsUpdate(doc);
  const plain = await prepareMarkdown({ request: async () => heading.response } as unknown as PageClient, heading.markdown);
  try {
    expect(() => doc.transact(() => editDocument(fragment, { kind: "insert", atEnd: true }, plain))).toThrow("knowledgeReview");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.transact(() => editDocument(fragment, { kind: "set" }, plain));
    expect(readFragment(fragment).markdown).toBe(heading.markdown);
  } finally { doc.destroy(); plain.doc.destroy(); }
});

test("CLI returns exit 1 and sends no mutation when reader confirmation is unavailable", async () => {
  let writes = 0;
  const api = Bun.serve({ port: 0, fetch(request) {
    if (request.method !== "GET") { writes++; return Response.json({ error: "Unexpected mutation" }, { status: 500 }); }
    if (new URL(request.url).pathname.startsWith("/api/extensions/")) return new Response(null, {status:404});
    if (new URL(request.url).pathname.endsWith("/pages/")) return Response.json([]);
    return Response.json([{ id: "11111111-1111-4111-8111-111111111111", identifier: "APP", name: "Project" }]);
  } });
  try {
    const env = { ...process.env, PLANE_CONFIG: "/dev/null", PLANE_URL: api.url.origin, PLANE_WORKSPACE: "fixture", PLANE_API_KEY: "fixture-key", NO_PROXY: "*" };
    const child = Bun.spawn(["bun", "src/cli.ts", "page", "create", "APP", "--name", "Page", "--text", review.markdown, "--allow-loss"], { env, stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(status).toBe(1);
    expect(stderr).toContain("has not confirmed a reader that preserves knowledgeReview");
    expect(writes).toBe(0);
  } finally { api.stop(true); }
});
