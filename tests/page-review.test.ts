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

test("saved HTML page reads preserve review semantics independently of live dependencies", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const page = pageDetail({ id: "page", name: "Page", description_html: `<p>Before</p>${fixture.response.description_html}<p>After</p>` });
  expect(page.markdown).toBe(`Before\n\n${fixture.markdown}\n\nAfter`);
  expect(page.losses).toEqual([]);
  const prepared = await prepareMarkdown({ request: async () => fixture.response } as unknown as PlaneClient, fixture.markdown);
  documents.push(prepared.doc);
  const node = prepared.fragment.get(0) as Y.XmlElement;
  expect(node.nodeName).toBe("knowledgeReview");
  expect(node.getAttribute("source")).toBe(fixture.review.source);
});

test("saved page reads expose unsupported content and invalid review metadata", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const page = pageDetail({ id: "page", name: "Page", description_html: `${fixture.html}<mention-component entity_identifier="person">Name</mention-component>` });
  expect(page.markdown).toContain(fixture.markdown);
  expect(page.markdown).toContain('entity_identifier="person"');
  expect(page.losses.join(" ")).toContain("Unsupported page HTML element mention-component");
  const invalid = pageDetail({ id: "page", name: "Page", description_html: fixture.html.replace('2026-09-11', '2026-02-30') });
  expect(invalid.losses.join(" ")).toContain("Review metadata is invalid");
  expect(invalid.markdown).toContain("2026-02-30");
});

test("saved review secrets and unexpected semantic attributes produce explicit losses", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  guardSecret(fixture.review.source);
  const page = pageDetail({ id: "page", name: "Page", description_html: fixture.html });
  expect(page.markdown).toContain("[token]");
  expect(page.losses.join(" ")).toContain("Sensitive page content");
  guardSecret("");
  const extra = pageDetail({ id: "page", name: "Page", description_html: fixture.html.replace("<div", '<div data-extra="future"') });
  expect(extra.losses.join(" ")).toContain("Additional review attributes");
});

test("review blocks and nested line breaks in saved table cells report structural loss", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const table = pageDetail({ id: "page", name: "Page", description_html: `<table><tr><th>${fixture.html}</th></tr></table>` });
  expect(table.markdown).toContain("knowledge-review");
  expect(table.losses.join(" ")).toContain("Review blocks inside table cells");
  const lines = pageDetail({ id: "page", name: "Page", description_html: '<table><tr><th><p>One<br>Two</p></th></tr></table>' });
  expect(lines.losses.join(" ")).toContain("line breaks or block structure");
});

test("historically sanitized review HTML restores exact metadata from its saved block ID", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const canonical = structuredClone(fixture.response.description_json);
  canonical.content[0].attrs.id = "review-id";
  const html = fixture.response.description_html.replace('<div', '<div id="review-id"')
    .replace(/ data-knowledge-review=""/, '').replace(/ data-reviewed-at="[^"]*"/, '').replace(/ data-source="[^"]*"/, '');
  const result = pageDetail({ id: "page", name: "Page", description_html: html, description_json: canonical });
  expect(result.markdown).toBe(fixture.markdown);
  expect(result.losses).toEqual([]);
  expect(result).not.toHaveProperty("description_json");
});

test("unmatched canonical review data and duplicate HTML anchors cannot disappear silently", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const canonical = structuredClone(fixture.response.description_json);
  const missing = pageDetail({ id: "page", name: "Page", description_html: "<div>Reviewed history</div>", description_json: canonical });
  expect(missing.losses.join(" ")).toContain("omits canonical review metadata");
  canonical.content[0].attrs.id = "review-id";
  const html = fixture.response.description_html.replace('<div', '<div id="review-id"');
  const duplicate = pageDetail({ id: "page", name: "Page", description_html: html + html, description_json: canonical });
  expect(duplicate.losses.join(" ")).toContain("occurs more than once");
});

test("canonical empty documents do not resurrect stale HTML review markup", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const canonical = { ...fixture.response.description_json, content: [] };
  const result = pageDetail({ id: "page", name: "Page", description_html: fixture.html, description_json: canonical });
  expect(result.losses.join(" ")).toContain("absent from the canonical document");
  expect(result.markdown).not.toContain("```knowledge-review\n");
});

test("canonical review recovery never returns unredacted metadata", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const canonical = structuredClone(fixture.response.description_json);
  canonical.content[0].attrs.id = "review-id";
  canonical.content[0].attrs.source = 'canonical-secret-"value';
  guardSecret(canonical.content[0].attrs.source);
  const result = pageDetail({ id: "page", name: "Page", description_html: '<div id="review-id">Old review text</div>', description_json: canonical });
  expect(JSON.stringify(result)).not.toContain("canonical-secret");
  expect(result.markdown).toContain("[token]");
  expect(result.losses.join(" ")).toContain("Sensitive review metadata");
});

test("invalid canonical fields cannot borrow valid stale HTML metadata", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  for (const field of ["reviewedAt", "source"]) {
    const canonical = structuredClone(fixture.response.description_json);
    canonical.content[0].attrs.id = "review-id";
    canonical.content[0].attrs[field] = null;
    const result = pageDetail({ id: "page", name: "Page", description_html: fixture.html.replace('<div', '<div id="review-id"'), description_json: canonical });
    expect(result.losses.join(" ")).toContain("Review metadata is invalid");
    expect(result.markdown).not.toContain("```knowledge-review\n");
  }
});

test("review wrappers and canonical marks cannot silently change semantic Markdown", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  for (const tag of ["code", "strong", "h2", "pre"]) {
    const result = pageDetail({ id: "page", name: "Page", description_html: `<${tag}>${fixture.html}</${tag}>` });
    expect(result.losses.join(" ")).toContain(`Review blocks inside ${tag}`);
  }
  const canonical = structuredClone(fixture.response.description_json);
  canonical.content[0].marks = [{ kind: "example-mark" }];
  const result = pageDetail({ id: "page", name: "Page", description_html: fixture.html, description_json: canonical });
  expect(result.losses.join(" ")).toContain("Additional review attributes");
});

test("canonical review order differences expose changes to equal-date source selection", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  const { reviewHtml } = await import("../src/page-review.ts");
  const first = structuredClone(fixture.response.description_json.content[0]);
  const second = structuredClone(first);
  first.attrs = { id: "first", reviewedAt: "2026-09-11", source: "First" };
  second.attrs = { id: "second", reviewedAt: "2026-09-11", source: "Second" };
  const html = reviewHtml({ date: "2026-09-11", source: "First" }).replace('<div', '<div id="first"') + reviewHtml({ date: "2026-09-11", source: "Second" }).replace('<div', '<div id="second"');
  const result = pageDetail({ id: "page", name: "Page", description_html: html, description_json: { ...fixture.response.description_json, content: [second, first] } });
  expect(result.losses.join(" ")).toContain("equal-date source selection would change");
});

test("empty and caption-only tables cannot crash a saved page read", async () => {
  const { pageDetail } = await import("../src/commands/page-data.ts");
  for (const table of ["<table></table>", "<table><tbody></tbody></table>", "<table><caption>Caption</caption></table>", "<table><tr></tr></table>"]) {
    const result = pageDetail({ id: "page", name: "Page", description_html: `<p>Readable page</p>${table}` });
    expect(result.markdown).toContain("Readable page");
    expect(result.markdown).toContain("<table>");
    expect(result.losses.join(" ")).toContain("table without cells");
  }
});
