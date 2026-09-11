import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import { LiveDocument } from "../src/page-live.ts";
// Minimal wire fixture for the pinned provider's auth, Yjs sync and SyncStatus 8.
const integer = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const digit = value & 127;
    value = Math.floor(value / 128);
    bytes.push(digit | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const bytes = (value: Uint8Array): number[] => [...integer(value.length), ...value];
const string = (value: string): number[] => bytes(Buffer.from(value));
const packet = (name: string, ...payload: number[][]) =>
  Uint8Array.from([...string(name), ...payload.flat()]);
const reader = (data: Uint8Array) => {
  let offset = 0;
  const uint = () => {
    let result = 0,
      shift = 0,
      byte: number;
    do {
      byte = data[offset++]!;
      result += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return result;
  };
  const buffer = () => {
    const size = uint(),
      out = data.slice(offset, offset + size);
    offset += size;
    return out;
  };
  return { uint, buffer, string: () => Buffer.from(buffer()).toString() };
};
const cleanups: Array<() => void> = [];
export const closeServers = () => {
  for (const close of cleanups.splice(0).reverse()) close();
};
export const server = async (
  mode: "normal" | "before" | "uncertain" | "after" | "readonly" | "no-ack" | "denied" = "normal",
) => {
  const doc = new Y.Doc(),
    fragment = doc.getXmlFragment("default");
  let connections = 0,
    updates = 0;
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const authentications: Array<{ url: string; token: string }> = [];
  const names = new Map<WebSocket, string>();
  wss.on("connection", (socket, request) => {
    connections++;
    if (mode === "before") {
      socket.close();
      return;
    }
    socket.on("message", (raw) => {
      const r = reader(new Uint8Array(raw as Buffer)),
        name = r.string(),
        kind = r.uint();
      names.set(socket, name);
      if (kind === 2) {
        r.uint();
        const token = r.string();
        authentications.push({ url: request.url ?? "", token });
        if (mode === "denied") {
          socket.send(packet(name, [2, 1], string("Rejected")));
          return;
        }
        socket.send(packet(name, [2, 2], string(mode === "readonly" ? "readonly" : "read-write")));
        return;
      }
      if (kind !== 0) return;
      const step = r.uint(),
        payload = r.buffer();
      if (step === 0) {
        socket.send(packet(name, [0, 1], bytes(Y.encodeStateAsUpdate(doc, payload))));
        socket.send(packet(name, [0, 0], bytes(Y.encodeStateVector(doc))));
      } else {
        Y.applyUpdate(doc, payload);
        if (step === 2) {
          updates++;
          for (const peer of wss.clients)
            if (peer !== socket) peer.send(packet(names.get(peer) ?? name, [0, 2], bytes(payload)));
        }
        if (step === 2 && mode === "uncertain") {
          socket.close();
          return;
        }
        if (step === 2 && mode === "no-ack") return;
        socket.send(packet(name, [8, 1]));
        if (step === 2 && mode === "after") socket.close();
      }
    });
  });
  cleanups.push(() => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    doc.destroy();
  });
  const port = (wss.address() as { port: number }).port;
  const connect = () => {
    const before = process.env.NO_PROXY;
    process.env.NO_PROXY = "*";
    try {
      const live = new LiveDocument(
        `ws://127.0.0.1:${port}/live/collaboration?documentType=project_page&projectId=p&workspaceSlug=w`,
        "page",
        '{"apiKey":"api-secret"}',
        500,
      );
      cleanups.push(() => live.destroy());
      return live;
    } finally {
      if (before === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = before;
    }
  };
  return {
    connect,
    authentications,
    fragment,
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    updates: () => updates,
  };
};
