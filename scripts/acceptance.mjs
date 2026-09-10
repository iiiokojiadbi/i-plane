#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (!process.argv.includes("--live")) {
  console.error(
    "Pass --live to create and delete a temporary project on the configured Plane instance.",
  );
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist/cli.js");
const identifier = `T${Date.now().toString(36).toUpperCase()}`;
let projectId;
let callCount = 0;
let cleanupFailed = false;

// Every operation, including cleanup, goes through the built CLI. Spacing
// calls keeps this scenario below the API's shared request budget.
const run = async (...args) => {
  if (callCount > 0) await delay(7000);
  callCount += 1;
  console.log(`${callCount}. i-plane ${args.slice(0, 2).join(" ")}`);
  const stdout = execFileSync(process.execPath, [entry, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
};

try {
  const project = await run(
    "project",
    "create",
    `CLI acceptance ${identifier}`,
    "--identifier",
    identifier,
    "--description",
    "Temporary acceptance fixture",
  );
  projectId = project.id;
  assert.equal(project.identifier, identifier);
  const updated = await run(
    "project",
    "update",
    identifier,
    "--name",
    `CLI checked ${identifier}`,
    "--description",
    "Updated acceptance fixture",
  );
  assert.equal(updated.name, `CLI checked ${identifier}`);
  const epicLabel = await run(
    "label",
    "create",
    "epic",
    "--project",
    identifier,
    "--color",
    "#8ED1FC",
  );
  const taskLabel = await run(
    "label",
    "create",
    "task",
    "--project",
    identifier,
    "--color",
    "#3B82F6",
  );
  const reviewLabel = await run("label", "create", "review", "--project", identifier);
  const state = await run(
    "state",
    "create",
    "Review",
    "--project",
    identifier,
    "--color",
    "#336699",
    "--group",
    "started",
  );
  const renamedState = await run(
    "state",
    "update",
    "Review",
    "--project",
    identifier,
    "--name",
    "In Review",
    "--color",
    "#112233",
    "--description",
    "Acceptance review",
  );
  assert.equal(renamedState.name, "In Review");
  const me = await run("whoami");
  const epic = await run(
    "create",
    "Acceptance epic",
    "--project",
    identifier,
    "--label",
    "epic",
    "--priority",
    "high",
    "--description",
    "## Acceptance\n\nA project assembled entirely through the CLI.",
  );
  const children = [];
  const priorities = ["urgent", "high", "high", "medium", "medium", "medium", "low", "low", "low"];
  for (const [index, priority] of priorities.entries()) {
    children.push(
      await run(
        "create",
        `Acceptance child ${index + 1}`,
        "--project",
        identifier,
        "--parent",
        epic.ref,
        "--label",
        "task",
        "--priority",
        priority,
      ),
    );
  }
  const child = children[0];
  await run(
    "update",
    child.ref,
    "--label",
    "review",
    "--assignee",
    me.display_name ?? me.id,
    "--start",
    "2026-10-01",
    "--due",
    "2026-10-08",
    "--state",
    "In Review",
  );
  const detail = await run("show", child.ref);
  assert.equal(detail.parent, epic.id);
  assert.deepEqual(new Set(detail.labels), new Set([taskLabel.id, reviewLabel.id]));
  assert.ok(detail.assignees.includes(me.id));
  assert.equal(detail.start_date, "2026-10-01");
  assert.equal(detail.target_date, "2026-10-08");
  assert.equal(detail.state, "In Review");
  assert.equal((await run("show", epic.ref)).labels[0], epicLabel.id);
  await run("comment", child.ref, "**Acceptance** discussion\n\n`<div>` stays code.");
  const comments = await run("comments", child.ref);
  assert.ok(
    comments.some(
      (comment) => comment.body.includes("**Acceptance**") && comment.body.includes("`<div>`"),
    ),
  );
  const withComments = await run("show", child.ref, "--comments");
  assert.deepEqual(withComments.comments, comments);
  await run(
    "update",
    child.ref,
    "--labels",
    "task",
    "--parent",
    "none",
    "--assignee",
    "none",
    "--due",
    "none",
    "--start",
    "none",
  );
  const cleared = await run("show", child.ref);
  assert.deepEqual(cleared.labels, [taskLabel.id]);
  assert.deepEqual(cleared.assignees, []);
  assert.equal(cleared.parent, null);
  assert.equal(cleared.target_date, null);
  assert.equal(cleared.start_date, null);
  await run("update", child.ref, "--parent", epic.ref);
  const completed = await run("done", child.ref, "--priority", "urgent");
  assert.equal(completed.group, "completed");
  await run("state", "rm", state.id, "--project", identifier, "--yes");
  await run("label", "rm", "review", "--project", identifier, "--yes");
  const listing = await run("list", identifier);
  assert.equal(listing.total, 10);
  assert.equal(listing.rows.length, 10);
  await run("project", "archive", identifier);
  console.log(
    `PASS: ${identifier}, one epic and nine children; labels, fields, comments, states and archive verified.`,
  );
} finally {
  if (projectId !== undefined) {
    try {
      await run("project", "rm", projectId, "--yes");
      console.log(`Cleaned up temporary project ${identifier}.`);
    } catch (error) {
      cleanupFailed = true;
      console.error(`Cleanup failed. Run i-plane project rm ${projectId} --yes.`);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}
if (cleanupFailed) process.exitCode = 1;
