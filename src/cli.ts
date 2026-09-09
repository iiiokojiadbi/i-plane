#!/usr/bin/env node
/*
 * Entry point: parse, resolve configuration, dispatch, print.
 *
 * With no arguments this prints the guide rather than doing something. The first
 * call of a session should say how the tool behaves — where filtering happens,
 * what the exit codes mean, that a list is complete unless it says otherwise —
 * because those are the things that cost a wrong call to discover.
 */

import { flagBool, flagValue, type ParsedArgs, parseArgs, UsageError } from "./args.ts";
import { PlaneClient, PlaneError } from "./client.ts";
import { formatCommandHelp, formatGuide, formatHint, guideReport } from "./commands/guide.ts";
import {
  commentIssue,
  completeIssue,
  createIssue,
  deleteIssue,
  findIssues,
  formatDetail,
  formatFound,
  formatListing,
  listIssues,
  showIssue,
  updateIssue,
} from "./commands/issues.ts";
import {
  configReport,
  formatConfig,
  formatLabels,
  formatMe,
  formatMembers,
  formatProjects,
  formatStates,
  formatSummary,
  labelsOf,
  membersOf,
  statesOf,
  summarize,
  whoami,
} from "./commands/workspace.ts";
import { resolveConfig } from "./config.ts";
import { needsProxy, proxyFetch, reExecWithProxy } from "./http.ts";
import { fail, printValue } from "./output.ts";
import { findCommand } from "./registry.ts";
import { listProjects } from "./resolve.ts";

const VERSION = "0.1.0";

/** Short forms are what fingers type; long ones are what a reader understands. */
const ALIASES: Readonly<Record<string, string>> = {
  ls: "list",
  new: "create",
  set: "update",
  rm: "delete",
  find: "search",
  ps: "projects",
};

/** Remembered so a failure can be answered with that command's own hint. */
let current: string | undefined;

/** Commands that never touch the network, so they work before configuration exists. */
const runOffline = (args: ParsedArgs, json: boolean): boolean => {
  const raw = args.path[0];
  const command = raw === undefined ? undefined : (ALIASES[raw] ?? raw);

  // No arguments at all: the guide, not a question nobody asked.
  if (command === undefined && !flagBool(args, "version")) {
    printValue(guideReport(), json, formatGuide);
    return true;
  }
  if (command === "guide" || flagBool(args, "help") === false) {
    if (command === "guide") {
      printValue(guideReport(), json, formatGuide);
      return true;
    }
  }
  if (command === "version" || flagBool(args, "version")) {
    printValue({ version: VERSION }, json, (v) => v.version);
    return true;
  }

  // `<command> --help` and the bare `help` both come from the registry, so help
  // and behaviour cannot drift apart.
  if (command !== undefined && flagBool(args, "help")) {
    const known = findCommand(command);
    if (known !== undefined) {
      printValue({ command: known }, json, (value) => formatCommandHelp(value));
      return true;
    }
  }
  if (command === "help") {
    printValue(guideReport(), json, formatGuide);
    return true;
  }
  return false;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2), 1);
  const json = flagBool(args, "json");

  if (runOffline(args, json)) return;

  const config = resolveConfig({
    url: flagValue(args, "url"),
    token: flagValue(args, "token"),
    workspace: flagValue(args, "workspace"),
    configPath: flagValue(args, "config"),
  });

  const raw = args.path[0];
  const command = raw === undefined ? undefined : (ALIASES[raw] ?? raw);
  current = command;

  // config comes after resolveConfig on purpose: its job is to explain what was
  // resolved, including a value that turned out to be wrong.
  if (command === "config") {
    printValue(configReport(config), json, formatConfig);
    return;
  }

  // A proxy is needed but this process cannot use one: run again with the
  // variable Node reads at startup. Only reached when undici is absent, so
  // installations that have it never pay for an extra process.
  if (needsProxy(config.url.value) && (await proxyFetch(config.url.value)) === undefined) {
    const code = await reExecWithProxy(config.url.value);
    if (code !== undefined) process.exit(code);
  }

  const client = new PlaneClient(config);

  switch (command) {
    case "summary":
      printValue(await summarize(client, config), json, formatSummary);
      return;
    case "projects":
      printValue(await listProjects(client), json, formatProjects);
      return;
    case "list":
      printValue(await listIssues(client, args), json, formatListing);
      return;
    case "show":
      printValue(
        await showIssue(client, args, config.workspace.value, config.url.value),
        json,
        formatDetail,
      );
      return;
    case "create":
      printValue(await createIssue(client, args), json, (row) => `created ${row.ref}  ${row.name}`);
      return;
    case "update":
      printValue(
        await updateIssue(client, args),
        json,
        (row) => `${row.ref}  ${row.name} (${row.state})`,
      );
      return;
    case "done":
      printValue(await completeIssue(client, args), json, (row) => `${row.ref} → ${row.state}`);
      return;
    case "delete":
      printValue(await deleteIssue(client, args), json, (text) => text);
      return;
    case "comment":
      printValue(await commentIssue(client, args), json, (text) => text);
      return;
    case "search":
      printValue(await findIssues(client, args), json, formatFound);
      return;
    case "states":
      printValue(await statesOf(client, args), json, formatStates);
      return;
    case "labels":
      printValue(await labelsOf(client, args), json, formatLabels);
      return;
    case "members":
      printValue(await membersOf(client), json, formatMembers);
      return;
    case "whoami":
      printValue(await whoami(client), json, formatMe);
      return;
    default:
      throw new UsageError(`No command "${command}". Run i-plane for the map.`);
  }
};

main().catch((error: unknown) => {
  // Exit codes are distinguishable: 2 means the call was wrong, 1 means Plane
  // said no or could not be reached. A caller can branch on that without parsing text.
  if (error instanceof UsageError) {
    // Answer with the command's own examples and narrowing flags, so the next
    // attempt is informed rather than another guess.
    const known = current === undefined ? undefined : findCommand(current);
    fail(known === undefined ? error.message : formatHint(known, error.message), 2);
  }
  if (error instanceof PlaneError) fail(error.message, 1);
  fail(error instanceof Error ? error.message : String(error), 1);
});
