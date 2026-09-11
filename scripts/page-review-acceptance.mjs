// Exercise the built CLI against an isolated deployment while its page is open.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const [origin, fixturePath, output] = process.argv.slice(2);
if (!origin || !fixturePath || !output)
  throw new Error("Usage: node scripts/page-review-acceptance.mjs <isolated-origin> <private-fixture.json> <output-directory>");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const env = { ...process.env, PLANE_URL: origin, PLANE_WORKSPACE: fixture.workspace_slug,
  PLANE_API_KEY: fixture.api_key, PLANE_CONFIG: "/dev/null", NO_PROXY: "*" };
for (const name of ["PLANE_LOGIN", "PLANE_PASSWORD", "PLANE_SESSION_CACHE", "DISPLAY", "WAYLAND_DISPLAY"])
  delete env[name];
let chromium;
for (const packagePath of [join(root, "package.json"), join(dirname(process.execPath), "..", "lib", "node_modules", "package.json")]) {
  try { ({ chromium } = createRequire(packagePath)("playwright")); break; } catch {}
}
if (!chromium) throw new Error("Playwright is required");
const execute = promisify(execFile);
const entry = process.env.IPLANE_ENTRY ?? join(root, "dist/cli.js");
let lastCall = 0;
const invoke = async (args, json = true) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await delay(Math.max(0, 3300 - (Date.now() - lastCall)));
    lastCall = Date.now();
    try {
      return await execute(process.execPath, [entry, ...args, ...(json ? ["--json"] : [])], { env, timeout: 45000 });
    } catch (error) {
      if (attempt || !String(error.stderr).includes("Rate limited (429)")) throw error;
      // An explicit rate-limit refusal performed no mutation; wait one server window.
      await delay(65000);
    }
  }
};
const cli = async (...args) => JSON.parse((await invoke(args)).stdout);
const report = { version: await cli("version"), checks: [], errors: [] };
const browser = await chromium.launch({ env });
let created, page, primaryFailure;
try {
  const review = { date: "2026-09-11", source: 'Reference "quoted" & <tag>\nSecond line with ``` and ~~~' };
  const markdown = '\x60\x60\x60knowledge-review\n' + JSON.stringify(review, null, 2) + '\n\x60\x60\x60';
  created = await cli("page", "create", fixture.project_id, "--name", `Review acceptance ${Date.now()}`, "--text", `Initial shared paragraph\n\n${markdown}`);
  assert.equal(created.delivery, "acknowledged");
  report.checks.push("API-key page creation and live content");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(fixture.cookie.split("; ").map((entry) => {
    const split = entry.indexOf("=");
    return { name: entry.slice(0, split), value: entry.slice(split + 1), url: origin };
  }));
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") report.errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) report.errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("requestfailed", (request) => report.errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  await page.goto(`${origin}/${fixture.workspace_slug}/projects/${fixture.project_id}/pages/${created.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const visible = (text) => page.waitForFunction((value) => document.body.innerText.includes(value), text, { timeout: 30000 });
  await visible("Initial shared paragraph");
  const rows = await cli("page", "outline", fixture.project_id, created.id);
  const first = rows.find((row) => row.kind === "knowledgeReview");
  assert.ok(first?.anchor);
  const block = await cli("page", "read", fixture.project_id, created.id, "--block", first.anchor);
  assert.deepEqual(block.losses, []);
  assert.equal(block.markdown, markdown);
  report.checks.push("Review read returns exact date/source Markdown without losses");
  await mkdir(output, { recursive: true });
  const inputPath = join(output, "roundtrip.md");
  // Exercise the user-visible whole-page read, not a block read substituted for it.
  let snapshot;
  for (let attempt = 0; attempt < 30; attempt++) {
    snapshot = await cli("page", "show", fixture.project_id, created.id);
    if (snapshot.markdown.includes(markdown)) break;
    await delay(1000);
  }
  assert.ok(snapshot.markdown.includes(markdown));
  assert.deepEqual(snapshot.losses, []);
  const printed = await invoke(["page", "show", fixture.project_id, created.id], false);
  assert.equal(printed.stderr, "");
  await writeFile(inputPath, `Full replacement heading\n\n${printed.stdout.trim()}\n\nTail paragraph`);
  report.checks.push("Saved HTML page show emits exact semantic review Markdown");
  const written = await cli("page", "set", fixture.project_id, created.id, "--file", inputPath);
  assert.equal(written.delivery, "acknowledged");
  assert.deepEqual(written.losses, []);
  await visible("Full replacement heading");
  const restored = (await cli("page", "outline", fixture.project_id, created.id)).find((row) => row.kind === "knowledgeReview");
  assert.ok(restored?.anchor);
  const reread = await cli("page", "read", fixture.project_id, created.id, "--block", restored.anchor);
  assert.equal(reread.markdown, markdown);
  assert.deepEqual(reread.losses, []);
  report.checks.push("Whole-page replacement from a file retains the semantic node and fields");
  await cli("page", "set", fixture.project_id, created.id, "--block", restored.anchor, "--if-match", reread.fingerprint, "--text", reread.markdown);
  assert.equal((await cli("page", "read", fixture.project_id, created.id, "--block", restored.anchor)).markdown, markdown);
  report.checks.push("Block replacement preserves its anchor and review data");
  const apiPath = `/api/workspaces/${fixture.workspace_slug}/projects/${fixture.project_id}/pages/${created.id}/`;
  await page.waitForFunction(async (path) => {
    const response = await fetch(path);
    if (!response.ok) return false;
    const serialized = JSON.stringify(await response.json());
    return serialized.includes("data-knowledge-review") && serialized.includes("Full replacement heading");
  }, apiPath, { timeout: 45000, polling: 1000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await visible("Full replacement heading");
  await page.getByTestId("knowledge-review").waitFor({ timeout: 30000 });
  const attributes = await page.locator('.tiptap[contenteditable="true"]').last().evaluate((element) => {
    let result;
    element.editor.state.doc.descendants((node) => { if (node.type.name === "knowledgeReview") result = node.attrs; });
    return result;
  });
  assert.equal(attributes.reviewedAt, review.date);
  assert.equal(attributes.source, review.source);
  report.checks.push("Persisted review reloads in the native browser with exact attributes");
  await page.locator('.tiptap[contenteditable="true"]').last().evaluate((element) => {
    const editor = element.editor;
    const paragraph = editor.schema.nodes.paragraph.create(null,
      editor.schema.text("Unsupported underline probe", [editor.schema.marks.underline.create()]));
    editor.commands.insertContentAt(editor.state.doc.content.size, paragraph.toJSON());
  });
  let unsupported;
  for (let attempt = 0; attempt < 30; attempt++) {
    unsupported = await cli("page", "show", fixture.project_id, created.id);
    if (unsupported.markdown.includes("Unsupported underline probe")) break;
    await delay(1000);
  }
  assert.ok(unsupported.markdown.includes("Unsupported underline probe"));
  assert.ok(unsupported.losses.length > 0);
  assert.ok(unsupported.markdown.includes(markdown));
  const lossyInput = join(output, "unsupported.md");
  await writeFile(lossyInput, unsupported.markdown);
  await assert.rejects(cli("page", "set", fixture.project_id, created.id, "--file", lossyInput),
    error => error.code === 2 && error.stderr.includes("--allow-loss"));
  assert.ok((await cli("page", "outline", fixture.project_id, created.id)).some(row => row.kind === "knowledgeReview"));
  report.checks.push("Unsupported rich content is reported on page show and replacement requires explicit loss approval");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "document.png"), fullPage: true });
  assert.deepEqual(report.errors, []);
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  await browser.close();
  if (created) {
    try {
      const deleted = await cli("page", "rm", fixture.project_id, created.id, "--yes");
      assert.equal(deleted.deleted, true);
      report.checks.push("Archive followed by whole-page deletion");
    } catch (error) {
      report.cleanupPage = created.id;
      report.cleanupError = String(error.message);
      if (!primaryFailure) throw error;
    } finally {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
}
console.log(JSON.stringify(report, null, 2));
