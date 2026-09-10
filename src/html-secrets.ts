import { createDocument, type HtmlNode } from "@mixmark-io/domino";
import { scrub, secretRanges } from "./output.ts";

/** Decode entities and redact text spanning formatting tags before rendering. */
export const scrubHtml = (html: string): string => {
  const container = createDocument().createElement("div");
  container.innerHTML = html;
  const texts: Array<{ node: HtmlNode; value: string; start: number }> = [];
  let combined = "",
    changed = false;
  const visit = (node: HtmlNode): void => {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      texts.push({ node, value, start: combined.length });
      combined += value;
    } else if (node.nodeType === 8) {
      const value = node.nodeValue ?? "",
        safe = scrub(value);
      if (safe !== value) {
        node.nodeValue = safe;
        changed = true;
      }
    }
    for (const attr of Array.from(node.attributes ?? [])) {
      const safe = scrub(attr.value);
      if (safe !== attr.value) {
        node.setAttribute?.(attr.name, safe);
        changed = true;
      }
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(container);
  const ranges = secretRanges(combined);
  for (const { node, value, start } of texts) {
    let cursor = 0,
      result = "";
    for (const range of ranges) {
      if (range.end <= start || range.start >= start + value.length) continue;
      result += value.slice(cursor, Math.max(0, range.start - start));
      if (range.start >= start) result += "[token]";
      cursor = Math.min(value.length, range.end - start);
    }
    result += value.slice(cursor);
    if (result !== value) {
      node.nodeValue = result;
      changed = true;
    }
  }
  return scrub(changed ? container.innerHTML : html);
};
