#!/usr/bin/env node
/*
 * Entry point: parse, resolve configuration, dispatch, print.
 *
 * Two rules hold everywhere below. Nothing ever prompts — a CLI that waits for
 * input hangs an agent forever, so a missing argument is an error that says what
 * was expected. And every command answers to --json, because the human form is
 * lossy on purpose.
 */

import { flagBool, flagValue, type ParsedArgs, parseArgs, UsageError } from "./args.ts";
import { PlaneClient, PlaneError } from "./client.ts";
import { formatGuide, guideReport } from "./commands/guide.ts";
import {
  commentIssue,
  completeIssue,
  createIssue,
  deleteIssue,
  findIssues,
  formatDetail,
  formatFound,
  formatRows,
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
import { listProjects } from "./resolve.ts";

const VERSION = "0.1.0";

const USAGE = `i-plane — a Plane CLI that prints lines, not JSON dumps.

  i-plane                    workspace summary
  i-plane guide              the command map and the usual order of work
  i-plane list CLOUD         work items, one line each
  i-plane show CLOUD-8       one work item

Every command takes --json. Configuration: --url, --token, --workspace,
or PLANE_URL / PLANE_API_KEY / PLANE_WORKSPACE, or ~/.config/plane/credentials.
See where it came from with: i-plane config`;

/** Commands that never touch the network, so they work before configuration exists. */
const runOffline = (args: ParsedArgs, json: boolean): boolean => {
  const command = args.path[0];
  if (command === "guide") {
    printValue(guideReport(), json, formatGuide);
    return true;
  }
  if (command === "version" || flagBool(args, "version")) {
    printValue({ version: VERSION }, json, (v) => v.version);
    return true;
  }
  if (command === "help" || flagBool(args, "help")) {
    printValue({ usage: USAGE }, json, (v) => v.usage);
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

  // config comes after resolveConfig on purpose: its job is to explain what was
  // resolved, including a value that turned out to be wrong.
  if (args.path[0] === "config") {
    printValue(configReport(config), json, formatConfig);
    return;
  }

  // A proxy is needed but this process cannot use one: run again with the
  // variable Node reads at startup. Only reached when undici is absent, so
  // installations that have it never pay the extra process.
  if (needsProxy(config.url.value) && (await proxyFetch(config.url.value)) === undefined) {
    const code = await reExecWithProxy(config.url.value);
    if (code !== undefined) process.exit(code);
  }

  const client = new PlaneClient(config);
  // Short forms exist because they are what fingers type; the long ones are what
  // a reader understands. Both reach the same command.
  const ALIASES: Readonly<Record<string, string>> = {
    ls: "list",
    new: "create",
    set: "update",
    rm: "delete",
    find: "search",
    ps: "projects",
  };
  const raw = args.path[0];
  const command = raw === undefined ? undefined : (ALIASES[raw] ?? raw);

  switch (command) {
    case undefined:
      printValue(await summarize(client, config), json, formatSummary);
      return;
    case "projects":
      printValue(await listProjects(client), json, formatProjects);
      return;
    case "list":
      printValue(await listIssues(client, args), json, formatRows);
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
      throw new UsageError(`No command "${command}". Run i-plane guide for the map.`);
  }
};

main().catch((error: unknown) => {
  // Exit codes are distinguishable: 2 means the call was wrong, 1 means Plane
  // said no or could not be reached. A caller can branch on that without parsing text.
  if (error instanceof UsageError) fail(error.message, 2);
  if (error instanceof PlaneError) fail(error.message, 1);
  fail(error instanceof Error ? error.message : String(error), 1);
});
