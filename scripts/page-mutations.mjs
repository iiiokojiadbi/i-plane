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
  ["wiki uses a project HTTP route", "src/commands/page-data.ts", 'placement.kind === "wiki" ? "pages/"', 'placement.kind === "wiki" ? "projects/fake/pages/"', "wiki list preserves every parent and archive in deterministic preorder"],
  ["wiki live kind becomes project", "src/page-live.ts", 'placement.kind === "wiki" ? "workspace_page" : "project_page"', '"project_page"', "wiki live scope has workspace kind and no project identifier"],
  ["wiki live carries a fake project", "src/page-live.ts", 'url.searchParams.set("workspaceSlug", client.config.workspace.value);', 'url.searchParams.set("projectId", "fake"); url.searchParams.set("workspaceSlug", client.config.workspace.value);', "wiki live scope has workspace kind and no project identifier"],
  ["wiki order ignores parent", "src/commands/page-data.ts", 'append(children.get("") ?? []);', '// mutation: no root preorder', "wiki list preserves every parent and archive in deterministic preorder"],
  ["wiki creation drops parent", "src/commands/page-content.ts", '...(parent === undefined ? {} : { parent })', '...{}', "wiki create resolves nested parent before a single POST"],
  ["wiki deletion archives implicitly", "src/commands/page-content.ts", 'if (!wiki && !page.archived_at)', 'if (!page.archived_at)', "wiki deletion asks the server without automatic archiving"],
  ["wiki feature gate bypassed", "src/page-transport.ts", '!runtime?.release ||', 'false && !runtime?.release ||', "wiki unsupported server refuses before page operations"],

  ["node preservation check bypassed", "src/page-transport.ts", "if (missing.length)", "if (false && missing.length)"],
  ["canonical review restoration removed", "src/page-html.ts", "const saved = attrs.id ? byAnchor.get(attrs.id) : undefined;", "const saved = undefined;"],
  ["canonical review omission ignored", "src/page-html.ts", "reviews.some((review) => !review.used)", "false"],
  ["page show drops review metadata", "src/page-html.ts", "return reviewCodeHtml({ date: safeDate, source: safeSource });", 'return "<p>Review omitted</p>";'],
  ["fallback on permission refusal", "src/page-transport.ts", "error.status !== 404) throw error;\n        await this.selectSession(error);", "error.status !== 403) throw error;\n        await this.selectSession(error);"],
  ["reader permission refusal treated as absence", "src/page-transport.ts", "error.status !== 404) throw error;\n        missing = true;", "error.status !== 403) throw error;\n        missing = true;"],
  ["reader cache ignores a runtime rollback", "src/page-transport.ts", "cached?.runtimeIdentity === runtimeIdentity", "cached?.runtimeIdentity !== undefined"],
  ["confirmed reader conversion loss ignored", "src/page-document.ts", "JSON.stringify(actual) !== JSON.stringify(expectedReviews)", "false"],
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
  for (const [name, file, before, after, assertion] of cases) {
    const path = join(directory, file);
    const original = await readFile(path, "utf8");
    if (!original.includes(before)) throw new Error(`Mutation point changed: ${name}`);
    await writeFile(path, original.replace(before, after));
    let detected = false;
    try {
      execFileSync(
        "bun",
        assertion ? ["test", "tests/wiki-commands.test.ts", "--test-name-pattern", `^${assertion}$`] : [
          "test",
          "tests/page-document.test.ts",
          "tests/page-node-readers.test.ts",
          "tests/page-node-discovery.test.ts",
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
      if (assertion) {
        const failures = [...output.matchAll(/\(fail\) ([^\n]+)/g)].map(match => match[1].replace(/ \[.*$/, ""));
        detected = detected && failures.length === 1 && failures[0] === assertion && !/error:.*(?:Cannot find|SyntaxError)/.test(output);
      }
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
