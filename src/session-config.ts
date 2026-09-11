import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./args.ts";
import { type Config, type Resolved, readConfigValues } from "./config.ts";
import { guardSecret } from "./output.ts";

export interface SessionConfig extends Config {
  readonly login: Resolved;
  readonly password: Resolved;
  readonly cacheDirectory: string;
}

/** Called only after the server's page capability selects the session path. */
export const resolveSessionConfig = (config: Config, cacheDirectory?: string): SessionConfig => {
  const file = readConfigValues(config.configPath, ["PLANE_LOGIN", "PLANE_PASSWORD"]);
  const value = (key: string): Resolved | undefined => {
    const environment = process.env[key];
    if (environment) return { value: environment, origin: "env" };
    const stored = file.get(key);
    return stored ? { value: stored, origin: "file" } : undefined;
  };
  const login = value("PLANE_LOGIN"),
    password = value("PLANE_PASSWORD");
  if (password) guardSecret(password.value);
  if (!login || !password)
    throw new UsageError(
      `This Plane does not expose the API-key pages endpoint. Set PLANE_LOGIN and PLANE_PASSWORD in the environment or ${config.configPath} to use its session API. If extensions were just installed, retry with --refresh-pages.`,
    );
  return {
    ...config,
    login,
    password,
    cacheDirectory:
      cacheDirectory ??
      process.env.PLANE_SESSION_CACHE ??
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "i-plane", "sessions"),
  };
};
