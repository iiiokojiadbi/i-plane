import { expect, test } from "bun:test";
import { guardSecret, printValue } from "../src/output.ts";
import { pageDetail } from "../src/commands/page-data.ts";
import * as Y from "yjs";
import {
  findBlock,
  fingerprint,
  outline,
  prepareMarkdown,
  readBlock,
  readFragment,
  stamp,
} from "../src/page-document.ts";
import { editDocument } from "../src/page-edit.ts";
import type { PlaneClient } from "../src/client.ts";
import heading from "./fixtures/pages/heading.json";
import code from "./fixtures/pages/code.json";
import table from "./fixtures/pages/table.json";
import image from "./fixtures/pages/image.json";
import replacement from "./fixtures/pages/replacement.json";
import schema from "./fixtures/pages/schema.json";
import tasks from "./fixtures/pages/tasks.json";
import emptyTasks from "./fixtures/pages/empty-tasks.json";
import looseTasks from "./fixtures/pages/loose-tasks.json";

export const document = (binary = heading.response.description_binary) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(binary, "base64"));
  return { doc, fragment: doc.getXmlFragment("default") };
};
test("fingerprints include semantic ids of nested nodes", () => {
  const { doc, fragment } = document();
  const paragraph = fragment.get(1) as Y.XmlElement;
  const mention = new Y.XmlElement("mention");
  mention.setAttribute("id", "person-one");
  paragraph.insert(0, [mention]);
  const before = fingerprint(paragraph);
  mention.setAttribute("id", "person-two");
  expect(fingerprint(paragraph)).not.toBe(before);
  doc.destroy();
});
test("outline masks secrets before truncating text or anchors, in plain and JSON output", () => {
  const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const { doc, fragment } = document();
  const paragraph = new Y.XmlElement("paragraph"),
    text = new Y.XmlText();
  paragraph.setAttribute("id", secret);
  text.insert(0, secret);
  paragraph.insert(0, [text]);
  fragment.insert(0, [paragraph]);
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  guardSecret(secret);
  try {
    for (const json of [false, true])
      printValue(outline(fragment), json, (rows) =>
        rows.map((row) => `${row.shortAnchor} ${row.preview}`).join("\n"),
      );
    expect(output).not.toContain(secret.slice(0, 8));
    expect(output).not.toContain(secret.slice(0, 40));
    expect(output).toContain("[token]");
  } finally {
    process.stdout.write = original;
    guardSecret("");
    doc.destroy();
  }
});
test("page read and show redact before Markdown escaping changes the secret", () => {
  const secret = "secret[brackets]*";
  const { doc, fragment } = document();
  const paragraph = fragment.get(1) as Y.XmlElement;
  paragraph.setAttribute("id", "block");
  paragraph.delete(0, paragraph.length);
  const text = new Y.XmlText();
  text.insert(0, secret);
  text.format(0, 6, { bold: {} });
  paragraph.insert(0, [text]);
  guardSecret(secret);
  try {
    const result = readBlock(fragment, "block");
    expect(result.markdown).not.toContain("secret");
    expect(result.losses.join(" ")).toContain("redacted");
    expect(
      pageDetail({ id: "page", name: "Page", description_html: `<p>${secret}</p>` }).markdown,
    ).not.toContain("secret");
  } finally {
    guardSecret("");
    doc.destroy();
  }
});
test("complex table cells report structural loss and refuse silent replacement", async () => {
  for (const shape of ["paragraphs", "hardBreak", "codeBlock"]) {
    const doc = new Y.Doc(),
      fragment = doc.getXmlFragment("default");
    const table = new Y.XmlElement("table"),
      row = new Y.XmlElement("tableRow"),
      cell = new Y.XmlElement("tableCell");
    for (const content of [
      "first paragraph",
      ...(shape === "paragraphs" ? ["second paragraph"] : []),
    ]) {
      const block = new Y.XmlElement(shape === "codeBlock" ? "codeBlock" : "paragraph"),
        text = new Y.XmlText();
      text.insert(0, content);
      block.insert(0, [text]);
      if (shape === "hardBreak") block.push([new Y.XmlElement("hardBreak")]);
      cell.push([block]);
    }
    row.push([cell]);
    table.push([row]);
    fragment.push([table]);
    const read = readFragment(fragment);
    expect(read.losses.join(" ")).toContain("inside table cells");
    const prepared = await prepareMarkdown(converter(heading.response), heading.markdown);
    expect(() => doc.transact(() => editDocument(fragment, { kind: "set" }, prepared))).toThrow(
      "--allow-loss",
    );
    expect(fragment.get(0)).toBe(table);
    prepared.doc.destroy();
    doc.destroy();
  }
});
const converter = (response: unknown) =>
  ({ request: async () => response }) as PlaneClient;

