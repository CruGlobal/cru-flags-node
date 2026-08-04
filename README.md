# @cruglobal/flags

[![npm](https://img.shields.io/npm/v/@cruglobal/flags.svg)](https://www.npmjs.com/package/@cruglobal/flags)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

> **Status: AI-generated, not actively maintained.** This library was
> authored primarily by an AI assistant against the specification in
> [`docs/design.md`](docs/design.md) and is not on anyone's active
> roadmap. Dependabot keeps dependencies and security advisories up to
> date automatically (patch + minor bumps auto-merge; majors require
> manual review), but feature work, bug fixes, and other changes
> happen on a best-effort basis. **Pull requests and issues are
> welcome** — they may take time to be reviewed. See
> [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution workflow.

The official Node.js client for **Cru's pipeline feature flag service**. It
polls one flag document over HTTP, caches it, and answers one question
synchronously, on the hot path, without ever throwing:

```ts
import { flags } from "@cruglobal/flags";

if (flags.enabled("checkout_v2")) {
  // …
}
```

Zero runtime dependencies. ESM + CJS + TypeScript types. Node.js >= 20.

---

## Install

```sh
npm install @cruglobal/flags
```

Set `CRU_FLAGS_URL` to your project's flag document — the pipeline injects it
for you in deployed environments:

```sh
CRU_FLAGS_URL=https://deploys.cru.org/flags/<project>/<environment>
```

With the variable unset the client is **inert**: every flag is `false`, no
timers, no requests, no log noise. That is the normal state in local dev, in
CI, and in unit tests.

## Usage

```ts
import { flags } from "@cruglobal/flags";

await flags.ready(); // optional: wait for the first fetch (Lambda init, warmup)
flags.enabled("checkout_v2"); // → boolean
```

```js
// CJS
const { flags } = require("@cruglobal/flags");
```

```ts
// Explicit configuration / dependency injection (tests, multi-document tools)
import { CruFlags } from "@cruglobal/flags";

const client = new CruFlags({
  url: "https://deploys.cru.org/flags/ararat/production",
  pollSeconds: 30, // background poll interval, jittered ±20%
  fetchTimeoutMs: 2000,
  onError: (event) => log.warn(event), // health transitions only
  refreshMode: "background", // or "on-demand" — see below
});
```

### On-demand refresh (Cloud Run, Lambda, anything that freezes)

```sh
CRU_FLAGS_REFRESH_MODE=on-demand
```

On scale-to-zero runtimes a poll timer either doesn't fire or fires only to
wake an idle instance. In `"on-demand"` mode the client **arms no timer**:
refreshing rides on reads instead, and only once the snapshot is `pollSeconds`
old.

```ts
// Either the env var above, or explicitly:
const flags = new CruFlags({ refreshMode: "on-demand" });

// enabled() stays synchronous. It triggers a refresh when the snapshot is
// stale, but cannot await one — so it answers from the previous fetch.
flags.enabled("checkout_v2");

// await refresh() when you want the current document *before* deciding:
app.use(async (_req, _res, next) => {
  await flags.refresh(); // no-op while the snapshot is younger than pollSeconds
  next();
});
```

- At most one conditional `GET` (usually a `304`) per `pollSeconds` per
  instance, measured from the last _attempt_ — so a dead flag service costs
  one failed request per interval, not one per read. Concurrent refreshes
  coalesce; reads in between are served from memory.
- Everything else — fail-static, last-known-good forever, never throwing,
  transition-only logging — is unchanged.

An explicit `refreshMode` wins over the environment variable; an unrecognised
env value warns once and keeps polling.

In AWS Lambda, `await flags.ready()` at module scope runs during init, so the
first invocation already sees real flags instead of `false`:

```ts
await flags.ready();

export const handler = async (event) => {
  return flags.enabled("checkout_v2") ? handleV2(event) : handleV1(event);
};
```

---

## Behavioural contract

Every line here is covered by a test.

- **`enabled(name)` is synchronous, total, and never throws.** Unknown flag,
  no document yet, malformed entry — all `false`. The check is literally
  `Flags[name]?.Enabled === true`; nothing is coerced. It performs no I/O in
  background mode, and never awaits any in `"on-demand"` mode.
- **`ready()` resolves after the first fetch _attempt_** — success, 404, or
  failure alike — and never rejects. It is a warmup hook, not a health check.
- **Nothing happens at import.** The first `enabled()` / `ready()` call starts
  the client, so setting `process.env.CRU_FLAGS_URL` after importing still
  works.
- **`CRU_FLAGS_URL` unset ⇒ inert and silent.** No timers, no fetches, no
  warnings.
- **Fail-static, with no expiry.** Before the first success everything is
  `false`; after it, the last-known-good document is served _indefinitely_
  through any number of failures. An outage never flips your flags.
- **`404` is a state, not an error.** "This project has no flag document yet"
  yields an empty snapshot and does **not** call `onError`.
- **Background polling with `ETag` revalidation.** Every poll sends
  `If-None-Match`; a `304` keeps the existing snapshot (same frozen object).
  The interval is `pollSeconds` ±20% jitter, so a fleet deployed together
  doesn't stampede the service in lockstep.
- **`refreshMode: "on-demand"` arms no timer** and refreshes on the read path
  instead, at most once per `pollSeconds`, coalescing concurrent refreshes.
  `await refresh()` is the awaited form; `refresh({ force: true })` ignores the
  interval.
- **The poll timer is `unref()`'d.** The client never keeps a process alive —
  your CLI or test run still exits on its own.
- **Timeouts via `AbortController`** (`fetchTimeoutMs`, default 2s). No
  retries inside a tick; the next tick is the retry.
- **`onError` fires only on health transitions** — once when polling starts
  failing (with the error) and once when it recovers — never once per poll.
  The default handler is `console.warn`; inject your own to route it to a
  logger.
- **Snapshots are deep-frozen** plain objects, replaced wholesale, and stay
  JSON-round-trippable so you can log them.

### The flag document

```json
{
  "Project": "ararat",
  "Environment": "release-candidate",
  "Version": 3,
  "NotifySlack": true,
  "Flags": {
    "pilot_banner": { "Enabled": true, "Description": "…", "UpdatedBy": "…" }
  }
}
```

`snapshot()` returns that document (frozen), or `null` before the first
success. `Enabled` is the only field the library interprets; unknown fields
are preserved verbatim so a newer service can add fields without breaking
older clients.

Full reasoning for each decision — including why there is no TTL and why
logging is transition-only — is in [`docs/design.md`](docs/design.md).

---

## Development

This repo uses [`asdf`](https://asdf-vm.com/) to pin the exact Node.js
version (see [`.tool-versions`](.tool-versions)). After cloning:

```sh
asdf plugin add nodejs   # one-time, if not already set up
asdf install
npm install
npm test
```

```sh
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm test              # vitest run
npm run build         # tsup → dist (esm + cjs + d.ts + d.cts)
npm run verify:live   # opt-in: polls the real flag service
```

`npm test` never touches the network: integration tests run against a real
local `node:http` server. `npm run verify:live` is the opt-in exception — it
polls `https://deploys.cru.org/flags/ararat/release-candidate` (public,
read-only), asserts a real document parses and that the second poll
revalidates to a `304`, and is deliberately **skipped in CI** so a service
restart can never redden a build.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow and
[`docs/design.md`](docs/design.md) for the design rationale.

### Releasing

[release-please](https://github.com/googleapis/release-please) watches `main`,
maintains a release PR from the conventional-commit history, and publishes a
GitHub Release when that PR merges. The `release` workflow then runs
`npm publish --provenance` using npm **trusted publishing** (OIDC) — there is
no npm token in this repository.

> Bootstrap note: npm trusted publishing can only be attached to a package
> that already exists, so `v0.1.0` is published manually by a maintainer.
> Once the trusted publisher is configured on the npm package, every
> subsequent release publishes automatically from CI.

---

## License

[BSD-3-Clause](LICENSE).
