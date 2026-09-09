/*
 * Minimal argument parser. No dependency does this better for our shape, and a
 * CLI an agent calls dozens of times a session should not pay startup cost for
 * a parser framework.
 *
 * Shape: i-plane <command> [<subcommand>] [positional...] [--flag value] [--bool]
 */

export interface ParsedArgs {
  /** Command path, e.g. ["issue", "ls"]. Empty when nothing was given. */
  readonly path: ReadonlyArray<string>;
  readonly positionals: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string | true>;
}

/** Flags that take a value; everything else is a boolean switch. */
const VALUE_FLAGS = new Set([
  "url",
  "token",
  "workspace",
  "config",
  "project",
  "state",
  "priority",
  "assignee",
  "limit",
  "description",
  "name",
  "label",
  "cycle",
  "module",
  "parent",
]);

export const parseArgs = (argv: ReadonlyArray<string>, commandDepth: number): ParsedArgs => {
  const path: string[] = [];
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (VALUE_FLAGS.has(body)) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UsageError(`Flag --${body} needs a value.`);
        }
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      index += 1;
      continue;
    }

    // Words before the first flag and before the depth limit form the command
    // path; the rest are positional arguments.
    if (path.length < commandDepth && positionals.length === 0) {
      path.push(token);
    } else {
      positionals.push(token);
    }
    index += 1;
  }

  return { path, positionals, flags };
};

/** Thrown when the user asked for something the CLI cannot make sense of. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const flagValue = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

export const flagBool = (args: ParsedArgs, name: string): boolean => args.flags.has(name);

export const flagNumber = (args: ParsedArgs, name: string): number | undefined => {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`Flag --${name} expects a number; got ${raw}.`);
  }
  return parsed;
};
