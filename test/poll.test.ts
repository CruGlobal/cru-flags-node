/**
 * Timer behaviour: the poll interval's ±20% jitter and the hard requirement
 * that the client never keeps a process alive (`docs/design.md` §4.3, §4.4).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CruFlags } from "../src/client.js";
import {
  FlagServer,
  SAMPLE_DOCUMENT,
  serveDocument,
  sleep,
} from "./helpers/server.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let server: FlagServer;
const clients: CruFlags[] = [];

/** Timers currently holding the event loop open. Unref'd ones do not count. */
function liveTimers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

/**
 * Pump the real event loop until `predicate` holds. Used with fake timers
 * installed, so it cannot rely on `setTimeout`; `setImmediate` is left real.
 */
async function pump(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(async () => {
  server = await FlagServer.start(serveDocument(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await server.stop();
});

describe("the poll timer", () => {
  it("holds no event-loop reference while polling", async () => {
    const client = new CruFlags({
      url: server.url,
      pollSeconds: 0.05,
      fetchTimeoutMs: 500,
    });
    clients.push(client);

    await client.ready();
    // Real timers, several real polls: the client is mid-loop right now, with
    // a poll timer armed.
    await sleep(150);
    expect(server.hits).toBeGreaterThan(1);
    const withClient = liveTimers();

    // Control: a *ref'd* timer is visible to this introspection, so a count
    // that does not move is evidence, not a blind spot.
    const control = setTimeout(() => undefined, 60_000);
    expect(liveTimers()).toBe(withClient + 1);
    clearTimeout(control);

    client.close();
    expect(liveTimers()).toBe(withClient);
  });

  it("leaves no live timer behind after close()", async () => {
    const before = liveTimers();
    const client = new CruFlags({ url: server.url, pollSeconds: 30 });

    await client.ready();
    client.close();

    expect(liveTimers()).toBeLessThanOrEqual(before);
  });

  // Node's built-in type stripping runs the library straight from source in a
  // child process. Requires Node >= 23, where stripping is on by default.
  const canStripTypes = Number(process.versions.node.split(".")[0]) >= 23;

  it.skipIf(!canStripTypes)(
    "lets a real process exit on its own, with no close()",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cru-flags-exit-"));
      try {
        // Copy src/*.ts across, rewriting "./x.js" specifiers to "./x.ts" —
        // Node resolves the real filename, tsup/tsc resolve the ".js" form.
        for (const file of await readdir(SRC_DIR)) {
          const source = await readFile(join(SRC_DIR, file), "utf8");
          await writeFile(
            join(directory, file),
            source.replace(/(from "\.\/[\w-]+)\.js"/g, '$1.ts"'),
            "utf8",
          );
        }
        await writeFile(
          join(directory, "main.mjs"),
          [
            'import { CruFlags } from "./index.ts";',
            "const client = new CruFlags({",
            "  url: process.argv[2],",
            "  pollSeconds: 0.05,",
            "  fetchTimeoutMs: 500,",
            "});",
            "await client.ready();",
            'if (!client.enabled("alpha")) process.exit(2);',
            "// Deliberately no close(): a ref'd poll timer would hang here",
            "// forever, and this test would time out instead of exiting 0.",
            "",
          ].join("\n"),
          "utf8",
        );

        const child = spawn(
          process.execPath,
          [join(directory, "main.mjs"), server.url],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on(
          "data",
          (chunk: Buffer) => (output += chunk.toString()),
        );
        child.stderr.on(
          "data",
          (chunk: Buffer) => (output += chunk.toString()),
        );

        const exitCode = await new Promise<number | "hung">((resolve) => {
          const guard = setTimeout(() => {
            child.kill("SIGKILL");
            resolve("hung");
          }, 8000);
          child.on("exit", (code) => {
            clearTimeout(guard);
            resolve(code ?? -1);
          });
        });

        expect(`${String(exitCode)} ${output}`.trim()).toBe("0");
        expect(server.hits).toBeGreaterThan(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("jitter", () => {
  // Math.random() is stubbed, so the interval is exactly
  // pollSeconds * (0.8 + random * 0.4).
  it.each([
    { random: 0, expectedMs: 8000, label: "the -20% edge" },
    { random: 0.5, expectedMs: 10_000, label: "the midpoint" },
    { random: 1, expectedMs: 12_000, label: "the +20% edge" },
  ])(
    "polls again after $expectedMs ms at $label",
    async ({ random, expectedMs }) => {
      vi.spyOn(Math, "random").mockReturnValue(random);
      // Only setTimeout/clearTimeout are faked: the client uses nothing else,
      // and setImmediate stays real so `pump` can still drive real I/O.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const client = new CruFlags({
        url: server.url,
        pollSeconds: 10,
        fetchTimeoutMs: 5000,
      });
      clients.push(client);

      // ready() settles the first attempt, so the only timer left pending is
      // the poll timer (the fetch's abort timer has been cleared).
      await client.ready();
      expect(server.hits).toBe(1);

      await vi.advanceTimersByTimeAsync(expectedMs - 100);
      expect(server.hits).toBe(1);

      await vi.advanceTimersByTimeAsync(200);
      await pump(() => server.hits === 2, "the second poll");

      expect(server.hits).toBe(2);
    },
  );
});
