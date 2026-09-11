import { createHash, randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import * as Y from "yjs";
import { UsageError } from "./args.ts";
import { PlaneError } from "./client.ts";
import { scrubHtml } from "./html-secrets.ts";
import { scrub } from "./output.ts";
import { parseReview, reviewCodeHtml, reviewHtml, validReviewDate } from "./page-review.ts";
import type { PageClient } from "./page-transport.ts";
import { htmlToMarkdown } from "./richtext.ts";

interface TextPart {
  insert: unknown;
  attributes?: Record<string, unknown>;
}
export type Block = Y.XmlElement | Y.XmlText;
export interface OutlineRow {
  index: number;
  anchor: string | null;
  shortAnchor: string | null;
  kind: string;
  preview: string;
}
export interface BlockRead {
  anchor: string;
  fingerprint: string;
  markdown: string;
  losses: ReadonlyArray<string>;
}
const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const attr = (name: string, value: unknown): string =>
  value == null || value === "" ? "" : ` ${name}="${escapeHtml(value)}"`;
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  return value;
};
// Known structural ids are editor anchors, including nested list paragraphs.
// Unknown nodes can carry semantic ids (for example, a mentioned person).
const anchoredKinds = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletlist",
  "orderedlist",
  "listitem",
  "tasklist",
  "taskitem",
  "blockquote",
  "codeblock",
  "horizontalrule",
  "hardbreak",
  "table",
  "tablerow",
  "tableheader",
  "tablecell",
  "imagecomponent",
  "image",
]);
const content = (node: Block, topLevel = true): unknown =>
  node instanceof Y.XmlText
    ? { text: canonical(node.toDelta()) }
    : {
        kind: node.nodeName,
        attributes: canonical(
          Object.fromEntries(
            Object.entries(node.getAttributes()).filter(
              ([name]) =>
                name !== "id" || !(topLevel || anchoredKinds.has(node.nodeName.toLowerCase())),
            ),
          ),
        ),
        children: node.toArray().map((child) => content(child as Block, false)),
      };
export const fingerprint = (node: Block): string =>
  createHash("sha256")
    .update(JSON.stringify(content(node)))
    .digest("hex");
const plainText = (node: Block): string =>
  node instanceof Y.XmlElement && node.nodeName === "knowledgeReview"
    ? `Reviewed ${String(node.getAttribute("reviewedAt") ?? "")}: ${String(node.getAttribute("source") ?? "")}`
    : node instanceof Y.XmlText
      ? node
          .toDelta()
          .map((part: TextPart) =>
            typeof part.insert === "string" ? part.insert : JSON.stringify(part.insert),
          )
          .join("")
      : node
          .toArray()
          .map((child) => plainText(child as Block))
          .join(" ");
export const outline = (fragment: Y.XmlFragment): ReadonlyArray<OutlineRow> =>
  fragment.toArray().map((node, index) => {
    const anchor =
      node instanceof Y.XmlElement ? String(node.getAttribute("id") ?? "") || null : null;
    return {
      index,
      anchor,
      shortAnchor: anchor ? scrub(anchor).slice(0, 8) : null,
      kind: node instanceof Y.XmlElement ? node.nodeName : "text",
      preview: scrub(plainText(node as Block))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40),
    };
  });
export const findBlock = (
  fragment: Y.XmlFragment,
  ref: string,
): { node: Y.XmlElement; index: number; anchor: string } => {
  const matches = fragment.toArray().flatMap((node, index) => {
    if (!(node instanceof Y.XmlElement)) return [];
    const anchor = String(node.getAttribute("id") ?? "");
    return anchor.length > 0 && anchor.toLowerCase().startsWith(ref.toLowerCase())
      ? [{ node, index, anchor }]
      : [];
  });
  if (matches.length === 0)
    throw new PlaneError(
      `No top-level block matches "${ref}". Run page outline to see current anchors.`,
      404,
    );
  if (matches.length !== 1)
    throw new UsageError(
      `Ambiguous block anchor "${ref}": ${matches.map((row) => `${row.anchor} [${row.index}]`).join(", ")}`,
    );
  const match = matches[0];
  if (!match) throw new PlaneError("Block disappeared.");
  return match;
};
export const stamp = (fragment: Y.XmlFragment): number => {
  let count = 0;
  for (const node of fragment.toArray())
    if (node instanceof Y.XmlElement && !node.getAttribute("id")) {
      node.setAttribute("id", randomUUID());
      count++;
    }
  return count;
};

