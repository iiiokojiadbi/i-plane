#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "i-plane-mutations-"));
const fixture = JSON.parse(await readFile(join(root, "tests/fixtures/pages/heading.json"), "utf8"));
const cases = [
  ["canonical review restoration removed", "src/page-html.ts", "const saved = attrs.id ? byAnchor.get(attrs.id) : undefined;", "const saved = undefined;"],
  ["canonical review omission ignored", "src/page-html.ts", "reviews.some((review) => !review.used)", "false"],
  ["page show drops review metadata", "src/page-html.ts", "return reviewCodeHtml({ date: safeDate, source: safeSource });", 'return "<p>Review omitted</p>";'],
  ["fallback on permission refusal", "src/page-transport.ts", "error.status !== 404", "error.status !== 403"],
  ["capability cache never expires", "src/page-cache.ts", "value.expiresAt <= now", "false"],
  ["review input replaced by a paragraph", "src/page-document.ts", "reviewHtml(review)", '"<p>Review omitted</p>"'],
  ["review output replaced by a paragraph", "src/page-document.ts", "return reviewCodeHtml({ date, source });", 'return "<p>Review omitted</p>";'],
  [
    "constant converter",
    "src/page-document.ts",
    'Y.applyUpdate(doc, Buffer.from(data.description_binary, "base64"));',
    `Y.applyUpdate(doc, Buffer.from(${JSON.stringify(fixture.response.description_binary)}, "base64"));`,
  ],
  [
    "empty reverse mapping",
    "src/page-document.ts",
    "return { markdown: htmlToMarkdown(html), losses: [...losses] };",
    'return { markdown: "", losses: [...losses] };',
  ],
  [
    "wrong anchor index",
    "src/page-document.ts",
    "[{ node, index, anchor }]",
    "[{ node, index: 0, anchor }]",
  ],
  [
    "no-op stamping",
    "src/page-document.ts",
    'node.setAttribute("id", randomUUID());',
    "/* mutation: do not assign an anchor */",
  ],
  ["disabled redaction", "src/output.ts", "let safe = text;", "return text; let safe = text;"],
];
try {
  for (const name of ["src", "tests", "package.json"])
    await cp(join(root, name), join(directory, name), { recursive: true });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  for (const [name, file, before, after] of cases) {
    const path = join(directory, file);
    const original = await readFile(path, "utf8");
    if (!original.includes(before)) throw new Error(`Mutation point changed: ${name}`);
    await writeFile(path, original.replace(before, after));
    let detected = false;
    try {
      execFileSync(
        "bun",
        [
          "test",
          "tests/page-document.test.ts",
          "tests/page-commands.test.ts",
          "tests/page-api-key.test.ts",
          "tests/page-review.test.ts",
          "tests/page-transport.test.ts",
          "tests/session.test.ts",
        ],
        {
          cwd: directory,
          timeout: 15000,
          stdio: "pipe",
        },
      );
    } catch (error) {
      const output = String(error.stderr ?? "") + String(error.stdout ?? "");
      detected = error.status === 1 && /\(fail\)/.test(output);
      if (!detected) throw error;
    } finally {
      await writeFile(path, original);
    }
    if (!detected) throw new Error(`Tests missed mutation: ${name}`);
    console.log(`detected: ${name}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
