/*
 * Round-trip tests for descriptions.
 *
 * Every case here is a bug that shipped once: a fence like ```c++ hung the
 * process forever, nested lists were flattened, literal HTML inside inline code
 * vanished, blank lines inside code blocks collapsed, escaped pipes split table
 * cells. They are kept as tests so the next rewrite cannot quietly bring them
 * back.
 */

import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, markdownToHtml } from "../src/richtext.ts";

const round = (markdown: string): string => htmlToMarkdown(markdownToHtml(markdown));

describe("round trip", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["fence with a language that is not a word", "```c++\nint x;\n```"],
    ["fence with an info string", "```js extra words\nlet a;\n```"],
    ["unclosed fence", "```bash\necho hi"],
    ["nested list", "- parent\n  - child\n- sibling"],
    ["ordered list stays numbered", "1. one\n2. two"],
    ["inline code holding markup", "Before `<div>` after."],
    ["table", "| A | B |\n| --- | --- |\n| x | y |"],
    ["heading and paragraph", "# Title\n\nBody text."],
    ["quote", "> quoted line"],
    ["bold and italic", "**bold** and *italic*"],
  ];

  for (const [name, markdown] of cases) {
    test(name, () => {
      const once = round(markdown);
      // Stability matters more than an exact match: a description is read and
      // written back many times, and drift compounds.
      expect(round(once)).toBe(once);
      expect(once.length).toBeGreaterThan(0);
    });
  }

  test("empty description stays empty", () => {
    expect(round("")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
  });
});

describe("conversion does not hang", () => {
  // The hang was an infinite loop, so the assertion is that these return at all.
  const nasty = [
    "```c++\nx\n```",
    "````\nfoo ``` bar\n````",
    "``` js extra\nlet a;\n```",
    "```\n```\n```",
    "~~~\nnot a backtick fence\n~~~",
    "`".repeat(50),
  ];
  for (const [index, input] of nasty.entries()) {
    test(`input ${index} returns`, () => {
      expect(typeof markdownToHtml(input)).toBe("string");
    });
  }
});

describe("content survives", () => {
  test("code keeps blank lines and trailing spaces", () => {
    const source = "```txt\na  \n\n\nb\n```";
    expect(round(source)).toContain("a  ");
    expect(round(source)).toContain("\n\n");
  });

  test("nested list keeps its level", () => {
    const result = round("- parent\n  - child\n- sibling");
    expect(result).toContain("  - child");
  });

  test("inline code keeps its markup", () => {
    expect(round("Before `<div>` after.")).toContain("`<div>`");
  });

  test("escaped pipe stays inside one cell", () => {
    const once = round("| A | B |\n| --- | --- |\n| x\\|y | z |");
    expect(once).toContain("x\\|y");
    // The second pass is where the unescaped version used to split the cell.
    expect(round(once)).toContain("x\\|y");
  });
});

describe("raw html never reaches the server", () => {
  // Descriptions are stored and rendered in other people's browsers.
  test("script tag is escaped", () => {
    const html = markdownToHtml("Report <script>alert(1)</script> here");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("event handler attribute is escaped", () => {
    const html = markdownToHtml("Report <img src=x onerror=alert(1)> here");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
