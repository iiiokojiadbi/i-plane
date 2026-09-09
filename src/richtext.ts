/*
 * Descriptions travel as HTML, which is the one format nobody wants to type or
 * read. Plane stores whatever markup it is given — code blocks, tables, lists,
 * quotes all survive — so the job here is translation at the edges: Markdown in,
 * Markdown out, HTML only on the wire.
 *
 * Deliberately a small subset, not a parser. It covers what descriptions
 * actually contain, and anything it does not recognise degrades to plain text
 * rather than to an error.
 */

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inlineToHtml = (text: string): string => {
  const parts: string[] = [];
  // Inline code first: its content must not be touched by the other rules.
  const segments = text.split(/(`[^`]+`)/);
  for (const segment of segments) {
    if (segment.startsWith("`") && segment.endsWith("`") && segment.length > 1) {
      parts.push(`<code>${escapeHtml(segment.slice(1, -1))}</code>`);
      continue;
    }
    parts.push(
      escapeHtml(segment)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'),
    );
  }
  return parts.join("");
};

const tableRowCells = (line: string): ReadonlyArray<string> =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isDivider = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);

/** Markdown subset to the HTML Plane stores. */
export const markdownToHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    // Fenced code: kept verbatim, language recorded the way editors expect it.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence !== null) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      const attribute = language === "" ? "" : ` class="language-${language}"`;
      out.push(`<pre><code${attribute}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${inlineToHtml(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }

    // Table: a header row, a divider, then body rows.
    if (line.includes("|") && isDivider(lines[index + 1] ?? "")) {
      const header = tableRowCells(line);
      index += 2;
      const rows: Array<ReadonlyArray<string>> = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(tableRowCells(lines[index] ?? ""));
        index += 1;
      }
      const head = header.map((cell) => `<th>${inlineToHtml(cell)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inlineToHtml(cell)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><tbody><tr>${head}</tr>${body}</tbody></table>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*[-*+]\s+(.*)$/.exec(lines[index] ?? "");
        if (item === null) break;
        items.push(`<li>${inlineToHtml(item[1] ?? "")}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index] ?? "");
        if (item === null) break;
        items.push(`<li>${inlineToHtml(item[1] ?? "")}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const body: string[] = [];
      while (index < lines.length) {
        const item = /^\s*>\s?(.*)$/.exec(lines[index] ?? "");
        if (item === null) break;
        body.push(item[1] ?? "");
        index += 1;
      }
      out.push(`<blockquote><p>${inlineToHtml(body.join(" "))}</p></blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // Plain paragraph: consecutive non-empty lines join into one.
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "") {
      const next = lines[index] ?? "";
      if (/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>)/.test(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    if (paragraph.length > 0) out.push(`<p>${inlineToHtml(paragraph.join(" "))}</p>`);
  }

  return out.join("");
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, "")).trim();

const inlineToMarkdown = (html: string): string =>
  decodeEntities(
    html
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/g, (_, body: string) => `\`${stripTags(body)}\``)
      .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/g, "**$2**")
      .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/g, "*$2*")
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();

/** The HTML Plane returns, back to Markdown an agent can read in one glance. */
export const htmlToMarkdown = (html: string | null | undefined): string => {
  if (html == null || html.trim() === "") return "";
  let text = html;
  const blocks: string[] = [];

  // Code blocks are pulled out first and restored last: nothing else may touch them.
  text = text.replace(
    /<pre[^>]*>\s*<code(?:\s+class="language-(\w+)")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g,
    (_, language: string | undefined, body: string) => {
      blocks.push(`\`\`\`${language ?? ""}\n${decodeEntities(body).replace(/\n$/, "")}\n\`\`\``);
      return `\u0000${blocks.length - 1}\u0000`;
    },
  );

  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, body: string) => {
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) =>
      [...(match[1] ?? "").matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/g)].map((cell) =>
        inlineToMarkdown(cell[1] ?? ""),
      ),
    );
    if (rows.length === 0) return "";
    const header = rows[0] ?? [];
    const lines = [
      `| ${header.join(" | ")} |`,
      `|${header.map(() => " --- ").join("|")}|`,
      ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ];
    blocks.push(lines.join("\n"));
    return `\u0000${blocks.length - 1}\u0000`;
  });

  // Ordered lists are numbered back, not turned into bullets: "step 2" in a
  // reproduction is not the same statement as "one of these three things".
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/g, (_, body: string) => {
    let counter = 0;
    const items = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (__, item: string) => {
      counter += 1;
      return `\n${counter}. ${inlineToMarkdown(item)}`;
    });
    blocks.push(items.replace(/<[^>]+>/g, "").trim());
    return `\u0000${blocks.length - 1}\u0000`;
  });

  text = text
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, level: string, body: string) => {
      return `\n${"#".repeat(Number(level))} ${inlineToMarkdown(body)}\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_, body: string) => `\n- ${inlineToMarkdown(body)}`)
    .replace(/<\/?(ul|ol)[^>]*>/g, "\n")
    .replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g,
      (_, body: string) => `\n> ${inlineToMarkdown(body)}\n`,
    )
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_, body: string) => `\n${inlineToMarkdown(body)}\n`)
    .replace(/<\/?div[^>]*>/g, "\n");

  text = inlineToMarkdown(text);
  text = text.replace(
    /\u0000(\d+)\u0000/g,
    (_, index: string) => `\n${blocks[Number(index)] ?? ""}\n`,
  );

  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
