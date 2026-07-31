/**
 * Live verification against the real flag service.
 *
 * Opt-in only — run it with `npm run verify:live`. It is skipped unless
 * `CRU_FLAGS_LIVE` is set, and CI must never set it: a red build has to mean
 * "our code is broken", not "a service was restarting" (`docs/design.md` §7).
 *
 * The URL below is a public, read-only pilot document.
 */
import { describe, expect, it } from "vitest";
import { CruFlags } from "../src/client.js";
import type { FlagsHealthEvent } from "../src/types.js";
import { sleep } from "./helpers/server.js";

const LIVE_URL = "https://deploys.cru.org/flags/ararat/release-candidate";
const POLL_SECONDS = 1;

describe.skipIf(!process.env["CRU_FLAGS_LIVE"])("the live flag service", () => {
  it("serves a document this client parses, and revalidates with a 304", async () => {
    const events: FlagsHealthEvent[] = [];
    const client = new CruFlags({
      url: LIVE_URL,
      pollSeconds: POLL_SECONDS,
      fetchTimeoutMs: 10_000,
      onError: (event) => events.push(event),
    });

    try {
      await client.ready();
      const snapshot = client.snapshot();
      console.log(
        `[verify:live] GET ${LIVE_URL}\n[verify:live] snapshot: ${JSON.stringify(snapshot, null, 2)}`,
      );

      // 1. A real document parses into the shape the contract promises.
      expect(snapshot).not.toBeNull();
      expect(snapshot?.Project).toBe("ararat");
      expect(snapshot?.Environment).toBe("release-candidate");
      expect(typeof snapshot?.Version).toBe("number");
      expect(typeof snapshot?.NotifySlack).toBe("boolean");

      const names = Object.keys(snapshot?.Flags ?? {});
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(typeof snapshot?.Flags[name]?.Enabled).toBe("boolean");
        // enabled() agrees with the document, whichever way it reads.
        expect(client.enabled(name)).toBe(
          snapshot?.Flags[name]?.Enabled === true,
        );
      }
      console.log(
        `[verify:live] flags: ${names.map((name) => `${name}=${String(client.enabled(name))}`).join(", ")}`,
      );

      // 2. The stored snapshot is frozen and still JSON-round-trippable.
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

      // 3. The next poll revalidates: identical object identity means the
      //    client honoured a 304 instead of re-parsing a 200.
      await sleep(POLL_SECONDS * 1000 * 1.2 + 1500);
      const repolled = client.snapshot();
      if (repolled?.Version === snapshot?.Version) {
        expect(repolled).toBe(snapshot);
        console.log("[verify:live] second poll kept the same snapshot object");
      } else {
        // Someone flipped a flag while this ran; the identity check no longer
        // means anything, but the wire-level check below still does.
        console.log(
          `[verify:live] document changed mid-run (Version ${String(snapshot?.Version)} -> ${String(repolled?.Version)}); skipping the identity check`,
        );
      }

      // 4. …and prove the 304 on the wire, with the document's own ETag.
      const first = await fetch(LIVE_URL);
      const etag = first.headers.get("etag");
      await first.text();
      expect(first.status).toBe(200);
      expect(etag).toBeTruthy();

      const second = await fetch(LIVE_URL, {
        headers: { "if-none-match": etag ?? "" },
      });
      await second.text();
      expect(second.status).toBe(304);
      console.log(
        `[verify:live] ETag ${String(etag)} -> If-None-Match -> HTTP ${String(second.status)}`,
      );

      // 5. Nothing was ever reported as unhealthy.
      expect(events).toEqual([]);
    } finally {
      client.close();
    }
  }, 60_000);

  it("treats a project with no document as empty, not an error", async () => {
    const events: FlagsHealthEvent[] = [];
    const client = new CruFlags({
      url: "https://deploys.cru.org/flags/no-such-project-cru-flags-node/production",
      pollSeconds: 60,
      fetchTimeoutMs: 10_000,
      onError: (event) => events.push(event),
    });

    try {
      await client.ready();

      expect(client.snapshot()).toBeNull();
      expect(client.enabled("anything")).toBe(false);
      expect(events).toEqual([]);
      console.log("[verify:live] 404 handled as an empty snapshot, no onError");
    } finally {
      client.close();
    }
  }, 30_000);
});
