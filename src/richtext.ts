/*
 * Descriptions travel as HTML, which is the one format nobody wants to type or
 * read. Translation happens at the edges: Markdown in, HTML on the wire,
 * Markdown out.
 *
 * Both directions use libraries rather than hand-written regular expressions. A
 * previous version did it by hand and lost, in one review: code fences with a
 * language like c++ hung the process forever, nested lists were flattened,
 * literal HTML inside inline code vanished, and blank lines inside code blocks
 * were collapsed. Markdown has more edge cases than a small parser can hold.
 *
 * markdown-it rather than marked for one reason: with html:false it escapes raw
 * HTML instead of passing it through. Descriptions written here are stored on a
 * server and rendered in other people's browsers, so `<img src=x onerror=...>`
 * in a description must arrive as text, not as an element.
 */

import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const renderer = new MarkdownIt({
  // Raw HTML is escaped, never passed through: see the note above.
  html: false,
  // Bare URLs stay bare. Turning them into links silently rewrites what the
  // caller wrote, and a work item description is a record, not a web page.
  linkify: false,
  // Quotes and dashes stay as typed: descriptions carry shell commands and
  // paths where a curly quote is a broken command.
  typographer: false,
  breaks: false,
});

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
});
turndown.use(gfm);

/*
 * turndown-plugin-gfm writes cell content unescaped, so a literal pipe inside a
 * cell becomes a column separator on the next read: "x|y" survives one round
 * trip and splits into two cells on the second. Escaping it here keeps the cell
 * whole however many times a description is read and written back.
 */
turndown.addRule("escapedTableCellPipes", {
  filter: ["td", "th"],
  replacement: (content: string, node: unknown) => {
    const cell = node as { parentNode?: { childNodes?: ArrayLike<unknown> } };
    const siblings = cell.parentNode?.childNodes;
    // The row's leading pipe belongs to its first cell; without it the header
    // row loses its opening delimiter and stops being a table.
    const isFirst = siblings !== undefined && siblings[0] === node;
    return `${isFirst ? "| " : " "}${content.trim().replace(/\|/g, "\\|")} |`;
  },
});

/** Markdown to the HTML Plane stores. */
export const markdownToHtml = (markdown: string): string => renderer.render(markdown).trim();

/**
 * Bullets and numbers come back from turndown padded to a fixed width
 * ("-   item", four-space nesting). Valid Markdown, but this output is read by
 * an agent paying per token, so it is squeezed to one space and two-space
 * nesting. Content is untouched — only the space between marker and text.
 */
const tightenLists = (markdown: string): string =>
  markdown
    .split("\n")
    .map((line) => {
      const match = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
      if (match === null) return line;
      const depth = Math.floor((match[1] ?? "").length / 4);
      return `${"  ".repeat(depth)}${match[2]} ${match[4]}`;
    })
    .join("\n");

/** The HTML Plane returns, back to Markdown an agent can read in one glance. */
export const htmlToMarkdown = (html: string | null | undefined): string => {
  if (html == null || html.trim() === "") return "";
  return tightenLists(turndown.turndown(html)).trim();
};
