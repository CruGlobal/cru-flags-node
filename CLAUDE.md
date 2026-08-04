# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`@cruglobal/flags` — the official Node.js client for Cru's **pipeline feature
flag service**. It fetches one JSON document per (project, environment) over
HTTP, caches it, polls with `ETag` revalidation, and exposes a single
synchronous predicate:

```ts
import { flags } from "@cruglobal/flags";
flags.enabled("checkout_v2"); // boolean, sync, never throws
```

## Read the design doc first

[`docs/design.md`](docs/design.md) is the **authoritative specification** —
the wire contract, the behavioural contract, and the reasoning behind each
decision. Read it before changing anything in `src/`.

Design-level changes require updating `docs/design.md` **in the same PR**.
Drift between the design doc and the code is a bug, and the doc wins.

## Load-bearing decisions (do not "simplify" these)

Each of these looks like it could be tidied up, and each one is load-bearing.
The rationale is in `docs/design.md`; the short version:

- **`enabled()` never throws, and never blocks.** It is a hot-path predicate.
  Unknown flag, no document, malformed entry -> `false`. No coercion: the check
  is literally `Flags[name]?.Enabled === true`.
- **`enabled()` does no I/O in background mode.** In `refreshMode: "on-demand"`
  (§4.8) it may _trigger_ a stale refresh, but never awaits one — a sync
  predicate that blocks on the network is worse than a stale boolean. Do not
  make on-demand reads await, and do not give background reads a fetch.
- **On-demand staleness is anchored on the last _attempt_,** not the last
  success, so a dead flag service costs one request per interval rather than
  one per read. Concurrent refreshes coalesce onto `#inFlight`.
- **Fail-static with no expiry.** Last-known-good flags are served forever
  through any outage. Adding a TTL would turn a flag-service outage into a
  fleet-wide unannounced flag flip hours later. (§4.5)
- **404 is a state, not an error.** It means "this project has no flag
  document yet" -> empty snapshot, `onError` **not** called, client healthy.
  (§2.1)
- **A failed parse must not store the response's `ETag`.** Otherwise every
  later poll 304s and the client is permanently pinned to a body it rejected.
  (§2.1)
- **`onError` fires only on health transitions** (`ok -> failing`,
  `failing -> ok`), never per poll. Per-poll logging is ~2,880 identical
  lines/day/instance and buries the signal. (§5)
- **The poll timer is `unref()`'d.** The client must never keep a process
  alive. A library that hangs someone's CLI gets ripped out. (§4.4)
- **Nothing happens at import.** First `enabled()`/`ready()` call starts the
  client — so `process.env` set after import still works (`CRU_FLAGS_URL`,
  `CRU_FLAGS_REFRESH_MODE`), and importing the module in a test never opens a
  socket. (§4.1)
- **Misconfiguration from the environment warns; from code it is a type
  error.** A bad `CRU_FLAGS_REFRESH_MODE` warns once and keeps polling.
- **Unset `CRU_FLAGS_URL` -> inert and silent.** No timers, no fetch, no
  warning. Unconfigured is a normal state (local dev, CI, unit tests). (§4.2)
- **Snapshots are deep-frozen and replaced wholesale.** A 200 installs a new
  object; a 304 keeps the same one — object identity is how tests observe
  revalidation. (§4.6)
- **Zero runtime dependencies.** Dev dependencies are fine.

## Toolchain

- **Node.js** is pinned in `.tool-versions` (asdf locally,
  `actions/setup-node`'s `node-version-file` in CI) so local and CI cannot
  drift. Never pin Node separately in a workflow.
- The published library targets ES2022 / Node >= 20 (global `fetch`).

## Commands

```sh
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm test              # vitest run
npm run test:coverage # vitest run --coverage
npm run build         # tsup -> dist (esm + cjs + d.ts + d.cts)
npm run verify:live   # opt-in: hits the real flag service (never in CI)
```

Before opening a PR run all four of typecheck, lint, test, build.

## Testing conventions

- Integration tests run against a **real `node:http` server** from
  `test/helpers/server.ts`, not a stubbed `fetch`. `ETag` revalidation,
  `AbortController` timeouts, and bodyless 304s are precisely where a fetch
  double would test our assumptions instead of the behaviour.
- Real timers for anything asserting unref / process-liveness; fake timers
  only for scheduling arithmetic.
- The live test is gated on `CRU_FLAGS_LIVE=1` and **must stay skipped in
  CI** — a red build should never mean "the flag service was restarting".
- Bug fixes and features lead with a failing test; see
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
