import { expect, test } from "bun:test";
import { connectionRoute, isConnectionDenied } from "../src/http.ts";

test("the selected proxy is reported without its credentials or query", () => {
  const before = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
  try {
    process.env.HTTPS_PROXY = "http://user:secret@proxy.test:3128/?token=secret";
    process.env.NO_PROXY = "";
    expect(connectionRoute("https://plane.test")).toBe("through proxy http://proxy.test:3128");
    process.env.NO_PROXY = "plane.test";
    expect(connectionRoute("https://plane.test")).toBe("directly");
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("permission diagnosis handles nested and aggregate errors without looping", () => {
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  expect(
    isConnectionDenied(new TypeError("fetch failed", { cause: new AggregateError([denied]) })),
  ).toBe(true);
  expect(isConnectionDenied(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(
    false,
  );
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isConnectionDenied(cycle)).toBe(false);
});
