#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (!process.argv.includes("--live")) {
  console.error(
    "Pass --live to create and delete a temporary planning project on the configured Plane instance.",
  );
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist/cli.js");
const identifier = `P${Date.now().toString(36).toUpperCase()}`;
const date = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
let projectId;
let count = 0;
const run = async (...args) => {
  if (count > 0) await delay(7000);
  console.log(`${++count}. i-plane ${args.slice(0, 2).join(" ")}`);
  return JSON.parse(
    execFileSync(process.execPath, [entry, ...args, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
};
const ids = (listing) => new Set(listing.rows.map((row) => row.id));
try {
  const project = await run(
    "project",
    "create",
    `Planning acceptance ${identifier}`,
    "--identifier",
    identifier,
    "--cycles",
    "--modules",
    "--intake",
  );
  projectId = project.id;
  assert.equal(project.intake_view, true);
  const source = await run(
    "cycle",
    "create",
    "First sprint",
    "--project",
    identifier,
    "--start",
    date(0),
    "--end",
    date(7),
  );
  const target = await run(
    "cycle",
    "create",
    "Next sprint",
    "--project",
    identifier,
    "--start",
    date(8),
    "--end",
    date(14),
  );
  assert.deepEqual(
    new Set((await run("cycles", identifier)).map((cycle) => cycle.id)),
    new Set([source.id, target.id]),
  );
  const module = await run(
    "module",
    "create",
    "Documentation",
    "--project",
    identifier,
    "--description",
    "Related work",
    "--status",
    "planned",
    "--start",
    date(0),
    "--due",
    date(20),
  );
  assert.equal((await run("modules", identifier))[0].id, module.id);
  const open = await run("create", "Open work", "--project", identifier);
  const done = await run(
    "create",
    "Completed work",
    "--project",
    identifier,
    "--state",
    "completed",
  );
  const cancelled = await run(
    "create",
    "Cancelled work",
    "--project",
    identifier,
    "--state",
    "cancelled",
  );
  await run(
    "cycle",
    "add",
    open.ref,
    done.ref,
    cancelled.ref,
    "--project",
    identifier,
    "--cycle",
    "First sprint",
  );
  assert.deepEqual(
    ids(await run("cycle", "issues", "First sprint", "--project", identifier)),
    new Set([open.id, done.id, cancelled.id]),
  );
  await run(
    "module",
    "add",
    open.ref,
    done.ref,
    "--project",
    identifier,
    "--module",
    "Documentation",
  );
  assert.deepEqual(
    ids(await run("module", "issues", "Documentation", "--project", identifier)),
    new Set([open.id, done.id]),
  );
  await run(
    "cycle",
    "update",
    "First sprint",
    "--project",
    identifier,
    "--start",
    date(-14),
    "--end",
    date(-1),
  );
  await run("cycle", "transfer", "First sprint", "Next sprint", "--project", identifier);
  assert.deepEqual(
    ids(await run("cycle", "issues", "First sprint", "--project", identifier)),
    new Set([done.id, cancelled.id]),
  );
  assert.deepEqual(
    ids(await run("cycle", "issues", "Next sprint", "--project", identifier)),
    new Set([open.id]),
  );
  const incoming = await run(
    "intake",
    "create",
    "Incoming work",
    "--project",
    identifier,
    "--description",
    "**Details**",
    "--priority",
    "high",
  );
  const shown = await run("intake", "show", incoming.ref, "--project", identifier);
  assert.equal(shown.description, "**Details**");
  assert.equal(shown.priority, "high");
  assert.ok(
    (await run("intake", "list", identifier, "--status", "pending")).some(
      (item) => item.issueId === incoming.issueId,
    ),
  );
  await run(
    "intake",
    "update",
    incoming.ref,
    "--project",
    identifier,
    "--name",
    "Updated incoming",
    "--priority",
    "urgent",
    "--status",
    "snoozed",
    "--snooze-until",
    date(3),
  );
  const snoozed = await run("intake", "show", incoming.issueId, "--project", identifier);
  assert.equal(snoozed.status, "snoozed");
  assert.equal(snoozed.name, "Updated incoming");
  assert.equal(snoozed.snoozedUntil.slice(0, 10), date(3));
  await run("intake", "update", incoming.issueId, "--project", identifier, "--status", "pending");
  const duplicate = await run(
    "intake",
    "update",
    incoming.ref,
    "--project",
    identifier,
    "--status",
    "duplicate",
    "--duplicate-of",
    open.ref,
  );
  assert.equal(duplicate.duplicateTo, open.id);
  const accepted = await run(
    "intake",
    "update",
    incoming.ref,
    "--project",
    identifier,
    "--status",
    "accepted",
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.snoozedUntil, null);
  assert.equal(accepted.duplicateTo, null);
  assert.ok(
    ["backlog", "unstarted", "started", "completed", "cancelled"].includes(
      (await run("show", incoming.ref)).group,
    ),
  );
  await run("intake", "rm", incoming.ref, "--project", identifier, "--yes");
  assert.equal((await run("show", incoming.ref)).id, incoming.issueId);
  const rejected = await run("intake", "create", "Rejected work", "--project", identifier);
  await run("intake", "update", rejected.ref, "--project", identifier, "--status", "rejected");
  assert.ok(
    (await run("intake", "list", identifier, "--status", "rejected")).some(
      (item) => item.issueId === rejected.issueId,
    ),
  );
  await run("intake", "rm", rejected.ref, "--project", identifier, "--yes");
  let removed = false;
  try {
    await run("show", rejected.ref);
  } catch (error) {
    removed = String(error.stderr).includes("404");
  }
  assert.equal(removed, true);
  console.log(
    `PASS: ${identifier}; cycle transfer preserves completed work, module membership and intake lifecycle verified.`,
  );
} finally {
  if (projectId !== undefined) {
    try {
      await run("project", "rm", projectId, "--yes");
      console.log(`Cleaned up temporary project ${identifier}.`);
    } catch (error) {
      console.error(`Cleanup failed. Run i-plane project rm ${projectId} --yes.`);
      throw error;
    }
  }
}
