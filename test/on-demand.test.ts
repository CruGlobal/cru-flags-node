/**
 * `refreshMode: "on-demand"` — no timer, refresh on the request path
 * (`docs/design.md` §4.8). Real server, real timers throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CruFlags, REFRESH_MODE_ENV_VAR } from "../src/client.js";
import type { CruFlagsOptions, FlagsHealthEvent } from "../src/types.js";
import {
  FlagServer,
  SAMPLE_DOCUMENT,
  serveDocument,
  serveStatus,
  sleep,
} from "./helpers/server.js";

let server: FlagServer;
let events: FlagsHealthEvent[];
const clients: CruFlags[] = [];

function makeClient(options: Partial<CruFlagsOptions> = {}): CruFlags {
  const client = new CruFlags({
    url: server.url,
    // Long enough that nothing refreshes unless a test asks it to.
    pollSeconds: options.pollSeconds ?? 60,
    fetchTimeoutMs: options.fetchTimeoutMs ?? 1000,
    refreshMode: options.refreshMode ?? "on-demand",
    onError: (event) => events.push(event),
  });
  clients.push(client);
  return client;
}

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

beforeEach(async () => {
  events = [];
  delete process.env[REFRESH_MODE_ENV_VAR];
  server = await FlagServer.start(serveDocument(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  delete process.env[REFRESH_MODE_ENV_VAR];
  await server.stop();
  vi.restoreAllMocks();
});

describe("on-demand refresh", () => {
  it("arms no timer: nothing refreshes while nobody reads", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.ready();
    expect(server.hits).toBe(1);

    // Six poll intervals of silence. A background poller would have fired.
    await sleep(300);

    expect(server.hits).toBe(1);
  });

  it("fetches on the first read", async () => {
    const client = makeClient();

    expect(client.enabled("alpha")).toBe(false); // nothing fetched yet
    await until(() => server.hits === 1, "the first fetch");
    await client.ready();

    expect(client.enabled("alpha")).toBe(true);
  });

  it("serves reads from cache until pollSeconds has passed", async () => {
    const client = makeClient();
    expect(await client.refresh()).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      expect(client.enabled("alpha")).toBe(true);
    }

    expect(server.hits).toBe(1);
  });

  it("refreshes on a read once the snapshot is stale", async () => {
    const client = makeClient({ pollSeconds: 0.05 });
    await client.refresh();
    await sleep(60);

    client.enabled("alpha");

    await until(() => server.hits === 2, "the on-demand refresh");
    expect(server.requests[1]?.ifNoneMatch).toBe('"1"');
  });

  it("await refresh() has the current document before the read", async () => {
    const client = makeClient();
    await client.refresh();

    server.serve(serveDocument({ ...SAMPLE_DOCUMENT, Version: 2 }));
    expect(await client.refresh({ force: true })).toBe(true);

    expect(client.snapshot()?.["Version"]).toBe(2);
  });

  it("coalesces concurrent refreshes onto one request", async () => {
    const client = makeClient();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => client.refresh({ force: true })),
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => true));
    expect(server.hits).toBe(1);
  });

  it("costs one request per interval, not per read, while the service is down", async () => {
    server.serve(serveStatus(500));
    const client = makeClient();

    for (let index = 0; index < 20; index += 1) client.enabled("alpha");
    await until(() => events.length === 1, "the failing event");
    await sleep(50);

    // Staleness is anchored on the last attempt, so a dead service is asked
    // once per pollSeconds however hard the app is being read.
    expect(server.hits).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(["failing"]);
  });

  it("keeps the last-known-good document through a failure", async () => {
    const client = makeClient();
    await client.refresh();

    server.serve(serveStatus(500));

    expect(await client.refresh({ force: true })).toBe(false);
    expect(client.enabled("alpha")).toBe(true);
  });

  it("stops refreshing after close()", async () => {
    const client = makeClient();
    await client.refresh();
    const hits = server.hits;

    client.close();

    expect(await client.refresh({ force: true })).toBe(false);
    expect(client.enabled("alpha")).toBe(true); // the snapshot stays readable
    expect(server.hits).toBe(hits);
  });
});

describe("refresh()", () => {
  it("is a no-op while the snapshot is fresh, and forced when asked", async () => {
    const client = makeClient();

    expect(await client.refresh()).toBe(true);
    expect(await client.refresh()).toBe(true);
    expect(server.hits).toBe(1);

    expect(await client.refresh({ force: true })).toBe(true);
    expect(server.hits).toBe(2);
  });

  it("is false on an inert client and fetches nothing", async () => {
    const client = new CruFlags({ url: "", refreshMode: "on-demand" });
    clients.push(client);

    expect(await client.refresh({ force: true })).toBe(false);
    expect(server.hits).toBe(0);
  });

  it("works in background mode as an out-of-band poke", async () => {
    const client = makeClient({ refreshMode: "background" });
    await client.ready();
    expect(server.hits).toBe(1);

    expect(await client.refresh({ force: true })).toBe(true);

    expect(server.hits).toBe(2);
  });
});

describe("background mode is unchanged", () => {
  it("never fetches on the read path, however stale the snapshot", async () => {
    const client = makeClient({ refreshMode: "background", pollSeconds: 0.05 });
    await client.ready();
    const hits = server.hits;

    // Reads are I/O-free in background mode: only the timer fetches, so any
    // growth here has to come from ticks, never from these calls.
    for (let index = 0; index < 20; index += 1) client.enabled("alpha");
    client.snapshot();

    expect(server.hits).toBe(hits);
  });
});

describe(REFRESH_MODE_ENV_VAR, () => {
  it("selects on-demand refresh", async () => {
    process.env[REFRESH_MODE_ENV_VAR] = "on-demand";
    const client = new CruFlags({ url: server.url, pollSeconds: 0.05 });
    clients.push(client);

    await client.ready();
    await sleep(200);

    expect(server.hits).toBe(1); // no timer: the environment chose on-demand
  });

  it("loses to an explicit refreshMode option", async () => {
    process.env[REFRESH_MODE_ENV_VAR] = "on-demand";
    const client = makeClient({ refreshMode: "background", pollSeconds: 0.05 });

    await client.ready();

    await until(() => server.hits > 1, "the second poll");
  });

  it("warns and keeps polling when the value is unrecognised", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env[REFRESH_MODE_ENV_VAR] = "syncronous";
    const client = new CruFlags({ url: server.url, pollSeconds: 0.05 });
    clients.push(client);

    await client.ready();

    await until(() => server.hits > 1, "the second poll");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(REFRESH_MODE_ENV_VAR);
  });
});
