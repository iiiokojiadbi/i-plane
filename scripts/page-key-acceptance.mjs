// Exercise the built CLI against an isolated deployment while its page is open.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const [origin, fixturePath, output, placement] = process.argv.slice(2);
const wiki = placement === "--wiki";
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
const pageCli = (verb, ...args) => cli(wiki ? "wiki" : "page", verb, ...(wiki ? [] : [fixture.project_id]), ...args);
const listCli = () => wiki ? cli("wiki", "list") : cli("pages", fixture.project_id);
const wikiHttp = async (id, suffix, method) => {
  const response = await fetch(`${origin}/api/v1/workspaces/${fixture.workspace_slug}/pages/${id}/${suffix}`, { method, headers: { "X-Api-Key": fixture.api_key } });
  assert.ok(response.ok, `Fixture cleanup failed: ${method} ${suffix}: ${response.status}`);
};
const report = { version: await cli("version"), checks: [], errors: [], cancellations: [] };
const browser = await chromium.launch({ env });
let created, page, parent;
const completedAncestry = new Set();
try {
  if (wiki) parent = await pageCli("create", "--name", `Key acceptance parent ${Date.now()}`);
  created = await pageCli("create", "--name", `Key acceptance ${Date.now()}`, "--text", "Initial shared paragraph", ...(parent ? ["--parent", parent.id] : []));
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
  page.on("response", (response) => { if (response.ok() && new URL(response.url()).pathname.endsWith("/ancestry/")) completedAncestry.add(new URL(response.url()).pathname); if (response.status() >= 400) report.errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    const message = `${path}: ${request.failure()?.errorText}`;
    // The wiki ancestry effect aborts its previous request when the page snapshot changes.
    // Record those cancellations separately and require a successful replacement below.
    if (wiki && path === `/api/workspaces/${fixture.workspace_slug}/wiki/pages/${created.id}/ancestry/` && request.failure()?.errorText === "net::ERR_ABORTED") report.cancellations.push(path);
    else report.errors.push(message);
  });
  await page.goto(wiki ? `${origin}/${fixture.workspace_slug}/wiki/${created.id}` : `${origin}/${fixture.workspace_slug}/projects/${fixture.project_id}/pages/${created.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const visible = (text) => page.waitForFunction((value) => document.body.innerText.includes(value), text, { timeout: 30000 });
  await visible("Initial shared paragraph");
  const rows = await pageCli("outline", created.id);
  const initial = rows.find((row) => row.preview.includes("Initial shared paragraph"));
  assert.ok(initial?.anchor);
  const block = await pageCli("read", created.id, "--block", initial.anchor);
  assert.match(block.markdown, /Initial shared paragraph/);
  await pageCli("set", created.id, "--block", initial.anchor, "--if-match", block.fingerprint, "--text", "Updated while browser open");
  await visible("Updated while browser open");
  report.checks.push("CLI block replacement appears in the open browser");
  await assert.rejects(pageCli("set", created.id, "--block", initial.anchor, "--if-match", block.fingerprint, "--text", "Stale write"), /content changed/);
  report.checks.push("Stale fingerprint rejects the write");
  const editor = page.locator('.tiptap[contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Browser contribution");
  await visible("Browser contribution");
  const liveRows = await pageCli("outline", created.id);
  assert.ok(liveRows.some((row) => row.preview.includes("Browser contribution")));
  report.checks.push("CLI reads browser changes from the live document");
  await pageCli("insert", created.id, "--at-end", "--text", "CLI appended paragraph");
  await visible("CLI appended paragraph");
  const inserted = (await pageCli("outline", created.id)).find((row) => row.preview.includes("CLI appended paragraph"));
  await pageCli("rm", created.id, "--block", inserted.anchor, "--yes");
  await page.waitForFunction(() => !document.body.innerText.includes("CLI appended paragraph"), null, { timeout: 30000 });
  await pageCli("stamp", created.id);
  report.checks.push("Insertion, block deletion and explicit stamping");
  assert.ok((await listCli()).some((row) => row.id === created.id));
  assert.equal((await pageCli("show", created.id)).id, created.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await visible("Updated while browser open");
  await visible("Browser contribution");
  report.checks.push("Metadata reads and browser reload preserve both writers");
  if (wiki) {
    const rows = await listCli();
    assert.equal(rows.find(row => row.id === created.id).parent, parent.id);
    assert.ok(rows.findIndex(row => row.id === parent.id) < rows.findIndex(row => row.id === created.id));
    await assert.rejects(pageCli("rm", created.id, "--yes"), /Archive the page before deleting it/);
    assert.equal((await pageCli("show", created.id)).archived_at, null);
    report.checks.push("Wiki parent creation, list order and deletion refusal without auto-archive");
  }
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "document.png"), fullPage: true });
  for (const path of report.cancellations) assert.ok(completedAncestry.has(path), "Cancelled ancestry must have a successful replacement");
  assert.deepEqual(report.errors, []);
 } finally {
  await browser.close();
  const failures = [];
  for (const target of [created, parent].filter(Boolean)) {
    try {
      if (wiki) await wikiHttp(target.id, "archive/", "POST");
      const deleted = await pageCli("rm", target.id, "--yes");
      assert.equal(deleted.deleted, true);
      report.checks.push(wiki ? "Explicit fixture archive followed by CLI deletion" : "Archive followed by whole-page deletion");
    } catch (error) {
      failures.push({ id: target.id, message: error.message });
    }
  }
  if (failures.length) report.cleanupPages = failures;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(failures.length, 0, "Fixture cleanup failed; retained UUIDs are in result.json");
}
console.log(JSON.stringify(report, null, 2));