for (const [name, fixture] of Object.entries({
  heading,
  code,
  table,
  image,
  replacement,
  tasks,
  emptyTasks,
  looseTasks,
})) {
  test(`converter fixture: ${name} preserves content without a loss override`, async () => {
    const prepared = await prepareMarkdown(converter(fixture.response), fixture.markdown);
    try {
      expect(prepared.losses).toEqual([]);
      expect(prepared.fragment.length).toBeGreaterThan(0);
      expect(outline(prepared.fragment).every((row) => row.anchor)).toBe(true);
      if (name === "code") expect(readFragment(prepared.fragment).markdown).toContain("```python");
    } finally {
      prepared.doc.destroy();
    }
  });
}
test("empty task items retain checked state with no loss warning", async () => {
  const prepared = await prepareMarkdown(converter(emptyTasks.response), emptyTasks.markdown);
  const list = prepared.fragment.get(0) as Y.XmlElement;
  expect(list.nodeName).toBe("taskList");
  expect((list.get(0) as Y.XmlElement).getAttribute("checked")).toBe(true);
  expect((list.get(1) as Y.XmlElement).getAttribute("checked")).toBe(false);
  expect(readFragment(prepared.fragment).markdown).toBe("- [x] \n- [ ]");
  expect(prepared.losses).toEqual([]);
  prepared.doc.destroy();
});
test("loose task items preserve multiple paragraphs without a false loss warning", async () => {
  const prepared = await prepareMarkdown(converter(looseTasks.response), looseTasks.markdown);
  expect(readFragment(prepared.fragment).markdown).toBe(looseTasks.markdown);
  expect(prepared.losses).toEqual([]);
  prepared.doc.destroy();
});
test("checkbox round-trip preserves checked state and nested task structure", async () => {
  const prepared = await prepareMarkdown(converter(tasks.response), tasks.markdown);
  try {
    expect(prepared.losses).toEqual([]);
    expect(readFragment(prepared.fragment).markdown).toBe(tasks.markdown);
    const list = prepared.fragment.get(0) as Y.XmlElement;
    expect(list.nodeName).toBe("taskList");
    const checked = list.get(0) as Y.XmlElement,
      unchecked = list.get(1) as Y.XmlElement;
    expect(checked.nodeName).toBe("taskItem");
    expect(checked.getAttribute("checked")).toBe(true);
    expect(unchecked.getAttribute("checked")).toBe(false);
    expect((unchecked.get(1) as Y.XmlElement).nodeName).toBe("taskList");
  } finally {
    prepared.doc.destroy();
  }
});
test("conversion to ordinary bullet items cannot silently discard checkbox semantics", async () => {
  const doc = new Y.Doc(),
    fragment = doc.getXmlFragment("default");
  const list = new Y.XmlElement("bulletList"),
    item = new Y.XmlElement("listItem"),
    paragraph = new Y.XmlElement("paragraph"),
    text = new Y.XmlText();
  text.insert(0, "[x] Finished");
  paragraph.insert(0, [text]);
  item.insert(0, [paragraph]);
  list.insert(0, [item]);
  fragment.insert(0, [list]);
  const response = {
    description_binary: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
  };
  const prepared = await prepareMarkdown(converter(response), "- [x] Finished");
  expect(prepared.losses.join(" ")).toContain("changed Markdown");
  prepared.doc.destroy();
  doc.destroy();
});
test("nested structural anchors do not create a false content conflict", () => {
  const { doc, fragment } = document();
  const list = new Y.XmlElement("bulletList"),
    item = new Y.XmlElement("listItem"),
    paragraph = new Y.XmlElement("paragraph");
  item.insert(0, [paragraph]);
  list.insert(0, [item]);
  fragment.insert(0, [list]);
  const before = fingerprint(list);
  paragraph.setAttribute("id", "browser-paragraph-anchor");
  item.setAttribute("id", "browser-item-anchor");
  expect(fingerprint(list)).toBe(before);
  doc.destroy();
});
test("nested review fingerprints ignore structural anchors but retain date, source and unknown semantic ids", () => {
  const doc = new Y.Doc(),
    fragment = doc.getXmlFragment("default"),
    quote = new Y.XmlElement("blockquote"),
    review = new Y.XmlElement("knowledgeReview");
  quote.setAttribute("id", "quote-anchor");
  review.setAttribute("reviewedAt", "2026-09-12");
  review.setAttribute("source", "Maintenance notes");
  quote.insert(0, [review]);
  fragment.insert(0, [quote]);
  try {
    const before = readBlock(fragment, "quote-anchor");
    for (const anchor of ["assigned-review-anchor", "reassigned-review-anchor"]) {
      review.setAttribute("id", anchor);
      const after = readBlock(fragment, "quote-anchor");
      expect(after.fingerprint).toBe(before.fingerprint);
      expect(after.markdown).toBe(before.markdown);
      expect(after.losses).toEqual([]);
    }
    review.removeAttribute("id");
    expect(fingerprint(quote)).toBe(before.fingerprint);
    review.setAttribute("reviewedAt", "2026-09-13");
    expect(fingerprint(quote)).not.toBe(before.fingerprint);
    review.setAttribute("reviewedAt", "2026-09-12");
    review.setAttribute("source", "Updated maintenance notes");
    expect(fingerprint(quote)).not.toBe(before.fingerprint);
    review.setAttribute("source", "Maintenance notes");
    expect(fingerprint(quote)).toBe(before.fingerprint);

    const mention = new Y.XmlElement("mention");
    mention.setAttribute("id", "person-one");
    quote.insert(1, [mention]);
    const withMention = fingerprint(quote);
    mention.setAttribute("id", "person-two");
    expect(fingerprint(quote)).not.toBe(withMention);
  } finally {
    doc.destroy();
  }
});

