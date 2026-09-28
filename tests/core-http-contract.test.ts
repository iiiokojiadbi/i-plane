import { expect, test } from "bun:test";
import { coreConfiguration, coreReply, coreBody } from "./helpers/core-http.ts";
import schema from "./fixtures/core/http-0.3.4.json";

test("current HTTP fixtures conform to the locally versioned core shape", () => {
  const configuration = coreConfiguration();
  expect(configuration.coreVersion).toBe(schema.coreVersion);
  expect(coreReply("/api/extensions/configuration/", configuration).status).toBe(200);
  expect(() => coreReply("/api/extensions/configuration/", { release: "partial" })).toThrow("required response field");
  expect(() => coreReply("/api/extensions/node-readers/", {
    schemaVersion: 1, readerApi: 1, coreVersion: "0.3.4", protocolVersion: 1, release: "fixture",
    fingerprint: "a".repeat(64), readers: [{ id: "probe", formatVersion: 1, nodeNames: ["probeNode"] }],
  })).not.toThrow();
});

test("historical and negative fixture classifications are explicit", () => {
  expect(coreReply("/api/extensions/configuration/", { release: "old" }, "historical").status).toBe(200);
  expect(coreReply("/api/extensions/node-readers/", null, "negative").status).toBe(200);
});

test("stored conversion fixtures include the complete core response", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = new URL("./fixtures/pages/", import.meta.url);
  let count = 0;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const fixture = JSON.parse(await readFile(new URL(name, directory), "utf8"));
    if (!fixture.response) continue;
    coreBody("POST /live/convert-document/", fixture.response);
    count++;
  }
  expect(count).toBeGreaterThan(0);
});
