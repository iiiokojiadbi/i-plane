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
    /*
     * A newline inside a cell starts a new table row when the result is read
     * back, so block content is folded onto one line. Losing the paragraph break
     * is a smaller loss than losing the table.
     */
    const flat = content.trim().replace(/\s*\n+\s*/g, " ");
    return `${isFirst ? "| " : " "}${flat.replace(/\|/g, "\\|")} |`;
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
const tightenLists = (markdown: string): string => {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  /*
   * One frame per open list level: where the source indented it, and the column
   * its children get in the output. A child must clear its parent's marker —
   * three columns under "1. ", two under "- " — or the renderer reads it as a
   * new top-level list rather than a nested one.
   */
  const stack: Array<{ source: number; childIndent: number }> = [];

  for (const line of lines) {
    const border = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (border !== null) {
      const marker = border[1] ?? "";
      const info = (border[2] ?? "").trim();
      if (fence === undefined) {
        // An opening fence carries an info string; a closing one never does.
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length && info === "") {
        // A closing fence needs the same character and at least the same length:
        // a three-backtick line inside a four-backtick block closes nothing.
        fence = undefined;
      }
      out.push(line);
      continue;
    }
    if (fence !== undefined) {
      out.push(line);
      continue;
    }

    const match = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
    if (match === null) {
      /*
       * A continuation line inside a list item. Its indentation has to follow
       * the marker that was rewritten above, or four spaces of turndown padding
       * become eight and the paragraph renders as a code block.
       */
      const open = stack[stack.length - 1];
      const indented = /^(\s+)(\S.*)$/.exec(line);
      if (open !== undefined && indented !== null && (indented[1] ?? "").length > open.source) {
        out.push(`${" ".repeat(open.childIndent)}${indented[2] ?? ""}`);
        continue;
      }
      if (line.trim() === "") {
        out.push(line);
        continue;
      }
      // Anything else ends the list.
      if (indented === null) stack.length = 0;
      out.push(line);
      continue;
    }

    const source = (match[1] ?? "").length;
    const marker = match[2] ?? "-";

    // Close every level this line has dedented out of.
    while (stack.length > 0 && source < (stack[stack.length - 1]?.source ?? 0)) stack.pop();

    const enclosing = stack[stack.length - 1];
    const nested = enclosing !== undefined && source > enclosing.source;
    // A sibling replaces the frame it shares a level with.
    if (!nested && enclosing !== undefined) stack.pop();

    const parent = stack[stack.length - 1];
    const indent =
      nested && enclosing !== undefined ? enclosing.childIndent : (parent?.childIndent ?? 0);

    stack.push({ source, childIndent: indent + marker.length + 1 });
    out.push(`${" ".repeat(indent)}${marker} ${match[4]}`);
  }
  return out.join("\n");
};

/*
 * GFM tables need a header row. turndown-plugin-gfm leaves a table whose first
 * row is all <td> as raw HTML, and the renderer then escapes that markup on the
 * way back — a table turns into a paragraph showing its own tags. Promoting the
 * first row loses no data: a header is how Markdown spells "first row".
 */
const promoteHeaderlessTables = (html: string): string =>
  html.replace(/<table[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const firstRow = /<tr[^>]*>[\s\S]*?<\/tr>/i.exec(table);
    if (firstRow === null) return table;
    // What matters is whether the FIRST row has headers. A <th> further down
    // does not give GFM the header row it needs, and checking the whole table
    // let those cases through untouched.
    if (/<th[\s>]/i.test(firstRow[0])) return table;

    // A caption keeps turndown on its raw-HTML path even after promotion, so it
    // is lifted out and kept as a line of its own above the table.
    let caption = "";
    const withoutCaption = table.replace(
      /<caption[^>]*>([\s\S]*?)<\/caption>/i,
      (_, body: string) => {
        caption = body.replace(/<[^>]+>/g, "").trim();
        return "";
      },
    );

    const promoted = withoutCaption.replace(/<tr[^>]*>[\s\S]*?<\/tr>/i, (row) =>
      row.replace(/<td(\s[^>]*)?>/gi, "<th$1>").replace(/<\/td>/gi, "</th>"),
    );
    return caption === "" ? promoted : `<p>${caption}</p>${promoted}`;
  });

/** The HTML Plane returns, back to Markdown an agent can read in one glance. */
export const htmlToMarkdown = (html: string | null | undefined): string => {
  if (html == null || html.trim() === "") return "";
  return tightenLists(turndown.turndown(promoteHeaderlessTables(html))).trim();
};
