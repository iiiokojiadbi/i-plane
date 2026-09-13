import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type PageMode = "api-key" | "session";
export type DetectionReason = "public-list" | "missing-route" | "extension-disabled";
export interface NodeReaderCapability {
  runtimeIdentity: string;
  nodes: string[];
  checkedAt: number;
  expiresAt: number;
}
export interface PageCapability {
  version: 1;
  mode: PageMode;
  reason: DetectionReason;
  checkedAt: number;
  expiresAt: number;
  runtime: boolean;
  keyProbe: boolean;
  nodeReaders?: NodeReaderCapability;
}
// Bound stale server capabilities after an upgrade without probing every command.
export const PAGE_CAPABILITY_TTL = 5 * 60 * 1000;
export const pageCacheDirectory = (): string =>
  process.env.PLANE_PAGE_CACHE ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "i-plane", "page-transports");
export class PageCapabilityCache {
  readonly path: string;
  readonly directory: string;
  private readonly now: () => number;
  constructor(url: string, directory = pageCacheDirectory(), now = Date.now) {
    this.directory = directory;
    this.now = now;
    this.path = join(
      directory,
      `${createHash("sha256").update(new URL(url).href.replace(/\/+$/, "")).digest("hex")}.json`,
    );
  }
  async read(): Promise<PageCapability | undefined> {
    try {
      const file = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 16384 || info.mode & 0o077) return undefined;
        const value = JSON.parse(await file.readFile("utf8")) as PageCapability;
        const now = this.now();
        if (
          value.version !== 1 ||
          !["api-key", "session"].includes(value.mode) ||
          !["public-list", "missing-route", "extension-disabled"].includes(value.reason) ||
          typeof value.runtime !== "boolean" ||
          typeof value.keyProbe !== "boolean" ||
          !Number.isFinite(value.checkedAt) ||
          !Number.isFinite(value.expiresAt) ||
          value.checkedAt > now ||
          value.expiresAt <= now ||
          value.expiresAt !== value.checkedAt + PAGE_CAPABILITY_TTL
        )
          return undefined;
        if ((value.mode === "api-key") !== (value.reason === "public-list")) return undefined;
        const readers = value.nodeReaders;
        if (
          readers &&
          (typeof readers.runtimeIdentity !== "string" ||
            readers.runtimeIdentity.length > 1024 ||
            !Array.isArray(readers.nodes) ||
            readers.nodes.length > 128 ||
            !readers.nodes.every(
              (name) => typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(name),
            ) ||
            !Number.isFinite(readers.checkedAt) ||
            readers.checkedAt > now ||
            readers.expiresAt <= now ||
            readers.expiresAt !== readers.checkedAt + PAGE_CAPABILITY_TTL)
        )
          delete value.nodeReaders;
        return value;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }
  async clear(): Promise<boolean> {
    try {
      await unlink(this.path);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === "ENOENT";
    }
  }
  async write(
    mode: PageMode,
    reason: DetectionReason,
    runtime: boolean,
    keyProbe: boolean,
    nodeReaders?: NodeReaderCapability,
  ): Promise<PageCapability> {
    const checkedAt = this.now();
    const value: PageCapability = {
      version: 1,
      mode,
      reason,
      runtime,
      keyProbe,
      checkedAt,
      expiresAt: checkedAt + PAGE_CAPABILITY_TTL,
      ...(nodeReaders ? { nodeReaders } : {}),
    };
    return this.persist(value);
  }
  async writeNodeReaders(
    selection: PageCapability,
    nodeReaders: NodeReaderCapability,
  ): Promise<PageCapability> {
    return this.persist({ ...selection, nodeReaders });
  }
  private async persist(value: PageCapability): Promise<PageCapability> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return value;
      await chmod(this.directory, 0o700);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } catch {
      /* Capability caching is an optimization, not a prerequisite for access. */
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return value;
  }
}
export const pageTransportReport = async (url: string, refresh = false) => {
  const cache = new PageCapabilityCache(url);
  const cleared = refresh ? await cache.clear() : false;
  const value = cleared ? undefined : await cache.read();
  const reasons: Record<DetectionReason, string> = {
    "public-list": "The public project-page list accepted an API key.",
    "missing-route": "The public page route and extension configuration were absent.",
    "extension-disabled": "The instance reports that API-key pages are unavailable.",
  };
  return {
    mode: value?.mode ?? "unknown",
    reason:
      refresh && !cleared
        ? "Could not clear the capability cache. Use --refresh-pages on the page command to bypass it."
        : value
          ? value.mode === "session" && !value.keyProbe
            ? "No API key was configured and the instance did not advertise API-key pages."
            : reasons[value.reason]
          : refresh
            ? "Cached selection cleared; the next page command will detect access again."
            : "No fresh selection is cached; the next page command will detect access automatically.",
    checkedAt: value ? new Date(value.checkedAt).toISOString() : null,
    expiresAt: value ? new Date(value.expiresAt).toISOString() : null,
    cachePath: cache.path,
  };
};
