import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { websocketProxy } from "../src/http.ts";

import { server, closeServers } from "./page-wire.ts";
import { findBlock, readBlock } from "../src/page-document.ts";
afterEach(closeServers);
test("two simultaneous clients edit neighboring blocks without losing text or anchors", async () => {
  const stub = await server();
  for (const anchor of ["left", "right"]) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("id", anchor);
    const text = new Y.XmlText();
    text.insert(0, anchor);
    paragraph.insert(0, [text]);
    stub.fragment.push([paragraph]);
  }
  const a = stub.connect(),
    b = stub.connect();
  await Promise.all([a.ready(), b.ready()]);
  await Promise.all([
    a.write((fragment) => (findBlock(fragment, "left").node.get(0) as Y.XmlText).insert(0, "A ")),
    b.write((fragment) => (findBlock(fragment, "right").node.get(0) as Y.XmlText).insert(0, "B ")),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const fragment of [stub.fragment, a.fragment, b.fragment]) {
    expect(fragment.length).toBe(2);
    expect(readBlock(fragment, "left").markdown).toBe("A left");
    expect(readBlock(fragment, "right").markdown).toBe("B right");
  }
});
test("delivery waits for SyncStatus 8 and a second client receives the same document", async () => {
  const stub = await server(),
    a = stub.connect(),
    b = stub.connect();
  await Promise.all([a.ready(), b.ready()]);
  const result = await a.write((fragment) => fragment.insert(0, [new Y.XmlElement("paragraph")]));
  expect(result).toEqual({ delivery: "acknowledged", persistence: "asynchronous" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stub.fragment.length).toBe(1);
  expect(b.fragment.length).toBe(1);
  expect(stub.updates()).toBe(1);
});
test("disconnect before sending is a definite failure", async () => {
  const stub = await server("before"),
    live = stub.connect();
  await expect(live.ready()).rejects.toThrow("closed");
  expect(stub.updates()).toBe(0);
  expect(stub.connections()).toBe(1);
});
test("disconnect after send before ack reports uncertainty and never reconnects", async () => {
  const stub = await server("uncertain"),
    live = stub.connect();
  await live.ready();
  await expect(
    live.write((fragment) => fragment.insert(0, [new Y.XmlElement("paragraph")])),
  ).rejects.toThrow("delivery is uncertain");
  expect(stub.fragment.length).toBe(1);
  expect(stub.updates()).toBe(1);
  expect(stub.connections()).toBe(1);
});
test("disconnect after ack retains successful delivery", async () => {
  const stub = await server("after"),
    live = stub.connect();
  await live.ready();
  expect(
    (await live.write((fragment) => fragment.insert(0, [new Y.XmlElement("paragraph")]))).delivery,
  ).toBe("acknowledged");
});
test("missing ack times out with uncertainty instead of reporting saved", async () => {
  const stub = await server("no-ack"),
    live = stub.connect();
  await live.ready();
  await expect(
    live.write((fragment) => fragment.insert(0, [new Y.XmlElement("paragraph")])),
  ).rejects.toThrow("uncertain");
});
test("read-only session cannot mutate and a no-op sends no update", async () => {
  const stub = await server("readonly"),
    live = stub.connect();
  await live.ready();
  await expect(
    live.write((fragment) => fragment.insert(0, [new Y.XmlElement("paragraph")])),
  ).rejects.toThrow("does not allow writing");
  expect(stub.updates()).toBe(0);
  const writable = await server(),
    other = writable.connect();
  await other.ready();
  expect((await other.write(() => {})).delivery).toBe("unchanged");
  expect(writable.updates()).toBe(0);
});
test("WebSocket proxy follows HTTPS_PROXY and NO_PROXY", () => {
  const old = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
  try {
    process.env.HTTPS_PROXY = "http://proxy.test:3128";
    process.env.NO_PROXY = "internal.test";
    expect(websocketProxy("wss://plane.test/live")).toBe("http://proxy.test:3128");
    expect(websocketProxy("wss://internal.test/live")).toBeUndefined();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
