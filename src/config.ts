/*
 * Configuration resolution.
 *
 * Three sources, highest wins: explicit flags, environment, credentials file.
 * The file is the KEY=VALUE convention used across this machine's services:
 * ~/.config/plane/credentials, mode 600. A wrapper script is expected to set the
 * environment once, so day-to-day calls carry no flags at all.
 *
 * Every resolved value remembers where it came from, so `i-plane config` can
 * explain itself. Debugging "wrong workspace" without that costs more than the
 * bookkeeping does.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./args.ts";

export type Origin = "flag" | "env" | "file" | "default";

export interface Resolved {
  readonly value: string;
  readonly origin: Origin;
}

export interface Config {
  readonly url: Resolved;
  readonly token: Resolved;
  readonly workspace: Resolved;
  readonly configPath: string;
}

export interface ConfigInput {
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly workspace?: string | undefined;
  readonly configPath?: string | undefined;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "plane", "credentials");

/** Reads KEY=VALUE lines. A missing file is not an error: flags or env may cover it. */
const readCredentials = (path: string): Map<string, string> => {
  const entries = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return entries;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (
      ![
        "PLANE_URL",
        "PLANE_BASE_URL",
        "PLANE_API_KEY",
        "PLANE_WORKSPACE",
        "PLANE_WORKSPACE_SLUG",
      ].includes(key)
    )
      continue;
    let value = trimmed.slice(eq + 1).trim();
    // Values may be quoted; the convention does not require it, but tolerate it.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
};

const pick = (
  flag: string | undefined,
  envNames: ReadonlyArray<string>,
  fileKeys: ReadonlyArray<string>,
  file: ReadonlyMap<string, string>,
): Resolved | undefined => {
  if (flag !== undefined && flag !== "") return { value: flag, origin: "flag" };
  for (const name of envNames) {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined && fromEnv !== "") return { value: fromEnv, origin: "env" };
  }
  for (const key of fileKeys) {
    const fromFile = file.get(key);
    if (fromFile !== undefined && fromFile !== "") return { value: fromFile, origin: "file" };
  }
  return undefined;
};

/**
 * Strips a trailing slash so path joining stays predictable, and rejects what is
 * not a URL here rather than deep inside the client: a bad setting is a bad
 * call (exit 2), not a server that refused us (exit 1).
 */
const normalizeUrl = (raw: string, origin: string, path: string): string => {
  const trimmed = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UsageError(
      `The url is not a valid address: ${trimmed}\n` +
        `  it came from ${origin === "file" ? path : origin}\n` +
        "  expected something like https://plane.example.com",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError(`The url must be http or https, got ${parsed.protocol} in ${trimmed}`);
  }
  return trimmed;
};

const missing = (what: string, envName: string, fileKey: string, path: string): UsageError =>
  new UsageError(
    `No ${what}. Set it one of three ways, highest wins:\n` +
      `  --${what} <value>\n` +
      `  ${envName}=<value> in the environment\n` +
      `  ${fileKey}=<value> in ${path}`,
  );

/**
 * Finds the token without validating anything else, so it can be guarded before
 * the first diagnostic is printed. An invalid --url, or the token itself typed
 * as a flag name, produced a usage error that quoted the key back.
 */
export const peekToken = (input: ConfigInput): string | undefined => {
  const configPath = input.configPath ?? process.env.PLANE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const file = readCredentials(configPath);
  return pick(input.token, ["PLANE_API_KEY", "PLANE_TOKEN"], ["PLANE_API_KEY"], file)?.value;
};

export const resolveConfig = (input: ConfigInput, allowMissingToken = false): Config => {
  const configPath = input.configPath ?? process.env.PLANE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const file = readCredentials(configPath);

  // PLANE_BASE_URL is what Plane's own MCP server calls it; accept both so one
  // environment serves either tool.
  const url = pick(
    input.url,
    ["PLANE_URL", "PLANE_BASE_URL"],
    ["PLANE_URL", "PLANE_BASE_URL"],
    file,
  );
  const token = pick(input.token, ["PLANE_API_KEY", "PLANE_TOKEN"], ["PLANE_API_KEY"], file);
  const workspace = pick(
    input.workspace,
    ["PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG"],
    ["PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG"],
    file,
  );

  if (url === undefined) throw missing("url", "PLANE_URL", "PLANE_URL", configPath);
  if (token === undefined && !allowMissingToken)
    throw missing("token", "PLANE_API_KEY", "PLANE_API_KEY", configPath);
  if (workspace === undefined) {
    throw missing("workspace", "PLANE_WORKSPACE", "PLANE_WORKSPACE", configPath);
  }

  return {
    url: { value: normalizeUrl(url.value, url.origin, configPath), origin: url.origin },
    token: token ?? { value: "", origin: "default" },
    workspace,
    configPath,
  };
};

/** Never print a token; show enough to tell two apart. */
export const maskToken = (token: string): string =>
  token.length <= 10 ? "***" : `${token.slice(0, 6)}…${token.slice(-4)}`;
