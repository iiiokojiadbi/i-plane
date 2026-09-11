// Exercise the built CLI against an isolated deployment while its page is open.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const [origin, fixturePath, output] = process.argv.slice(2);
if (!origin || !fixturePath || !output)
  throw new Error("Usage: node scripts/page-key-acceptance.mjs <isolated-origin> <private-fixture.json> <output-directory>");
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
const cli = async (...args) => {
  const { stdout } = await execute(process.execPath, [join(root, "dist/cli.js"), ...args, "--json"], { env, timeout: 45000 });
  return JSON.parse(stdout);
};
const report = { version: await cli("version"), checks: [], errors: [] };
const browser = await chromium.launch({ env });
let created, page;
try {
  created = await cli("page", "create", fixture.project_id, "--name", `Key acceptance ${Date.now()}`, "--text", "Initial shared paragraph");
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
  const initial = rows.find((row) => row.preview.includes("Initial shared paragraph"));
  assert.ok(initial?.anchor);
  const block = await cli("page", "read", fixture.project_id, created.id, "--block", initial.anchor);
  assert.match(block.markdown, /Initial shared paragraph/);
  await cli("page", "set", fixture.project_id, created.id, "--block", initial.anchor, "--if-match", block.fingerprint, "--text", "Updated while browser open");
  await visible("Updated while browser open");
  report.checks.push("CLI block replacement appears in the open browser");
  await assert.rejects(cli("page", "set", fixture.project_id, created.id, "--block", initial.anchor, "--if-match", block.fingerprint, "--text", "Stale write"), /content changed/);
  report.checks.push("Stale fingerprint rejects the write");
  const editor = page.locator('.tiptap[contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Browser contribution");
  await visible("Browser contribution");
  const liveRows = await cli("page", "outline", fixture.project_id, created.id);
  assert.ok(liveRows.some((row) => row.preview.includes("Browser contribution")));
  report.checks.push("CLI reads browser changes from the live document");
  await cli("page", "insert", fixture.project_id, created.id, "--at-end", "--text", "CLI appended paragraph");
  await visible("CLI appended paragraph");
  const inserted = (await cli("page", "outline", fixture.project_id, created.id)).find((row) => row.preview.includes("CLI appended paragraph"));
  await cli("page", "rm", fixture.project_id, created.id, "--block", inserted.anchor, "--yes");
  await page.waitForFunction(() => !document.body.innerText.includes("CLI appended paragraph"), null, { timeout: 30000 });
  await cli("page", "stamp", fixture.project_id, created.id);
  report.checks.push("Insertion, block deletion and explicit stamping");
  assert.ok((await cli("pages", fixture.project_id)).some((row) => row.id === created.id));
  assert.equal((await cli("page", "show", fixture.project_id, created.id)).id, created.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await visible("Updated while browser open");
  await visible("Browser contribution");
  report.checks.push("Metadata reads and browser reload preserve both writers");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "document.png"), fullPage: true });
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  if (created) {
    try {
      const deleted = await cli("page", "rm", fixture.project_id, created.id, "--yes");
      assert.equal(deleted.deleted, true);
      report.checks.push("Archive followed by whole-page deletion");
    } catch (error) {
      report.cleanupPage = created.id;
      throw error;
    } finally {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
}
console.log(JSON.stringify(report, null, 2));
