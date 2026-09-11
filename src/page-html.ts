import { createDocument, type HtmlNode } from "@mixmark-io/domino";
import { scrubHtml } from "./html-secrets.ts";
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
export const pageHtmlToMarkdown = (html: string): { markdown: string; losses: string[] } => {
  const safe = scrubHtml(html);
  const root = createDocument().createElement("div");
  root.innerHTML = safe;
  const losses = new Set<string>();
  if (safe !== html)
    losses.add("Sensitive page content was redacted; the printed page is not a lossless copy");
  const literal = (node: HtmlNode): string =>
    `<pre><code class="language-xml">${escapeHtml(node.outerHTML ?? node.nodeValue ?? "")}</code></pre>`;
  const render = (node: HtmlNode): string => {
    if (node.nodeType === 3) return escapeHtml(node.nodeValue ?? "");
    if (node.nodeType !== 1) {
      losses.add("Non-element page content is not represented in Markdown");
      return literal(node);
    }
    const tag = node.tagName?.toLowerCase() ?? "unknown";
    const attrs = Object.fromEntries(
      Array.from(node.attributes ?? []).map((attribute) => [attribute.name, attribute.value]),
    );
    if (tag === "div" && "data-knowledge-review" in attrs) {
      const date = attrs["data-reviewed-at"] ?? "",
        source = attrs["data-source"] ?? "";
      if (!validReviewDate(date) || !source.trim()) {
        losses.add("Review metadata is invalid; preserved as HTML text");
        return literal(node);
      }
      if (
        Object.keys(attrs).some(
          (name) =>
            !["id", "data-knowledge-review", "data-reviewed-at", "data-source"].includes(name),
        ) ||
        node.textContent !== `Reviewed ${date}: ${source}` ||
        Array.from(node.childNodes).some((child) => child.nodeType !== 3)
      )
        losses.add("Additional review attributes or content are not represented in Markdown");
      return reviewCodeHtml({ date, source });
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
      const children = Array.from(node.childNodes).filter((child) => child.nodeType === 1);
      if (children.length > 1 || children.some((child) => child.tagName?.toLowerCase() === "br"))
        losses.add("Multiple paragraphs or line breaks in table cells are flattened in Markdown");
    }
    const attributes = Object.entries(attrs)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join("");
    return `<${tag}${attributes}>${Array.from(node.childNodes).map(render).join("")}${["br", "hr", "img", "input"].includes(tag) ? "" : `</${tag}>`}`;
  };
  return {
    markdown: htmlToMarkdown(Array.from(root.childNodes).map(render).join("")),
    losses: [...losses],
  };
};