test("assigning a nested review anchor does not reject a fingerprint-protected parent replacement", () => {
  const doc = new Y.Doc(),
    fragment = doc.getXmlFragment("default"),
    quote = new Y.XmlElement("blockquote"),
    review = new Y.XmlElement("knowledgeReview"),
    preparedDoc = new Y.Doc(),
    prepared = { doc: preparedDoc, fragment: preparedDoc.getXmlFragment("default"), losses: [] };
  quote.setAttribute("id", "quote-anchor");
  review.setAttribute("reviewedAt", "2026-09-12");
  review.setAttribute("source", "Maintenance notes");
  quote.insert(0, [review]);
  fragment.insert(0, [quote]);
  prepared.fragment.insert(0, [new Y.XmlElement("paragraph")]);
  try {
    const before = readBlock(fragment, "quote-anchor");
    review.setAttribute("id", "assigned-review-anchor");
    doc.transact(() => editDocument(fragment, {
      kind: "set", block: "quote-anchor", ifMatch: before.fingerprint,
    }, prepared));
    const replaced = findBlock(fragment, "quote-anchor").node;
    expect(replaced.nodeName).toBe("paragraph");
    expect(fragment.length).toBe(1);
  } finally {
    preparedDoc.destroy();
    doc.destroy();
  }
});

