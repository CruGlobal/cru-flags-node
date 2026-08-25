/**
 * The behavioural contract from `docs/design.md` §2–§5, one test per line.
 * Every test drives the client through a real socket (see helpers/server.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CruFlags, MAX_BODY_BYTES } from "../src/client.js";
import type { FlagsError } from "../src/errors.js";
import type { FlagsHealthEvent } from "../src/types.js";
import {
  FlagServer,
  SAMPLE_DOCUMENT,
  serveBody,
  serveDocument,
  serveHang,
  serveOversized,
  serveStatus,
  sleep,
  type FlagHandler,
} from "./helpers/server.js";

let server: FlagServer;
let events: FlagsHealthEvent[];
const clients: CruFlags[] = [];

/** A client wired to the test server, closed automatically after each test. */
function makeClient(
  options: { pollSeconds?: number; fetchTimeoutMs?: number } = {},
): CruFlags {
  const client = new CruFlags({
    url: server.url,
    // Big enough by default that the poll loop only advances when a test
    // explicitly asks for another tick.
    pollSeconds: options.pollSeconds ?? 60,
    fetchTimeoutMs: options.fetchTimeoutMs ?? 1000,
    onError: (event) => events.push(event),
  });
  clients.push(client);
  return client;
}

/** Wait until `predicate` holds, or fail the test. */
async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Optionally change what the server serves, then wait for one more poll. */
async function nextPoll(handler?: FlagHandler): Promise<void> {
  if (handler) server.serve(handler);
  const before = server.hits;
  await until(() => server.hits > before, "the next poll");
}

/** Assert an event is a failure and return its error. */
function failure(event: FlagsHealthEvent | undefined): FlagsError {
  if (event?.kind !== "failing") {
    throw new Error(`expected a failing event, got ${JSON.stringify(event)}`);
  }
  return event.error;
}

const kinds = (): string[] => events.map((event) => event.kind);

beforeEach(async () => {
  events = [];
  server = await FlagServer.start(serveDocument(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server.stop();
  vi.restoreAllMocks();
});

describe("lazy start", () => {
  it("does not fetch at construction", async () => {
    makeClient();

    await sleep(50);

    expect(server.hits).toBe(0);
  });

  it("starts on the first enabled() call", async () => {
    const client = makeClient();

    expect(client.enabled("alpha")).toBe(false); // nothing fetched yet
    await client.ready();

    expect(server.hits).toBe(1);
    expect(client.enabled("alpha")).toBe(true);
  });

  it("starts on the first ready() call", async () => {
    const client = makeClient();

    await client.ready();

    expect(server.hits).toBe(1);
  });

  it("starts only once, however many calls arrive", async () => {
    const client = makeClient();

    client.enabled("alpha");
    client.enabled("beta");
    client.snapshot();
    await client.ready();
    await client.ready();

    expect(server.hits).toBe(1);
  });

  it("returns the same ready() promise every time", () => {
    const client = makeClient();

    expect(client.ready()).toBe(client.ready());
  });
});

describe("enabled()", () => {
  it("is true only for Enabled === true", async () => {
    const client = makeClient();
    await client.ready();

    expect(client.enabled("alpha")).toBe(true);
    expect(client.enabled("beta")).toBe(false);
    expect(client.enabled("never-heard-of-it")).toBe(false);
    expect(client.enabled("")).toBe(false);
  });

  it("does not throw on a dead endpoint", async () => {
    const client = new CruFlags({
      url: "http://127.0.0.1:1/flags/nope/production",
      pollSeconds: 60,
      onError: (event) => events.push(event),
    });
    clients.push(client);

    expect(client.enabled("alpha")).toBe(false);
    await client.ready();

    expect(client.enabled("alpha")).toBe(false);
    expect(kinds()).toEqual(["failing"]);
  });

  it("does not confuse prototype members with flags", async () => {
    server.serve(serveBody(JSON.stringify({ Flags: {} }), '"1"'));
    const client = makeClient();
    await client.ready();

    expect(client.enabled("toString")).toBe(false);
    expect(client.enabled("constructor")).toBe(false);
    expect(client.enabled("__proto__")).toBe(false);
  });
});

describe("snapshot", () => {
  it("exposes the frozen document and round-trips through JSON", async () => {
    const client = makeClient();
    await client.ready();

    const snapshot = client.snapshot();

    expect(snapshot).not.toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(SAMPLE_DOCUMENT);
  });

  it("is null before the first successful fetch", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient();

    expect(client.snapshot()).toBeNull();
    await client.ready();

    expect(client.snapshot()).toBeNull();
  });
});

describe("ETag revalidation", () => {
  it("sends If-None-Match with the stored ETag", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    await nextPoll();

    expect(server.requests[0]?.ifNoneMatch).toBeUndefined();
    expect(server.requests[1]?.ifNoneMatch).toBe('"1"');
  });

  it("keeps the very same snapshot object on a 304", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    const first = client.snapshot();
    await nextPoll();
    await nextPoll();

    // A 200 always installs a *new* frozen object, so identity is proof that
    // the 304 was honoured rather than the body re-parsed.
    expect(client.snapshot()).toBe(first);
    expect(client.enabled("alpha")).toBe(true);
    expect(events).toEqual([]);
  });

  it("installs the new document when the ETag changes", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    const first = client.snapshot();

    await nextPoll(
      serveDocument({
        ...SAMPLE_DOCUMENT,
        Version: 2,
        Flags: { alpha: { Enabled: false }, gamma: { Enabled: true } },
      }),
    );
    await until(() => client.snapshot()?.Version === 2, "the new document");

    expect(client.snapshot()).not.toBe(first);
    expect(client.enabled("alpha")).toBe(false);
    expect(client.enabled("gamma")).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("404 — no document yet", () => {
  it("is not an error and does not call onError", async () => {
    server.serve(
      serveStatus(
        404,
        '{"message":"x has no feature flags in production yet."}',
      ),
    );
    const client = makeClient();

    await client.ready();

    expect(client.enabled("alpha")).toBe(false);
    expect(client.snapshot()).toBeNull();
    expect(events).toEqual([]);
  });

  it("empties a previously loaded snapshot", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(client.enabled("alpha")).toBe(true);

    await nextPoll(serveStatus(404, '{"message":"gone"}'));
    await until(() => client.snapshot() === null, "the snapshot to empty");

    expect(client.enabled("alpha")).toBe(false);
    expect(events).toEqual([]);
  });

  it("counts as recovery after a failure", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(kinds()).toEqual(["failing"]);

    await nextPoll(serveStatus(404, "{}"));
    await until(() => events.length >= 2, "a recovery event");

    expect(kinds()).toEqual(["failing", "recovered"]);
  });

  it("drops the stored ETag so the next poll asks fresh", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    await nextPoll(serveStatus(404, "{}"));
    await until(() => client.snapshot() === null, "the snapshot to empty");
    await nextPoll();

    expect(lastRequest().ifNoneMatch).toBeUndefined();
  });
});