const render = (node: Block, losses: Set<string>, redactOutput = false): string => {
  if (node instanceof Y.XmlText) {
    const text = plainText(node);
    const safe = redactOutput ? scrub(text) : text;
    if (safe !== text) {
      losses.add("Sensitive text was redacted; the printed block is not a lossless copy");
      return escapeHtml(safe);
    }
    return node
      .toDelta()
      .map((part: TextPart) => {
        let text = escapeHtml(
          typeof part.insert === "string" ? part.insert : JSON.stringify(part.insert),
        );
        for (const [mark, value] of Object.entries(part.attributes ?? {})) {
          const rawAttrs =
            value && typeof value === "object" ? (value as Record<string, unknown>) : {};
          const attrs = Object.fromEntries(
            Object.entries(rawAttrs).map(([key, value]) => [
              key,
              redactOutput && typeof value === "string" ? scrub(value) : value,
            ]),
          );
          if (mark === "bold") text = `<strong>${text}</strong>`;
          else if (mark === "italic") text = `<em>${text}</em>`;
          else if (mark === "strike") text = `<s>${text}</s>`;
          else if (mark === "code") text = `<code>${text}</code>`;
          else if (mark === "link")
            text = `<a${attr("href", attrs.href)}${attr("title", attrs.title)}>${text}</a>`;
          else {
            losses.add(`Mark ${mark} is not representable by this Markdown reader`);
            if (mark === "underline") text = `&lt;u&gt;${text}&lt;/u&gt;`;
          }
        }
        return text;
      })
      .join("");
  }
  const kind = node.nodeName.toLowerCase(),
    attrs = Object.fromEntries(
      Object.entries(node.getAttributes()).map(([key, value]) => [
        key,
        redactOutput && typeof value === "string" ? scrub(value) : value,
      ]),
    ) as Record<string, unknown>;
  const children = () =>
    node
      .toArray()
      .map((child) => render(child as Block, losses, redactOutput))
      .join("");
  if (attrs.textAlign && attrs.textAlign !== "left")
    losses.add("Text alignment is not representable in Markdown");
  if (kind === "knowledgereview") {
    const date = String(attrs.reviewedAt ?? ""),
      source = String(attrs.source ?? "");
    if (
      typeof attrs.reviewedAt !== "string" ||
      typeof attrs.source !== "string" ||
      !validReviewDate(date) ||
      !source.trim()
    )
      losses.add("Review metadata is invalid");
    if (
      Object.keys(attrs).some((key) => !["id", "reviewedAt", "source"].includes(key)) ||
      node.length
    )
      losses.add("Additional review attributes or content are not represented in Markdown");
    if (
      redactOutput &&
      (attrs.reviewedAt !== node.getAttribute("reviewedAt") ||
        attrs.source !== node.getAttribute("source"))
    )
      losses.add(
        "Sensitive review metadata was redacted; the printed block is not a lossless copy",
      );
    return reviewCodeHtml({ date, source });
  }
  if (kind === "doc") return children();
  if (kind === "paragraph") return `<p>${children()}</p>`;
  if (kind === "heading") {
    const level = Math.min(6, Math.max(1, Number(attrs.level) || 1));
    return `<h${level}>${children()}</h${level}>`;
  }
  if (kind === "bulletlist") return `<ul>${children()}</ul>`;
  if (kind === "orderedlist") return `<ol${attr("start", attrs.start)}>${children()}</ol>`;
  if (kind === "listitem") return `<li>${children()}</li>`;
  if (kind === "tasklist") return `<ul>${children()}</ul>`;
  if (kind === "taskitem") {
    const checkbox = `<input type="checkbox"${attrs.checked === true || attrs.checked === "true" ? " checked" : ""}>`;
    const body = children().replace(/^<p>([\s\S]*?)<\/p>/, "$1");
    return `<li>${checkbox}${body}</li>`;
  }
  if (kind === "blockquote") return `<blockquote>${children()}</blockquote>`;
  if (kind === "codeblock" && attrs.language === "knowledge-review")
    losses.add("The knowledge-review fence language is reserved for review metadata");
  if (kind === "codeblock")
    return `<pre><code${attrs.language ? attr("class", `language-${attrs.language}`) : ""}>${escapeHtml(redactOutput ? scrub(plainText(node)) : plainText(node))}</code></pre>`;
  if (kind === "horizontalrule") return "<hr>";
  if (kind === "hardbreak") return "<br>";
  if (kind === "table") return `<table>${children()}</table>`;
  if (kind === "tablerow") return `<tr>${children()}</tr>`;
  if (kind === "tablecell" || kind === "tableheader") {
    const blocks = node.toArray().filter((child) => child instanceof Y.XmlElement);
    const hasBreak = (child: Y.XmlElement): boolean =>
      child.nodeName.toLowerCase() === "hardbreak" ||
      child.toArray().some((inner) => inner instanceof Y.XmlElement && hasBreak(inner));
    if (
      blocks.length > 1 ||
      blocks.some((child) => child.nodeName.toLowerCase() !== "paragraph" || hasBreak(child))
    )
      losses.add(
        "Multiple paragraphs, line breaks or block structure inside table cells are flattened in Markdown",
      );
    if (Number(attrs.colspan ?? 1) !== 1 || Number(attrs.rowspan ?? 1) !== 1)
      losses.add("Merged table cells are not representable in Markdown");
    if (attrs.background || attrs.colwidth)
      losses.add("Table styling is not representable in Markdown");
    const tag = kind === "tablecell" ? "td" : "th";
    return `<${tag}>${children()}</${tag}>`;
  }
  if (kind === "imagecomponent" || kind === "image") {
    if (attrs.width || attrs.height || attrs.alignment)
      losses.add("Image dimensions or alignment are not representable in Markdown");
    return `<img${attr("src", attrs.src)}${attr("alt", attrs.alt)}${attr("title", attrs.title)}>`;
  }
  losses.add(`Unsupported node ${node.nodeName}; preserved as XML text`);
  const xml = node.toString();
  return `<pre><code class="language-xml">${escapeHtml(redactOutput ? scrubHtml(xml) : xml)}</code></pre>`;
};
export const readFragment = (fragment: Y.XmlFragment): { markdown: string; losses: string[] } => {
  const losses = new Set<string>();
  const html = fragment
    .toArray()
    .map((node) => render(node as Block, losses))
    .join("");
  return { markdown: htmlToMarkdown(html), losses: [...losses] };
};
export const readBlock = (fragment: Y.XmlFragment, ref: string): BlockRead => {
  const { node, anchor } = findBlock(fragment, ref);
  const losses = new Set<string>();
  return {
    anchor,
    fingerprint: fingerprint(node),
    markdown: htmlToMarkdown(render(node, losses, true)),
    losses: [...losses],
  };
};
export const lossesFor = (nodes: ReadonlyArray<Block>): string[] => {
  const losses = new Set<string>();
  for (const node of nodes) render(node, losses);
  return [...losses];
};
const parser = new MarkdownIt({ html: false }).use(taskLists);
const renderFence = parser.renderer.rules.fence;
parser.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  if (/^knowledge-review\s/.test(token?.info.trim() ?? ""))
    throw new UsageError("A knowledge-review fence does not accept additional info fields.");
  if (token?.info.trim() === "knowledge-review") {
    const review = parseReview(token.content);
    return environment?.reviewAsCode ? reviewCodeHtml(review) : reviewHtml(review);
  }
  return (
    renderFence?.(tokens, index, options, environment, renderer) ??
    renderer.renderToken(tokens, index, options)
  );
};
// The plugin requires a space after the marker, while Markdown parsing trims
// that space from an empty item. Keep empty editor checkboxes as checkboxes.
parser.core.ruler.before("github-task-lists", "empty-task-items", (state) => {
  for (let index = 2; index < state.tokens.length; index++) {
    const token = state.tokens[index],
      text = token?.children?.[0];
    if (
      token &&
      text &&
      /^\[[ xX]\]$/.test(token.content) &&
      state.tokens[index - 1]?.tag === "p" &&
      state.tokens[index - 2]?.tag === "li"
    ) {
      token.content += " ";
      text.content += " ";
    }
  }
});
const codeNodes = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] =>
  node
    .toArray()
    .flatMap((child) =>
      child instanceof Y.XmlElement
        ? [...(child.nodeName.toLowerCase() === "codeblock" ? [child] : []), ...codeNodes(child)]
        : [],
    );