test("empty full replacement needs no converter and clears a document", async () => {
  const target = document();
  const prepared = await prepareMarkdown(
    {
      request: () => {
        throw new Error("must not call converter");
      },
    } as unknown as PlaneClient,
    "",
  );
  target.doc.transact(() => editDocument(target.fragment, { kind: "set" }, prepared));
  expect(target.fragment.length).toBe(0);
  prepared.doc.destroy();
  target.doc.destroy();
});
test("converter returning unrelated content is detected", async () => {
  const prepared = await prepareMarkdown(
    converter(heading.response),
    "Completely different content",
  );
  expect(prepared.losses.join(" ")).toContain("changed Markdown");
  prepared.doc.destroy();
});
test("schema reader preserves lists, checkboxes, links, tables, images and warns about underline", () => {
  const { doc, fragment } = document(schema.response.description_binary);
  const result = readFragment(fragment);
  for (const text of [
    "## Heading",
    "**bold**",
    "*italic*",
    "~strike~",
    "`code`",
    "[link](https://example.com)",
    "3. third",
    "[x]",
    "[ ]",
    "> quote",
    "| A | B |",
    "![image](https://example.com/a.png)",
    "before",
    "after",
  ])
    expect(result.markdown).toContain(text);
  expect(result.losses.join(" ")).toContain("underline");
  doc.destroy();
});
test("read and outline never assign anchors; stamp is top-level and preserves existing ids", () => {
  const { doc, fragment } = document();
  const before = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("hex");
  outline(fragment);
  readFragment(fragment);
  expect(Buffer.from(Y.encodeStateAsUpdate(doc)).toString("hex")).toBe(before);
  const count = stamp(fragment);
  expect(count).toBe(fragment.length);
  const ids = outline(fragment).map((row) => row.anchor);
  expect(stamp(fragment)).toBe(0);
  expect(outline(fragment).map((row) => row.anchor)).toEqual(ids);
  const first = fragment.get(0) as Y.XmlElement;
  expect(first.get(0)).toBeInstanceOf(Y.XmlText);
  doc.destroy();
});
test("anchors resolve current index, reject ambiguity and detect content changes independently of ids", () => {
  const { doc, fragment } = document();
  stamp(fragment);
  const first = fragment.get(0) as Y.XmlElement,
    second = fragment.get(1) as Y.XmlElement;
  first.setAttribute("id", "aaa-first");
  second.setAttribute("id", "aaa-second");
  expect(() => findBlock(fragment, "aaa")).toThrow("Ambiguous");
  expect(() => findBlock(fragment, "missing")).toThrow("page outline");
  const original = fingerprint(second);
  second.setAttribute("id", "new-anchor");
  expect(fingerprint(second)).toBe(original);
  const text = second.get(0) as Y.XmlText;
  text.insert(0, "changed ");
  expect(fingerprint(second)).not.toBe(original);
  fragment.insert(0, [new Y.XmlElement("paragraph")]);
  expect(findBlock(fragment, "new-anchor").index).toBe(2);
  expect(readBlock(fragment, "new-anchor").fingerprint).toBe(fingerprint(second));
  doc.destroy();
});
test("concurrent insertion during preparation cannot redirect a replacement; first block inherits anchor", async () => {
  const { doc, fragment } = document();
  stamp(fragment);
  const anchor = outline(fragment)[1]!.anchor!,
    hash = readBlock(fragment, anchor).fingerprint;
  const prepared = await prepareMarkdown(converter(replacement.response), replacement.markdown);
  fragment.insert(0, [new Y.XmlElement("paragraph")]);
  doc.transact(() =>
    editDocument(fragment, { kind: "set", block: anchor, ifMatch: hash }, prepared),
  );
  expect(fragment.length).toBe(4);
  expect(findBlock(fragment, anchor).index).toBe(2);
  expect(readBlock(fragment, anchor).markdown).toBe("First replacement");
  expect(outline(fragment)[3]!.anchor).not.toBe(anchor);
  expect(readFragment(fragment).markdown).toContain("# Heading");
  prepared.doc.destroy();
  doc.destroy();
});
test("foreign content edit refuses stale fingerprint; force does not bypass loss validation", async () => {
  const { doc, fragment } = document();
  stamp(fragment);
  const anchor = outline(fragment)[0]!.anchor!,
    hash = readBlock(fragment, anchor).fingerprint;
  (findBlock(fragment, anchor).node.get(0) as Y.XmlText).insert(0, "foreign ");
  const prepared = await prepareMarkdown(converter(replacement.response), replacement.markdown);
  expect(() =>
    doc.transact(() =>
      editDocument(fragment, { kind: "set", block: anchor, ifMatch: hash }, prepared),
    ),
  ).toThrow("content changed");
  expect(readBlock(fragment, anchor).markdown).toContain("foreign");
  prepared.losses.push("missing mention");
  expect(() =>
    doc.transact(() =>
      editDocument(fragment, { kind: "set", block: anchor, ifMatch: hash, force: true }, prepared),
    ),
  ).toThrow("--allow-loss");
  doc.transact(() =>
    editDocument(
      fragment,
      { kind: "set", block: anchor, ifMatch: hash, force: true, allowLoss: true },
      prepared,
    ),
  );
  expect(readBlock(fragment, anchor).markdown).toBe("First replacement");
  prepared.doc.destroy();
  doc.destroy();
});
test("unknown rich nodes remain visible and full replacement requires explicit loss consent", async () => {
  const { doc, fragment } = document();
  const custom = new Y.XmlElement("mention");
  custom.setAttribute("label", "person");
  fragment.insert(0, [custom]);
  const result = readFragment(fragment);
  expect(result.markdown).toContain("mention");
  expect(result.losses.join()).toContain("Unsupported node");
  const prepared = await prepareMarkdown(converter(heading.response), heading.markdown);
  expect(() => doc.transact(() => editDocument(fragment, { kind: "set" }, prepared))).toThrow(
    "--allow-loss",
  );
  expect(fragment.get(0)).toBe(custom);
  prepared.doc.destroy();
  doc.destroy();
});
