import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import type { PlaneClient } from "../src/client.ts";
import { guardSecret } from "../src/output.ts";
import { outline, prepareMarkdown, readBlock, readFragment, stamp } from "../src/page-document.ts";
import { parseReview } from "../src/page-review.ts";
import fixture from "./fixtures/pages/knowledge-review.json";

const documents: Y.Doc[] = [];
afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
  guardSecret("");
});
const document = () => {
  const doc = new Y.Doc();
  documents.push(doc);
  Y.applyUpdate(doc, Buffer.from(fixture.response.description_binary, "base64"));
  const fragment = doc.getXmlFragment("default");
  doc.transact(() => stamp(fragment));
  return fragment;
};

test("native review fixture reads as lossless Markdown with a useful outline", () => {
  const fragment = document();
  const row = outline(fragment)[0]!;
  expect(row.kind).toBe("knowledgeReview");
  expect(row.preview).toContain("Reviewed 2026-09-11: Reference");
  const block = readBlock(fragment, row.anchor!);
  expect(block.markdown).toBe(fixture.markdown);
  expect(block.losses).toEqual([]);
  expect(readFragment(fragment)).toEqual({ markdown: fixture.markdown, losses: [] });
});

test("review Markdown sends escaped semantic HTML and restores the original fields", async () => {
  const client = {
    request: async (path: string, options: { body: unknown }) => {
      expect(path).toBe("/live/convert-document");
      expect(options.body).toEqual({ description_html: fixture.html, variant: "rich" });
      return fixture.response;
    },
  } as unknown as PlaneClient;
  const prepared = await prepareMarkdown(client, fixture.markdown);
  documents.push(prepared.doc);
  expect(prepared.losses).toEqual([]);
  const node = prepared.fragment.get(0) as Y.XmlElement;
  expect(node.nodeName).toBe("knowledgeReview");
  expect(node.getAttribute("reviewedAt")).toBe(fixture.review.date);
  expect(node.getAttribute("source")).toBe(fixture.review.source);
  expect(readFragment(prepared.fragment).markdown).toBe(fixture.markdown);
});

test("malformed or lossy review input fails before conversion", async () => {
  let requests = 0;
  const client = { request: () => { requests++; throw new Error("Unexpected conversion"); } } as unknown as PlaneClient;
  for (const value of ["broken JSON", "null", "[]", '{"date":"2026-02-30","source":"Reference"}',
    '{"date":"2026-09-11","source":" "}', '{"date":"2026-09-11","source":"Reference","extra":true}'])
    await expect(prepareMarkdown(client, `\`\`\`knowledge-review\n${value}\n\`\`\``)).rejects.toThrow("knowledge-review");
  expect(requests).toBe(0);
  expect(parseReview('{"source":"  Reference  ","date":"2024-02-29"}')).toEqual({ date: "2024-02-29", source: "  Reference  " });
});

test("extra review data and other unknown nodes still produce loss warnings", () => {
  const fragment = document();
  const review = fragment.get(0) as Y.XmlElement;
  review.setAttribute("futureField", "Preserve this");
  expect(readFragment(fragment).losses.join(" ")).toContain("Additional review attributes");
  const unknown = new Y.XmlElement("unrecognizedExtension");
  unknown.setAttribute("value", "Unknown content");
  fragment.push([unknown]);
  const result = readFragment(fragment);
  expect(result.losses.join(" ")).toContain("Unsupported node unrecognizedExtension");
  expect(result.markdown).toContain("unrecognizedextension");
  expect(result.markdown).toContain("Unknown content");
});

test("review source secrets are redacted before outline truncation and JSON escaping", () => {
  const fragment = document();
  const node = fragment.get(0) as Y.XmlElement;
  const secret = 'sensitive-api-key-"<&value';
  node.setAttribute("source", secret);
  guardSecret(secret);
  const row = outline(fragment)[0]!;
  expect(row.preview).not.toContain(secret.slice(0, 16));
  const result = readBlock(fragment, row.anchor!);
  expect(result.markdown).not.toContain(secret);
  expect(result.markdown).not.toContain(JSON.stringify(secret).slice(1, -1));
  expect(result.markdown).toContain("[token]");
  expect(result.losses.join(" ")).toContain("Sensitive review metadata");
});

test("malformed review attributes and reserved code fences report conversion loss", () => {
  const fragment = document();
  const review = fragment.get(0) as Y.XmlElement;
  review.setAttribute("source", 42);
  expect(readFragment(fragment).losses).toContain("Review metadata is invalid");
  const code = new Y.XmlElement("codeBlock");
  code.setAttribute("language", "knowledge-review");
  fragment.push([code]);
  expect(readFragment(fragment).losses).toContain("The knowledge-review fence language is reserved for review metadata");
});

test("raw review HTML remains escaped and extra fence info is rejected", async () => {
  let requests = 0;
  const client = { request: async (_path: string, options: { body: { description_html: string } }) => {
    requests++;
    expect(options.body.description_html).toContain("&lt;div data-knowledge-review");
    expect(options.body.description_html).not.toContain("<div data-knowledge-review");
    return fixture.response;
  } } as unknown as PlaneClient;
  const prepared = await prepareMarkdown(client, fixture.html);
  documents.push(prepared.doc);
  expect(requests).toBe(1);
  for (const separator of [" ", "\t"])
    await expect(prepareMarkdown(client, `\`\`\`knowledge-review${separator}extra\n{}\n\`\`\``)).rejects.toThrow("additional info fields");
  expect(requests).toBe(1);
});
