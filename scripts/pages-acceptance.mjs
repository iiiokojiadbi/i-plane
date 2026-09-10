#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to create and delete a temporary page.");
const project = process.argv[process.argv.indexOf("--project") + 1];
if (!process.argv.includes("--project") || !project)
  throw new Error("Pass --project <identifier> for an existing test project.");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "i-plane-pages-acceptance-"));
const entry = process.env.IPLANE_ENTRY ?? "dist/cli.js";
const invoke = async (words) => {
  const result = await promisify(execFile)(process.execPath, [entry, ...words, "--json"], {
    cwd: root,
    timeout: 30000,
  });
  return JSON.parse(result.stdout);
};
let id;
try {
  const file = join(directory, "page.md");
  await writeFile(file, '# Acceptance\n\n```python\nprint("hello")\n```\n\nFinal paragraph');
  const created = await invoke([
    "page",
    "create",
    project,
    "--name",
    `CLI acceptance ${Date.now()}`,
    "--file",
    file,
  ]);
  id = created.id;
  assert.equal(created.delivery, "acknowledged");
  assert((await invoke(["pages", project])).some((page) => page.id === id));
  const rows = await invoke(["page", "outline", project, id]);
  assert.equal(rows.length, 3);
  const anchor = rows[0].anchor;
  const original = await invoke(["page", "read", project, id, "--block", anchor]);
  assert.equal(original.markdown, "# Acceptance");
  assert(
    (await invoke(["page", "read", project, id, "--block", rows[1].anchor])).markdown.includes(
      "```python",
    ),
  );
  const options = ["--block", anchor, "--if-match", original.fingerprint];
  await invoke([
    "page",
    "set",
    project,
    id,
    ...options,
    "--text",
    "First replacement\n\nSecond replacement",
  ]);
  await assert.rejects(
    invoke(["page", "set", project, id, ...options, "--text", "Stale edit"]),
    (error) => error.code === 1 && error.stderr.includes("content changed"),
  );
  assert.equal(
    (await invoke(["page", "read", project, id, "--block", anchor])).markdown,
    "First replacement",
  );
  await invoke([
    "page",
    "insert",
    project,
    id,
    "--after",
    anchor,
    "--text",
    "Inserted after anchor",
  ]);
  await invoke(["page", "insert", project, id, "--at-end", "--text", "Inserted at end"]);
  assert.equal((await invoke(["page", "stamp", project, id])).stamped, 0);
  const fresh = await invoke(["page", "read", project, id, "--block", anchor]);
  await invoke([
    "page",
    "rm",
    project,
    id,
    "--block",
    anchor,
    "--if-match",
    fresh.fingerprint,
    "--yes",
  ]);
  assert(!(await invoke(["page", "outline", project, id])).some((row) => row.anchor === anchor));
  const marker = `Saved acceptance ${Date.now()}`;
  await invoke(["page", "set", project, id, "--text", marker]);
  const started = Date.now();
  let saved = false;
  while (Date.now() - started < 30000) {
    const page = await invoke(["page", "show", project, id]);
    if (page.markdown === marker) {
      saved = true;
      break;
    }
    await delay(1000);
  }
  assert(saved, "Saved HTML did not catch up within this acceptance run's observation window");
  console.log(
    `PASS: nine page commands, stale fingerprint, language preservation, saved HTML observed after ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} finally {
  if (id) {
    await invoke(["page", "rm", project, id, "--yes"]);
    console.log(`Removed temporary page ${id}`);
  }
  await rm(directory, { recursive: true, force: true });
}
