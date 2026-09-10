import { afterEach, expect, test } from "bun:test";
import { pageDetail } from "../src/commands/page-data.ts";
import { scrubHtml } from "../src/html-secrets.ts";
import { guardSecret, printValue, scrub } from "../src/output.ts";

afterEach(() => guardSecret(""));
test("unchanged HTML is preserved byte for byte", () => {
  guardSecret("unrelated-password");
  const html = '<p class="note">ordinary &amp; <strong>bold</strong></p>\n';
  expect(scrubHtml(html)).toBe(html);
});
for (const html of [
  "<p>secret<strong>[brackets]</strong>*</p>",
  "<p>secret&#91;brackets&#93;*</p>",
  "<p>secret&#x5b;brackets&#x5d;*</p>",
  '<p title="secret&#91;brackets&#93;*">ordinary</p>',
]) {
  test(`show protects decoded and formatted secrets: ${html}`, () => {
    guardSecret("secret[brackets]*");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      const model = pageDetail({ id: "page", name: "Page", description_html: html });
      for (const json of [false, true]) printValue(model, json, (value) => value.markdown);
      expect(output).not.toContain("secret");
      expect(output).not.toContain("brackets");
      expect(output).toContain("token");
    } finally {
      process.stdout.write = original;
    }
  });
}
test("redaction spans marks and keeps unrelated prefixes, suffixes and attributes", () => {
  guardSecret("password");
  const html = '<p class="keep">before pass<strong>word and pass</strong>word after</p>';
  const safe = scrubHtml(html);
  expect(safe).toBe('<p class="keep">before [token]<strong> and [token]</strong> after</p>');
});
test("overlapping secrets and comments do not leave fragments", () => {
  guardSecret("password");
  guardSecret("password-long");
  const safe = scrubHtml("<p>pass<em>word-long</em></p><!-- password -->");
  expect(safe).not.toContain("pass");
  expect(safe).not.toContain("word");
  expect(safe).not.toContain("-long");
});
test("redaction remains usable for malformed Unicode", () => {
  guardSecret("bad\ud800value");
  expect(scrub("bad\ud800value")).toBe("[token]");
});