describe("fail-static", () => {
  it("serves everything false before the first success", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient();

    await client.ready();

    expect(client.enabled("alpha")).toBe(false);
  });

  it("keeps the last-known-good document through repeated failures", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    const good = client.snapshot();

    server.serve(serveStatus(503, "unavailable"));
    const before = server.hits;
    await until(() => server.hits > before + 3, "several failed polls");

    expect(client.enabled("alpha")).toBe(true);
    expect(client.snapshot()).toBe(good);
    // …and exactly one report for the whole outage.
    expect(kinds()).toEqual(["failing"]);
  });

  it("keeps the last-known-good document through timeouts", async () => {
    const client = makeClient({ pollSeconds: 0.05, fetchTimeoutMs: 60 });
    await client.ready();

    await nextPoll(serveHang());
    await until(() => events.length > 0, "a timeout report");

    expect(client.enabled("alpha")).toBe(true);
    expect(failure(events[0]).code).toBe("timeout");
    expect(failure(events[0]).message).toContain("60ms");
  });

  it("recovers once the service comes back", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();

    await nextPoll(serveDocument(SAMPLE_DOCUMENT));
    await until(() => client.enabled("alpha"), "the flags to load");

    expect(kinds()).toEqual(["failing", "recovered"]);
  });
});

describe("bad responses", () => {
  it("reports an unparsable 200 as a parse failure", async () => {
    server.serve(serveBody("not json at all"));
    const client = makeClient();

    await client.ready();

    expect(client.snapshot()).toBeNull();
    expect(events).toHaveLength(1);
    expect(failure(events[0]).code).toBe("parse");
  });

  it("does not store the ETag of a body it rejected", async () => {
    // Otherwise every later poll 304s and the client stays pinned forever to
    // a response it refused to parse (`docs/design.md` §2.1).
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(client.enabled("alpha")).toBe(true);

    await nextPoll(serveBody("}{ truncated", '"7"'));
    await until(() => events.length > 0, "the parse failure");
    await nextPoll();

    expect(lastRequest().ifNoneMatch).toBe('"1"');
    // Fail-static: the good document is still in effect.
    expect(client.enabled("alpha")).toBe(true);
  });

  it("carries the HTTP status and a body excerpt on the error", async () => {
    server.serve(
      serveStatus(400, '{"message":"\\"nope\\" has no feature flags."}'),
    );
    const client = makeClient();

    await client.ready();

    const error = failure(events[0]);
    expect(error.code).toBe("http");
    expect(error.status).toBe(400);
    expect(error.message).toContain("400");
    expect(error.message).toContain("no feature flags");
  });

  it("reports a connection failure as a network error", async () => {
    const client = new CruFlags({
      url: "http://127.0.0.1:1/flags/x/production",
      onError: (event) => events.push(event),
    });
    clients.push(client);

    await client.ready();

    expect(failure(events[0]).code).toBe("network");
  });
});

