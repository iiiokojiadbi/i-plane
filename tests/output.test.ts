/*
 * The secret guard, tested through what actually reaches a stream.
 *
 * The previous suite called scrub() directly, so removing the scrub from emit,
 * fail and warn broke nothing that any test could see. These capture the writes
 * themselves — the only thing that matters, since the guard exists to keep the
 * token out of a terminal and a log.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { emit, guardSecret, printValue, warn } from "../src/output.ts";
import { formatListing } from "../src/commands/issues.ts";

const TOKEN = "synthetic_token_abcdefghijklmnop";

/** Captures everything written to a stream during one call. */
const captured = (stream: "stdout" | "stderr", run: () => void): string => {
  const target = process[stream];
  const original = target.write.bind(target);
  let text = "";
  target.write = ((chunk: string) => {
    text += String(chunk);
    return true;
  }) as typeof target.write;
  try {
    run();
  } finally {
    target.write = original;
  }
  return text;
};

afterEach(() => {
  guardSecret("");
});

describe("nothing printed carries the token", () => {
  test("emit scrubs stdout", () => {
    guardSecret(TOKEN);
    const text = captured("stdout", () => emit(`key is ${TOKEN} here`));
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[token]");
  });

  test("warn scrubs stderr", () => {
    guardSecret(TOKEN);
    const text = captured("stderr", () => warn(`created, but ${TOKEN} failed`));
    expect(text).not.toContain(TOKEN);
  });

  test("--json output is scrubbed when a server echoes the key back", () => {
    guardSecret(TOKEN);
    const text = captured("stdout", () =>
      printValue({ id: "me", echo: TOKEN }, true, () => "unused"),
    );
    expect(text).not.toContain(TOKEN);
  });

  test("formatting cannot truncate the token past the guard", () => {
    /*
     * The formatter truncates long titles. Scrubbing only the finished string
     * left twenty-six characters of the key followed by an ellipsis, because
     * half a token no longer matches the whole one.
     */
    guardSecret(TOKEN);
    const row = {
      ref: "X-1",
      name: `${"y".repeat(45)}${TOKEN}`,
      state: "Todo",
      group: "unstarted",
      priority: "none",
      id: "i",
    };
    const text = captured("stdout", () => printValue({ rows: [row], total: 1 }, false, formatListing));
    expect(text).not.toContain(TOKEN.slice(0, 16));
  });

  test("a token split across whitespace is still caught", () => {
    guardSecret(`${TOKEN}\ntail`);
    const text = captured("stdout", () => emit(`header value ${TOKEN} rejected`));
    expect(text).not.toContain(TOKEN);
  });

  test("with no secret registered, text passes through unchanged", () => {
    const text = captured("stdout", () => emit("nothing to hide"));
    expect(text.trim()).toBe("nothing to hide");
  });
});
