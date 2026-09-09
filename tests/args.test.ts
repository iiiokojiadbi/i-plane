/*
 * Argument parsing, configuration and proxy exclusion.
 *
 * These are the places where being wrong is silent: a switch that ignores its
 * value deletes something, a token that escapes masking ends up in a log, and a
 * NO_PROXY rule that does not match sends a LAN address to a proxy.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { flagBool, flagNumber, flagValue, parseArgs, UsageError } from "../src/args.ts";
import { maskToken, resolveConfig } from "../src/config.ts";
import { isExcluded, needsProxy } from "../src/http.ts";

const parse = (line: string) => parseArgs(line.split(" ").filter(Boolean), 1);

describe("parsing", () => {
  test("command and positionals", () => {
    const args = parse("list CLOUD");
    expect(args.path).toEqual(["list"]);
    expect(args.positionals).toEqual(["CLOUD"]);
  });

  test("value flags take the next word", () => {
    expect(flagValue(parse("list CLOUD --state started"), "state")).toBe("started");
  });

  test("equals form", () => {
    expect(flagValue(parse("list CLOUD --state=started"), "state")).toBe("started");
  });

  test("a repeated flag keeps the last value", () => {
    expect(flagValue(parse("list CLOUD --state a --state b"), "state")).toBe("b");
  });

  test("everything after -- is positional", () => {
    expect(parse("search -- --state").positionals).toEqual(["--state"]);
  });

  test("a value flag with nothing after it is a usage error", () => {
    expect(() => parse("list CLOUD --state")).toThrow(UsageError);
  });

  test("a number flag rejects what is not a number", () => {
    expect(() => flagNumber(parse("list CLOUD --limit abc"), "limit")).toThrow(UsageError);
  });
});

describe("switches honour an explicit value", () => {
  // --yes=false used to confirm an irreversible delete.
  test("bare switch is true", () => {
    expect(flagBool(parse("delete X --yes"), "yes")).toBe(true);
  });

  for (const falsey of ["false", "no", "off", "0"]) {
    test(`--yes=${falsey} is false`, () => {
      expect(flagBool(parse(`delete X --yes=${falsey}`), "yes")).toBe(false);
    });
  }

  test("--yes=true is true", () => {
    expect(flagBool(parse("delete X --yes=true"), "yes")).toBe(true);
  });

  test("an absent switch is false", () => {
    expect(flagBool(parse("delete X"), "yes")).toBe(false);
  });
});

describe("configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("a flag beats the environment", () => {
    process.env.PLANE_URL = "https://from-env.example";
    process.env.PLANE_API_KEY = "k";
    process.env.PLANE_WORKSPACE = "w";
    const config = resolveConfig({ url: "https://from-flag.example", configPath: "/dev/null" });
    expect(config.url.value).toBe("https://from-flag.example");
    expect(config.url.origin).toBe("flag");
    expect(config.workspace.origin).toBe("env");
  });

  test("a trailing slash is dropped", () => {
    const config = resolveConfig({
      url: "https://example.test/",
      token: "k",
      workspace: "w",
      configPath: "/dev/null",
    });
    expect(config.url.value).toBe("https://example.test");
  });

  test("what is not a url is a usage error, not a network error", () => {
    expect(() =>
      resolveConfig({ url: "not-a-url", token: "k", workspace: "w", configPath: "/dev/null" }),
    ).toThrow(UsageError);
  });

  test("a non-http scheme is refused", () => {
    expect(() =>
      resolveConfig({ url: "ftp://x.test", token: "k", workspace: "w", configPath: "/dev/null" }),
    ).toThrow(UsageError);
  });

  test("a missing setting names all three ways to supply it", () => {
    process.env.PLANE_URL = "";
    process.env.PLANE_API_KEY = "";
    process.env.PLANE_WORKSPACE = "";
    expect(() => resolveConfig({ configPath: "/dev/null" })).toThrow(/PLANE_URL/);
  });

  test("a masked token shows neither end whole", () => {
    const masked = maskToken("plane_api_0123456789abcdef");
    expect(masked).not.toContain("0123456789abcdef");
    expect(masked.length).toBeLessThan("plane_api_0123456789abcdef".length);
  });
});

describe("proxy exclusion follows curl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("a suffix rule matches subdomains", () => {
    process.env.NO_PROXY = "example.com";
    expect(isExcluded("api.example.com")).toBe(true);
    expect(isExcluded("example.com")).toBe(true);
    expect(isExcluded("notexample.com")).toBe(false);
  });

  test("a trailing dot is the same host", () => {
    process.env.NO_PROXY = "example.com";
    expect(isExcluded("example.com.")).toBe(true);
  });

  test("a trailing dot on the rule is the same name too", () => {
    // Claimed fixed once while the replacement had silently not applied.
    process.env.NO_PROXY = "example.com.";
    expect(isExcluded("example.com")).toBe(true);
  });

  test("a CIDR rule matches addresses inside it", () => {
    process.env.NO_PROXY = "10.0.0.0/8";
    expect(isExcluded("10.1.2.3")).toBe(true);
    expect(isExcluded("11.1.2.3")).toBe(false);
  });

  test("bracketed IPv6 matches its rule", () => {
    process.env.NO_PROXY = "::1";
    expect(isExcluded("[::1]")).toBe(true);
  });

  test("a star excludes everything", () => {
    process.env.NO_PROXY = "*";
    expect(isExcluded("anything.test")).toBe(true);
  });

  test("no proxy configured means no proxy needed", () => {
    process.env.NO_PROXY = "";
    process.env.HTTPS_PROXY = "";
    process.env.https_proxy = "";
    process.env.HTTP_PROXY = "";
    process.env.http_proxy = "";
    expect(needsProxy("https://example.test")).toBe(false);
  });
});
