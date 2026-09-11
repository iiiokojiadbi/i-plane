import { createDocument, type HtmlNode } from "@mixmark-io/domino";
import { scrubHtml } from "./html-secrets.ts";
import { scrub } from "./output.ts";
import { reviewCodeHtml, validReviewDate } from "./page-review.ts";
import { htmlToMarkdown } from "./richtext.ts";

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const supported = new Set(
  "div span p h1 h2 h3 h4 h5 h6 strong b em i s strike del a code pre br hr blockquote ul ol li input table thead tbody tfoot tr th td caption img".split(
    " ",
  ),
);

/** Page-only saved HTML reader: semantic nodes must not pass through generic Markdown conversion. */
export const pageHtmlToMarkdown = (
  html: string,
  document?: unknown,
): { markdown: string; losses: string[] } => {
  const safe = scrubHtml(html);
  const root = createDocument().createElement("div");
  root.innerHTML = safe;
  const losses = new Set<string>();
  if (safe !== html)
    losses.add("Sensitive page content was redacted; the printed page is not a lossless copy");
  interface SavedReview {
    date: unknown;
    source: unknown;
    anchor?: string;
    extra: boolean;
    used: boolean;
    order: number;
  }
  const reviews: SavedReview[] = [];
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const documentKindKey = "type";
  const canonical = record(document)?.[documentKindKey] === "doc";
  if (canonical) {
    const pending: unknown[] = [document];
    const visited = new Set<unknown>();
    while (pending.length) {
      const value = pending.pop(),
        node = record(value);
      if (!node || visited.has(value)) continue;
      visited.add(value);
      if (node[documentKindKey] === "knowledgeReview") {
        const attrs = record(node.attrs) ?? {};
        reviews.push({
          date: attrs.reviewedAt,
          source: attrs.source,
          ...(typeof attrs.id === "string" && attrs.id ? { anchor: attrs.id } : {}),
          extra:
            Object.keys(attrs).some((name) => !["id", "reviewedAt", "source"].includes(name)) ||
            (Array.isArray(node.content) && node.content.length > 0) ||
            (node.marks != null && (!Array.isArray(node.marks) || node.marks.length > 0)),
          used: false,
          order: reviews.length,
        });
      } else if (Array.isArray(node.content)) pending.push(...[...node.content].reverse());
    }
  }
  const byAnchor = new Map<string, SavedReview>();
  const duplicateAnchors = new Set<string>();
  for (const review of reviews)
    if (review.anchor) {
      if (byAnchor.has(review.anchor)) duplicateAnchors.add(review.anchor);
      byAnchor.set(review.anchor, review);
    }
  for (const anchor of duplicateAnchors) byAnchor.delete(anchor);
  if (duplicateAnchors.size) losses.add("Duplicate saved review anchors cannot be matched safely");
  const literal = (node: HtmlNode): string =>
    `<pre><code class="language-xml">${escapeHtml(node.outerHTML ?? node.nodeValue ?? "")}</code></pre>`;
  const renderedReviewOrder: number[] = [];
  const restrictedContexts = new Set(
    "a strong b em i s strike del code pre h1 h2 h3 h4 h5 h6".split(" "),
  );
  const render = (node: HtmlNode, inTableCell = false, reviewContext?: string): string => {
    if (node.nodeType === 3) return escapeHtml(node.nodeValue ?? "");
    if (node.nodeType !== 1) {
      losses.add("Non-element page content is not represented in Markdown");
      return literal(node);
    }
    const tag = node.tagName?.toLowerCase() ?? "unknown";
    const attrs = Object.fromEntries(
      Array.from(node.attributes ?? []).map((attribute) => [attribute.name, attribute.value]),
    );
    const saved = attrs.id ? byAnchor.get(attrs.id) : undefined;
    if (tag === "div" && ("data-knowledge-review" in attrs || saved)) {
      if (reviewContext)
        losses.add(
          `Review blocks inside ${reviewContext} cannot be represented semantically in Markdown`,
        );
      if (inTableCell)
        losses.add(
          "Review blocks inside table cells cannot be represented semantically in Markdown",
        );
      const match =
        saved ??
        reviews.find(
          (review) =>
            !review.used &&
            review.date === attrs["data-reviewed-at"] &&
            review.source === attrs["data-source"],
        );
      if (canonical && !match) {
        losses.add(
          "Saved HTML contains review markup absent from the canonical document; preserved as HTML text",
        );
        return literal(node);
      }
      if (match?.used) {
        losses.add("A saved review anchor occurs more than once in HTML; preserved as HTML text");
        return literal(node);
      }
      const date = match ? match.date : (attrs["data-reviewed-at"] ?? ""),
        source = match ? match.source : (attrs["data-source"] ?? "");
      if (
        typeof date !== "string" ||
        typeof source !== "string" ||
        !validReviewDate(date) ||
        !source.trim()
      ) {
        losses.add("Review metadata is invalid; preserved as HTML text");
        return literal(node);
      }
      if (match) {
        match.used = true;
        renderedReviewOrder.push(match.order);
      }
      if (
        match?.extra ||
        Object.keys(attrs).some(
          (name) =>
            !["id", "data-knowledge-review", "data-reviewed-at", "data-source"].includes(name),
        ) ||
        node.textContent !== `Reviewed ${date}: ${source}` ||
        Array.from(node.childNodes).some((child) => child.nodeType !== 3)
      )
        losses.add("Additional review attributes or content are not represented in Markdown");
      const safeDate = scrub(date),
        safeSource = scrub(source);
      if (safeDate !== date || safeSource !== source)
        losses.add(
          "Sensitive review metadata was redacted; the printed page is not a lossless copy",
        );
      return reviewCodeHtml({ date: safeDate, source: safeSource });
    }
    if (tag === "table") {
      const rows = Array.from(node.childNodes).flatMap((child) => {
        if (child.tagName?.toLowerCase() === "tr") return [child];
        return ["thead", "tbody", "tfoot"].includes(child.tagName?.toLowerCase() ?? "")
          ? Array.from(child.childNodes).filter((row) => row.tagName?.toLowerCase() === "tr")
          : [];
      });
      if (
        !rows.length ||
        rows.some(
          (row) =>
            !Array.from(row.childNodes).some((cell) =>
              ["td", "th"].includes(cell.tagName?.toLowerCase() ?? ""),
            ),
        )
      ) {
        losses.add(
          "A table without cells cannot be represented in Markdown; preserved as HTML text",
        );
        return literal(node);
      }
    }
    if (!supported.has(tag)) {
      losses.add(`Unsupported page HTML element ${tag}; preserved as HTML text`);
      return literal(node);
    }
    for (const name of Object.keys(attrs)) {
      const known =
        name === "id" ||
        (name === "class" && (tag !== "code" || /^language-[^\s]+$/.test(attrs[name] ?? ""))) ||
        (tag === "a" && ["href", "title", "target", "rel"].includes(name)) ||
        (tag === "img" && ["src", "alt", "title"].includes(name)) ||
        (tag === "ol" && name === "start") ||
        (tag === "input" && ["type", "checked", "disabled"].includes(name));
      if (!known)
        losses.add(`Page HTML attribute ${name} on ${tag} is not fully represented in Markdown`);
    }
    if (tag === "code" && attrs.class === "language-knowledge-review")
      losses.add("The knowledge-review fence language is reserved for review metadata");
    if (
      tag === "input" &&
      Object.entries(attrs).some(([name, value]) => name === "type" && value !== "checkbox")
    )
      losses.add("Only checkbox inputs are representable in Markdown");
    if (tag === "td" || tag === "th") {
      const blockTags = new Set("p div pre blockquote ul ol table h1 h2 h3 h4 h5 h6".split(" "));
      const blocks = Array.from(node.childNodes).filter((child) =>
        blockTags.has(child.tagName?.toLowerCase() ?? ""),
      );
      const hasBreak = (child: HtmlNode): boolean =>
        child.tagName?.toLowerCase() === "br" || Array.from(child.childNodes).some(hasBreak);
      if (
        blocks.length > 1 ||
        blocks.some((child) => child.tagName?.toLowerCase() !== "p") ||
        hasBreak(node)
      )
        losses.add(
          "Multiple paragraphs, line breaks or block structure inside table cells are flattened in Markdown",
        );
    }
    const attributes = Object.entries(attrs)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join("");
    return `<${tag}${attributes}>${Array.from(node.childNodes)
      .map((child) =>
        render(
          child,
          inTableCell || tag === "td" || tag === "th",
          restrictedContexts.has(tag) ? tag : reviewContext,
        ),
      )
      .join("")}${["br", "hr", "img", "input"].includes(tag) ? "" : `</${tag}>`}`;
  };
  const rendered = Array.from(root.childNodes)
    .map((child) => render(child))
    .join("");
  if (
    renderedReviewOrder.some(
      (value, index) => index > 0 && value < (renderedReviewOrder[index - 1] ?? 0),
    )
  )
    losses.add(
      "Saved HTML review order differs from the canonical document; equal-date source selection would change on replacement",
    );
  if (reviews.some((review) => !review.used))
    losses.add(
      "Saved HTML omits canonical review metadata that could not be matched by block ID; read the live review blocks before editing",
    );
  try {
    return { markdown: htmlToMarkdown(rendered), losses: [...losses] };
  } catch {
    losses.add("Saved HTML could not be converted to Markdown; preserved as HTML text");
    let fenceLength = 3;
    for (const match of safe.matchAll(/`+/g))
      fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    return { markdown: `${fence}html\n${safe}\n${fence}`, losses: [...losses] };
  }
};