const renderMarkdown = (markdown: string, reviewAsCode = false): string =>
  parser
    .render(markdown, { reviewAsCode })
    .trim()
    .replace(/(<li class="task-list-item">)\s*<p>([\s\S]*?)<\/p>/g, "$1$2")
    .replace(/(<input class="task-list-item-checkbox"[^>]*>) /g, "$1");

export interface PreparedDocument {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  losses: string[];
}
export const prepareMarkdown = async (
  client: PageClient,
  markdown: string,
): Promise<PreparedDocument> => {
  const html = renderMarkdown(markdown);
  if (!html) {
    const doc = new Y.Doc();
    return { doc, fragment: doc.getXmlFragment("default"), losses: [] };
  }
  // The server recognizes its image component; the input is renderer-generated,
  // escaped HTML, never arbitrary raw HTML supplied by the caller.
  const convertedHtml = html
    .replace(/<img([^>]*?)\s*\/?>/g, "<image-component$1></image-component>")
    .replace(/<ul class="contains-task-list">/g, '<ul data-type="taskList">')
    .replace(
      /<li class="task-list-item">(\s*<p>)?<input\b([^>]*)>/g,
      (_match, paragraph: string | undefined, attributes: string) =>
        `<li data-type="taskItem" data-checked="${/\bchecked=/.test(attributes)}">${paragraph ?? ""}`,
    );
  const data = await client.request<{ description_binary?: unknown }>("/live/convert-document", {
    method: "POST",
    body: { description_html: convertedHtml, variant: "rich" },
  });
  const doc = new Y.Doc();
  try {
    if (typeof data.description_binary !== "string" || !data.description_binary)
      throw new Error("Missing document binary");
    Y.applyUpdate(doc, Buffer.from(data.description_binary, "base64"));
    const fragment = doc.getXmlFragment("default");
    const languages = parser
      .parse(markdown, {})
      .filter(
        (token) => token.block && token.tag === "code" && token.info.trim() !== "knowledge-review",
      )
      .map((token) => token.info.trim().split(/\s+/)[0] || null);
    const blocks = codeNodes(fragment);
    const losses: string[] = [];
    if (languages.length !== blocks.length)
      losses.push("The converter changed the number of code blocks");
    else
      doc.transact(() =>
        blocks.forEach((block, index) => {
          const language = languages[index];
          if (language) block.setAttribute("language", language);
          else block.removeAttribute("language");
        }),
      );
    const rendered = readFragment(fragment);
    if (rendered.markdown !== htmlToMarkdown(renderMarkdown(markdown, true)))
      losses.push("The converter changed Markdown content or formatting");
    doc.transact(() => stamp(fragment));
    return { doc, fragment, losses };
  } catch (error) {
    doc.destroy();
    if (error instanceof PlaneError) throw error;
    throw new PlaneError(
      `Cannot decode the converted document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