describe("response body cap", () => {
  // Deliberately several times MAX_BODY_BYTES: proves the read was aborted,
  // not merely slow. If the client buffered the whole thing before checking
  // the size, `writtenBytes()` would equal `declared`.
  const declared = MAX_BODY_BYTES * 8;

  it("fails a 200 whose body exceeds the cap, without buffering it whole", async () => {
    const { handler, writtenBytes } = serveOversized(200, declared);
    server.serve(handler);
    const client = makeClient();

    await client.ready();

    expect(client.snapshot()).toBeNull();
    expect(events).toHaveLength(1);
    const error = failure(events[0]);
    expect(error.code).toBe("parse");
    expect(error.message).toContain(`${MAX_BODY_BYTES}`);
    expect(writtenBytes()).toBeLessThan(declared);
  });

  it("keeps the last-known-good document (fail-static) after an oversized 200", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(client.enabled("alpha")).toBe(true);

    const { handler } = serveOversized(200, declared);
    await nextPoll(handler);
    await until(() => events.length > 0, "the cap failure");

    expect(client.enabled("alpha")).toBe(true);
    expect(kinds()).toEqual(["failing"]);
  });

  it("does not store an ETag for a body it never finished reading", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(client.enabled("alpha")).toBe(true);

    await nextPoll(serveOversized(200, declared).handler);
    await until(() => events.length > 0, "the cap failure");
    await nextPoll();

    expect(lastRequest().ifNoneMatch).toBe('"1"');
  });

  it("preserves a non-200 status's own outcome when its body exceeds the cap", async () => {
    const { handler, writtenBytes } = serveOversized(500, declared);
    server.serve(handler);
    const client = makeClient();

    await client.ready();

    const error = failure(events[0]);
    expect(error.code).toBe("http");
    expect(error.status).toBe(500);
    expect(writtenBytes()).toBeLessThan(declared);
  });

  it("recovers once the service serves a body under the cap again", async () => {
    const { handler } = serveOversized(200, declared);
    server.serve(handler);
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(kinds()).toEqual(["failing"]);

    await nextPoll(serveDocument(SAMPLE_DOCUMENT));
    await until(() => client.enabled("alpha"), "recovery");

    expect(kinds()).toEqual(["failing", "recovered"]);
  });
});

describe("polling", () => {
  it("does not retry inside a single tick", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient({ pollSeconds: 60 });

    await client.ready();
    await sleep(100);

    expect(server.hits).toBe(1);
  });

  it("stops polling after close()", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    await nextPoll();

    client.close();
    const after = server.hits;
    await sleep(200);

    expect(server.hits).toBe(after);
  });

  it("stays inert if close() lands before the first read", async () => {
    const client = makeClient();

    client.close();

    expect(client.enabled("alpha")).toBe(false);
    await expect(client.ready()).resolves.toBeUndefined();
    expect(server.hits).toBe(0);
  });
});

describe("health reporting", () => {
  it("reports a transition once, not once per poll", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient({ pollSeconds: 0.03 });
    await client.ready();

    await until(() => server.hits >= 5, "five failing polls");

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("failing");
    expect(events[0]?.url).toBe(server.url);
  });

  it("reports failing → recovered → failing as three events", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = makeClient({ pollSeconds: 0.03 });
    await client.ready();

    await nextPoll(serveDocument(SAMPLE_DOCUMENT));
    await until(() => client.enabled("alpha"), "recovery");
    await nextPoll(serveStatus(500, "boom again"));
    await until(() => events.length >= 3, "three health events");

    expect(kinds()).toEqual(["failing", "recovered", "failing"]);
  });

  it("defaults to a single console.warn per transition", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    server.serve(serveStatus(500, "boom"));
    const client = new CruFlags({ url: server.url, pollSeconds: 0.03 });
    clients.push(client);

    await client.ready();
    await until(() => server.hits >= 4, "four failing polls");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("@cruglobal/flags");
    expect(String(warn.mock.calls[0]?.[0])).toContain("last-known-good");

    server.serve(serveDocument(SAMPLE_DOCUMENT));
    await until(() => warn.mock.calls.length >= 2, "a recovery warning");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("recovered");
  });

  it("survives an onError handler that throws", async () => {
    server.serve(serveStatus(500, "boom"));
    const client = new CruFlags({
      url: server.url,
      pollSeconds: 0.03,
      onError: () => {
        throw new Error("handler blew up");
      },
    });
    clients.push(client);

    await client.ready();
    server.serve(serveDocument(SAMPLE_DOCUMENT));
    await until(() => client.enabled("alpha"), "recovery despite the handler");

    expect(client.enabled("alpha")).toBe(true);
  });
});

function lastRequest(): { ifNoneMatch: string | undefined } {
  const request = server.requests[server.requests.length - 1];
  if (!request) throw new Error("no requests recorded");
  return request;
}
