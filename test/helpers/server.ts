/**
 * A real `node:http` flag server for tests.
 *
 * Integration tests drive the client through an actual socket instead of a
 * stubbed `fetch`, because `ETag` revalidation, bodyless 304s and
 * `AbortController` timeouts are exactly the places where a hand-written
 * `fetch` double would encode our assumptions rather than test them
 * (`docs/design.md` §7).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly ifNoneMatch: string | undefined;
}

/** Responds to one request. `hit` is 1-based. */
export type FlagHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  hit: number,
) => void | Promise<void>;

/** A flag document shaped like the live service's. */
export type Document = Record<string, unknown>;

export const SAMPLE_DOCUMENT: Document = {
  Project: "test-project",
  Environment: "production",
  Version: 1,
  NotifySlack: true,
  Flags: {
    alpha: {
      Enabled: true,
      Description: "on",
      CreatedAt: "2026-07-31T14:09:01.119Z",
      UpdatedAt: "2026-07-31T14:09:08.777Z",
      UpdatedBy: "Omicron7",
    },
    beta: { Enabled: false, Description: "off" },
  },
};

export class FlagServer {
  readonly requests: RecordedRequest[] = [];

  #server: Server;
  #handler: FlagHandler;
  #hits = 0;

  constructor(handler: FlagHandler) {
    this.#handler = handler;
    this.#server = createServer((request, response) => {
      this.#hits += 1;
      this.requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        ifNoneMatch: header(request, "if-none-match"),
      });
      void (async () => {
        try {
          await this.#handler(request, response, this.#hits);
        } catch {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
      })();
    });
  }

  static async start(handler: FlagHandler): Promise<FlagServer> {
    const server = new FlagServer(handler);
    await server.#listen();
    return server;
  }

  /** URL of the flag document, shaped like the real service's paths. */
  get url(): string {
    const address = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/flags/test-project/production`;
  }

  get hits(): number {
    return this.#hits;
  }

  /** Swap the responder mid-test (e.g. start failing, then recover). */
  serve(handler: FlagHandler): void {
    this.#handler = handler;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  async #listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
  }
}

/**
 * Serve `document` with an `ETag` derived from its `Version`, honouring
 * `If-None-Match` with a real 304 — same contract as the live service.
 */
export function serveDocument(document: Document): FlagHandler {
  const body = JSON.stringify(document);
  const version = document["Version"];
  const etag = `"${typeof version === "number" ? version : 0}"`;
  return (request, response) => {
    if (header(request, "if-none-match") === etag) {
      response.writeHead(304, { etag, "cache-control": "no-cache" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      etag,
      "cache-control": "no-cache",
    });
    response.end(body);
  };
}

/** Serve a fixed status and body (used for 404 / 400 / 500 cases). */
export function serveStatus(status: number, body = ""): FlagHandler {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  };
}

/** Serve a 200 whose body is not a usable flag document. */
export function serveBody(body: string, etag = '"99"'): FlagHandler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", etag });
    response.end(body);
  };
}

/** Accept the request and never answer — for timeout tests. */
export function serveHang(): FlagHandler {
  return () => {
    // Intentionally no response: the client must abort on its own.
  };
}

/**
 * Stream `totalBytes` (deliberately more than the client's body cap) at
 * `status`, writing in small chunks and honouring backpressure. `writtenBytes`
 * reports how much actually made it onto the wire before the connection died
 * underneath the server — the only way to tell an aborted, streamed read from
 * one `fetch` buffered in full before objecting (`docs/design.md` §4.9).
 */
export function serveOversized(
  status: number,
  totalBytes: number,
): { handler: FlagHandler; writtenBytes: () => number } {
  let written = 0;
  const chunk = Buffer.alloc(64 * 1024, "x");

  const handler: FlagHandler = async (request, response) => {
    // A client that aborts mid-stream turns further writes into ECONNRESET /
    // EPIPE; that is the point of this helper, not a test failure. One
    // persistent listener per event (rather than one per backpressure wait)
    // so a long stall before the abort lands doesn't trip Node's
    // max-listeners warning.
    let closed = false;
    let signalClosed = (): void => {
      closed = true;
    };
    const closedSignal = new Promise<void>((resolve) => {
      signalClosed = () => {
        closed = true;
        resolve();
      };
    });
    response.on("error", signalClosed);
    response.on("close", signalClosed);
    request.socket.on("error", () => undefined);

    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(totalBytes),
    });

    try {
      while (written < totalBytes && !closed) {
        const size = Math.min(chunk.length, totalBytes - written);
        const piece = size === chunk.length ? chunk : chunk.subarray(0, size);
        const ok = response.write(piece);
        written += size;
        if (!ok && !closed) {
          await Promise.race([
            new Promise<void>((resolve) => response.once("drain", resolve)),
            closedSignal,
          ]);
        }
      }
      if (!closed) response.end();
    } catch {
      // The client hung up before the full body went out — expected.
    }
  };

  return { handler, writtenBytes: () => written };
}

export function header(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Wait `ms` in real time. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
