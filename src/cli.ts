#!/usr/bin/env node
/*
 * Entry point: parse, resolve configuration, dispatch, print.
 *
 * With no arguments this prints the guide rather than doing something. The first
 * call of a session should say how the tool behaves — where filtering happens,
 * what the exit codes mean, that a list is complete unless it says otherwise —
 * because those are the things that cost a wrong call to discover.
 */

import { flagBool, flagValue, type ParsedArgs, parseCommandArgs, UsageError } from "./args.ts";
import { PlaneClient, PlaneError } from "./client.ts";
import {
  formatCommandHelp,
  formatGlobalOptions,
  formatGuide,
  formatHint,
  guideReport,
} from "./commands/guide.ts";
import { configReport, formatConfig } from "./commands/workspace.ts";
import { peekToken, resolveConfig } from "./config.ts";
import { dispatchCommand } from "./dispatch.ts";
import { needsProxy, proxyFetch, reExecWithProxy } from "./http.ts";
import { fail, guardSecret, printValue } from "./output.ts";
import { dispatchPageCommand, isPageCommand } from "./page-dispatch.ts";
import {
  commandFamily,
  findCommand,
  GLOBAL_FLAGS,
  GLOBAL_OPTIONS,
  knownFlags,
} from "./registry.ts";

const VERSION = "2.0.0";

/** Remembered so a failure can be answered with that command's own hint. */
let current: string | undefined;

/*
 * A flag a command does not know is a mistake, and a silent one: a misspelled
 * --priority returned an unfiltered list with exit 0, which a caller cannot tell
 * apart from a correct answer.
 */
const rejectUnknownFlags = (command: string | undefined, args: ParsedArgs): void => {
  const known = command === undefined ? undefined : findCommand(command);
  if (known === undefined) {
    /*
     * help and version are real commands that the registry does not list, and
     * short-circuiting here let them accept anything: `help --pirority` exited
     * 0, teaching the caller that the flag exists.
     */
    if (
      command === undefined ||
      command === "help" ||
      command === "version" ||
      commandFamily(command).length > 0
    ) {
      const unknown = [...args.flags.keys()].filter((flag) => !GLOBAL_FLAGS.includes(flag));
      if (unknown.length > 0) {
        throw new UsageError(
          `${command ?? "i-plane"} does not take ${unknown.map((flag) => `--${flag}`).join(", ")}.`,
        );
      }
    }
    return;
  }
  current = command;
  const allowed = knownFlags(known);
  const unknown = [...args.flags.keys()].filter((flag) => !allowed.has(flag));
  if (unknown.length > 0) {
    const list = unknown.map((flag) => `--${flag}`).join(", ");
    throw new UsageError(`${known.name} does not take ${list}. Its flags are listed below.`);
  }
};

/** Commands that never touch the network, so they work before configuration exists. */
const runOffline = (args: ParsedArgs, json: boolean): boolean => {
  const raw = args.path.length === 0 ? undefined : args.path.join(" ");
  const command = raw === undefined ? undefined : (findCommand(raw)?.name ?? raw);
  // Offline commands validate their flags too: `guide --pirority urgent`
  // exiting 0 teaches the caller that the flag exists.
  rejectUnknownFlags(command, args);

  if (command !== undefined && commandFamily(command).length > 0) {
    const commands = commandFamily(command);
    if (flagBool(args, "help")) {
      printValue(
        { commands, globalOptions: GLOBAL_OPTIONS },
        json,
        (value) =>
          `${value.commands.map((entry) => formatCommandHelp({ command: entry }, false)).join("\n\n")}\n\n${formatGlobalOptions(value.globalOptions)}`,
      );
      return true;
    }
    throw new UsageError(
      `Expected ${command} <${commands.map((entry) => entry.name.split(" ")[1]).join("|")}>. Run i-plane ${command} --help.`,
    );
  }
  if (
    command !== undefined &&
    command !== "help" &&
    command !== "version" &&
    findCommand(command) === undefined
  ) {
    const family = commandFamily(command.split(" ")[0] ?? "");
    throw new UsageError(
      `No command "${command}". ${family.length ? `Available commands: ${family.map((entry) => entry.name).join(", ")}. Run i-plane ${command.split(" ")[0]} --help.` : "Run i-plane for the map."}`,
    );
  }

  // No arguments at all: the guide, not a question nobody asked.
  if (command === undefined && !flagBool(args, "version")) {
    printValue(guideReport(), json, formatGuide);
    return true;
  }
  if (command === "guide") {
    printValue(guideReport(), json, formatGuide);
    return true;
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
      printValue({ command: known, globalOptions: GLOBAL_OPTIONS }, json, (value) =>
        formatCommandHelp(value),
      );
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
  const args = parseCommandArgs(process.argv.slice(2));
  const json = flagBool(args, "json");

  /*
   * Guard before anything can print. Registering after configuration resolved
   * left two windows open: an invalid --url and an unknown flag both produced
   * diagnostics that quoted the token back when it was the offending value.
   */
  const early = peekToken({
    token: flagValue(args, "token"),
    configPath: flagValue(args, "config"),
  });
  if (early !== undefined) guardSecret(early);
  if (runOffline(args, json)) return;

  const commandName = args.path.join(" ");
  const config = resolveConfig(
    {
      url: flagValue(args, "url"),
      token: flagValue(args, "token"),
      workspace: flagValue(args, "workspace"),
      configPath: flagValue(args, "config"),
    },
    commandName === "config",
  );

  // The resolved token may differ from what was visible early on.
  if (config.token.value) guardSecret(config.token.value);

  const raw = args.path.length === 0 ? undefined : args.path.join(" ");
  const command = raw === undefined ? undefined : (findCommand(raw)?.name ?? raw);
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

  if (isPageCommand(commandName)) await dispatchPageCommand(commandName, client, args, json);
  else await dispatchCommand(command, client, args, config, json);
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
