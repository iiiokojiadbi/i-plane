/*
 * Description conversion.
 *
 * The first version of this file asserted only that a round trip was stable and
 * non-empty. A reviewer replaced the converter with a function returning the
 * constant "lost" and every case still passed. So these assert the text itself:
 * exact output where the format is fixed, and named content where it is not.
 *
 * Every case is a bug that shipped once.
 */

import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, markdownToHtml } from "../src/richtext.ts";

const round = (markdown: string): string => htmlToMarkdown(markdownToHtml(markdown));

describe("markdown survives a round trip exactly", () => {
  // Where the format is canonical, the output is compared whole: a converter
  // that drops or rewrites content cannot pass these.
  const exact: ReadonlyArray<[string, string, string]> = [
    ["paragraph", "Plain sentence.", "Plain sentence."],
    ["heading", "# Title", "# Title"],
    ["bold and italic", "**bold** and *italic*", "**bold** and *italic*"],
    ["inline code", "Use `dig +short` first.", "Use `dig +short` first."],
    ["inline code holding markup", "Before `<div>` after.", "Before `<div>` after."],
    ["link", "See [docs](https://example.test).", "See [docs](https://example.test)."],
    ["fence with a language", "```bash\necho hi\n```", "```bash\necho hi\n```"],
    ["fence with a non-word language", "```c++\nint x;\n```", "```c++\nint x;\n```"],
    ["bullet list", "- one\n- two", "- one\n- two"],
    ["nested bullets", "- parent\n  - child\n- sibling", "- parent\n  - child\n- sibling"],
    ["ordered list", "1. one\n2. two", "1. one\n2. two"],
    ["bullet under a number", "1. parent\n   - child\n2. sibling", "1. parent\n   - child\n2. sibling"],
    ["three levels", "- a\n  - b\n    - c", "- a\n  - b\n    - c"],
    ["table", "| A | B |\n| --- | --- |\n| x | y |", "| A | B |\n| --- | --- |\n| x | y |"],
    [
      "pipe inside a cell",
      "| A | B |\n| --- | --- |\n| x\\|y | z |",
      "| A | B |\n| --- | --- |\n| x\\|y | z |",
    ],
    ["quote", "> quoted line", "> quoted line"],
  ];

  for (const [name, source, expected] of exact) {
    test(name, () => {
      expect(round(source)).toBe(expected);
    });
  }

  test("a second round trip changes nothing", () => {
    for (const [, source] of exact) {
      const once = round(source);
      expect(round(once)).toBe(once);
    }
  });
});

describe("code is never rewritten", () => {
  test("blank lines and trailing spaces inside a fence survive", () => {
    const source = "```txt\na  \n\n\nb\n```";
    expect(round(source)).toBe(source);
  });

  test("list-shaped lines inside a fence keep their own spacing", () => {
    // tightenLists once reached inside fences and reformatted stored code.
    const source = "```txt\n-   keep\n    -   nested\n```";
    expect(round(source)).toBe(source);
  });

  test("a fence containing backticks is not closed early", () => {
    const html = markdownToHtml("````\nfoo ``` bar\n````");
    expect(htmlToMarkdown(html)).toContain("foo ``` bar");
  });
});

describe("lists with more than one paragraph", () => {
  test("a continuation paragraph stays inside its item", () => {
    /*
     * It used to keep turndown's four-space padding, which renders as a code
     * block rather than a paragraph. Blank lines between items are expected —
     * an item holding a paragraph makes the list loose — so what is checked is
     * the indentation and that nothing became code.
     */
    const result = round("1. step\n   - nested\n\n   continuation\n2. second");
    expect(result).toContain("\n   continuation");
    expect(result).not.toContain("\n    continuation");
    expect(result).not.toContain("```");
    expect(round(result)).toBe(result);
  });

  test("blank lines between items carry no trailing spaces", () => {
    const result = round("1. step\n\n   continuation\n2. second");
    for (const line of result.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe("fences guard what is inside them", () => {
  test("a shorter fence inside a longer one closes nothing", () => {
    // A three-backtick line inside a four-backtick block ended the guard, and
    // list tightening then rewrote the stored example.
    const source = "````\n```\n-   keep spacing\n```\n````";
    expect(round(source)).toBe(source);
  });
});

describe("tables keep their shape", () => {
  test("a cell with block content stays one row", () => {
    const markdown = htmlToMarkdown(
      "<table><tbody><tr><th>A</th><th>B</th></tr>" +
        "<tr><td><p>first</p><p>second</p></td><td>z</td></tr></tbody></table>",
    );
    expect(markdown.split("\n")).toHaveLength(3);
    expect(markdown).toContain("| first second | z |");
  });

  test("uppercase tags are handled like any other", () => {
    expect(htmlToMarkdown("<TABLE><TR><TD>A</TD><TD>B</TD></TR></TABLE>")).toBe(
      "| A | B |\n| --- | --- |",
    );
  });

  test("a caption survives as text above the table", () => {
    const markdown = htmlToMarkdown(
      "<table><caption>Nodes</caption><tbody><tr><td>A</td><td>B</td></tr></tbody></table>",
    );
    expect(markdown).toContain("Nodes");
    expect(markdown).toContain("| A | B |");
    expect(markdown).not.toContain("<table");
  });

  test("a header appearing in a later row does not count as one", () => {
    const markdown = htmlToMarkdown(
      "<table><tbody><tr><td>A</td></tr><tr><th>B</th></tr></tbody></table>",
    );
    expect(markdown).not.toContain("<table");
    expect(markdown.split("\n")[0]).toBe("| A |");
  });

  test("a table without a header row still becomes a table", () => {
    // GFM needs a header; without promotion turndown left raw HTML behind,
    // which the renderer then escaped into visible markup.
    const markdown = htmlToMarkdown(
      "<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>",
    );
    expect(markdown).toBe("| A | B |\n| --- | --- |\n| c | d |");
    expect(markdown).not.toContain("<table");
  });

  test("an escaped pipe stays in one cell across two round trips", () => {
    const once = round("| A | B |\n| --- | --- |\n| x\\|y | z |");
    const twice = round(once);
    // Three columns would mean the cell split.
    expect(twice.split("\n")[2]?.split(/(?<!\\)\|/).filter((cell) => cell.trim() !== "")).toHaveLength(2);
  });
});

describe("conversion always returns", () => {
  // These hung the process. The assertion is that they finish at all.
  const nasty = [
    "```c++\nx\n```",
    "````\nfoo ``` bar\n````",
    "``` js extra words\nlet a;\n```",
    "```\n```\n```",
    "~~~\nnot a backtick fence\n~~~",
    "`".repeat(50),
    "- ".repeat(200),
  ];
  for (const [index, input] of nasty.entries()) {
    test(`input ${index}`, () => {
      expect(typeof markdownToHtml(input)).toBe("string");
    });
  }

  test("empty input stays empty", () => {
    expect(round("")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown("   ")).toBe("");
  });
});

describe("raw html never reaches the server", () => {
  // Descriptions are stored and rendered in other people's browsers.
  test("a script tag is escaped, not passed through", () => {
    const html = markdownToHtml("Report <script>alert(1)</script> here");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an event handler attribute is escaped", () => {
    const html = markdownToHtml("Report <img src=x onerror=alert(1)> here");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("markup written by a user comes back as text, not as elements", () => {
    expect(round("Report <b>bold</b> here")).toBe("Report <b>bold</b> here");
  });
});
