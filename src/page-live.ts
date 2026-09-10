import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import * as Y from "yjs";
import { PlaneError } from "./client.ts";
import { websocketProxy } from "./http.ts";
import { guardSecret, scrub } from "./output.ts";
import { cookieHeader, type SessionClient } from "./session.ts";

export interface Delivery {
  delivery: "acknowledged" | "unchanged";
  persistence: "asynchronous";
}
class AuthenticationError extends PlaneError {}
interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** One connection, one mutation, no reconnect or command replay. */
export class LiveDocument {
  readonly doc = new Y.Doc();
  readonly fragment = this.doc.getXmlFragment("default");
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  private agent?: HttpsProxyAgent<string>;
  private pending?: Pending;
  private failure?: Error;
  private writing = false;
  private acknowledged = false;
  private disposed = false;
  private readonly deadline: number;

  constructor(url: string, pageId: string, token: string, deadline = 20000) {
    this.deadline = deadline;
    guardSecret(token);
    const proxy = websocketProxy(url);
    if (proxy) {
      guardSecret(proxy);
      this.agent = new HttpsProxyAgent(proxy);
    }
    const agent = this.agent;
    class RoutedWebSocket extends WebSocket {
      constructor(address: string) {
        super(address, { agent, handshakeTimeout: deadline });
      }
    }
    this.socket = new HocuspocusProviderWebsocket({
      url,
      WebSocketPolyfill: RoutedWebSocket,
      autoConnect: false,
      maxAttempts: 1,
      onClose: () => this.fail(new PlaneError("Live connection closed.")),
    });
    this.socket.on("maxAttemptsFailed", () =>
      this.fail(new PlaneError("Cannot connect to the live server.")),
    );
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: pageId,
      document: this.doc,
      awareness: null,
      token,
      forceSyncInterval: false,
      flushDelay: false,
      onClose: () => this.fail(new PlaneError("Live document connection closed.")),
      onSynced: () => this.progress(),
      onUnsyncedChanges: () => this.progress(),
      onAuthenticationFailed: () =>
        this.fail(new AuthenticationError("Live authentication was refused.")),
    });
    this.provider.attach();
  }

  private progress(): void {
    if (
      this.disposed ||
      this.failure ||
      !this.provider?.isSynced ||
      this.provider.hasUnsyncedChanges
    )
      return;
    if (this.writing) this.acknowledged = true;
    this.pending?.resolve();
  }

  private fail(error: Error): void {
    if (this.disposed || this.failure) return;
    if (this.writing && !this.acknowledged)
      error = new PlaneError(
        "Live connection failed after sending changes; delivery is uncertain. Inspect the live document before retrying. The command was not replayed.",
      );
    this.failure = error;
    this.socket.shouldConnect = false;
    this.pending?.reject(error);
  }

  private async wait(start: () => void): Promise<void> {
    if (this.failure) throw this.failure;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending = { resolve, reject };
        timer = setTimeout(
          () => this.fail(new PlaneError("Live synchronization timed out.")),
          this.deadline,
        );
        start();
        this.progress();
      });
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }

  async ready(): Promise<void> {
    await this.wait(() => {
      void this.socket
        .connect()
        .catch(() => this.fail(new PlaneError("Cannot connect to the live server.")));
    });
  }

  async write(change: (fragment: Y.XmlFragment) => void): Promise<Delivery> {
    if (this.failure) throw this.failure;
    if (!this.provider.isSynced) throw new PlaneError("Live document is not synchronized.");
    if (this.provider.authorizedScope !== "read-write")
      throw new PlaneError("The live session does not allow writing this page.");
    let changed = false;
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === this) changed = true;
    };
    this.doc.on("update", onUpdate);
    try {
      await this.wait(() => {
        this.writing = true;
        this.doc.transact(() => change(this.fragment), this);
      });
      return { delivery: changed ? "acknowledged" : "unchanged", persistence: "asynchronous" };
    } finally {
      this.doc.off("update", onUpdate);
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.provider.destroy();
    this.socket.destroy();
    this.agent?.destroy();
    this.doc.destroy();
  }
}

export const openLive = async (
  client: SessionClient,
  projectId: string,
  pageId: string,
): Promise<LiveDocument> => {
  const url = new URL(`${client.config.url.value}/live/collaboration`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("documentType", "project_page");
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("workspaceSlug", client.config.workspace.value);
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await client.session(attempt === 1);
    const live = new LiveDocument(
      url.href,
      pageId,
      JSON.stringify({ id: session.userId, cookie: cookieHeader(session) }),
    );
    try {
      await live.ready();
      return live;
    } catch (error) {
      live.destroy();
      if (attempt === 0 && error instanceof AuthenticationError) continue;
      throw new PlaneError(scrub(error instanceof Error ? error.message : String(error)));
    }
  }
  throw new PlaneError("Live authentication failed.");
};
