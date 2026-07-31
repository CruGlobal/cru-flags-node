# cru-flags-node — Design Document

## 1. Purpose & Scope

`@cruglobal/flags` is the official Node.js client for **Cru's pipeline feature
flag service**. The service publishes one small JSON document per
(project, environment) pair over plain HTTP:

```
GET https://deploys.cru.org/flags/<project>/<environment>
```

Applications need to answer exactly one question, everywhere, cheaply:

```ts
import { flags } from "@cruglobal/flags";

if (flags.enabled("checkout_v2")) {
  // …
}
```

That call is **synchronous**, **never throws**, and is safe on the hot path.
Everything else in this library exists to make that one call trustworthy while
the network, the flag service, and the deploy pipeline all misbehave
independently of each other.

### In scope for v1.0

- Fetching and caching the flag document for a single URL.
- Background polling with jitter and `ETag` revalidation.
- A synchronous, total `enabled(name)` predicate.
- `ready()` for runtimes with an init phase (AWS Lambda, container warmup).
- Fail-static semantics: last-known-good flags survive any outage.
- Zero runtime dependencies; ESM + CJS + `.d.ts`; Node.js >= 20 (global `fetch`).

### Out of scope

- **Writing flags.** The service is the writer; this is a read-only client.
- **Per-user / percentage targeting.** Cru's flag documents are boolean
  switches scoped to (project, environment). There is no evaluation context,
  no bucketing, no user identity. If that changes, it is a new major version.
- **Streaming / SSE / websockets.** Polling with `ETag` revalidation is cheap
  enough (a 304 is ~200 bytes) and has far fewer failure modes behind ALBs.
- **Local file / env-var flag overrides.** Test code injects a `CruFlags`
  instance instead (see §3.3).
- **Analytics / flag-usage reporting.** No phone-home. `enabled()` performs no
  I/O at all.

### Non-goals

- Being a general-purpose flag SDK (LaunchDarkly / OpenFeature compatible).
  An OpenFeature provider could be layered on top later; it is not this
  package's job.
- Working in browsers. The document is not public per-app and the polling
  model is wrong for a browser tab. Node (and Node-compatible serverless)
  only.

---

## 2. The wire contract

The document shape below **is** the contract. It is reproduced here so the
library can be reasoned about without reading the service's source.

```json
{
  "Project": "ararat",
  "Environment": "release-candidate",
  "Version": 3,
  "NotifySlack": true,
  "Flags": {
    "pilot_banner": {
      "Enabled": true,
      "Description": "Pilot: flag-gated banner proving the flag service end-to-end",
      "CreatedAt": "2026-07-31T14:09:01.119Z",
      "UpdatedAt": "2026-07-31T14:09:08.777Z",
      "UpdatedBy": "Omicron7"
    }
  }
}
```

Field notes, from the live service:

| Field                 | Type    | Notes                                                                 |
| --------------------- | ------- | --------------------------------------------------------------------- |
| `Project`             | string  | Pipeline project (app) name.                                          |
| `Environment`         | string  | `release-candidate` or `production`.                                  |
| `Version`             | number  | Monotonic document revision. Also the `ETag` value.                   |
| `NotifySlack`         | boolean | Service-side concern (Slack notification on change). Carried through. |
| `Flags`               | object  | Map of flag name -> flag definition. May be absent or `{}`.           |
| `Flags[name].Enabled` | boolean | **The only field this library interprets.**                           |
| `Flags[name].*`       | any     | `Description`, `CreatedAt`, `UpdatedAt`, `UpdatedBy` today; open set. |

`enabled(name)` is defined as, exactly:

```ts
snapshot?.Flags[name]?.Enabled === true;
```

Anything that is not literally `true` — missing flag, missing document,
`"true"`, `1`, `null` — is `false`. The library never coerces.

### 2.1 HTTP semantics

Observed against `https://deploys.cru.org/flags/…` (ALB in front of the
service):

| Response                                                       | Meaning                            | Client behaviour                             |
| -------------------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `200` + body + `ETag: "3"`                                     | Current document.                  | Parse, freeze, store; store `ETag`. Healthy. |
| `304` (sent `If-None-Match`)                                   | Unchanged since our `ETag`.        | Keep the existing snapshot object. Healthy.  |
| `404` + `{"message": "… no feature flags in production yet."}` | The project has no document.       | **Empty snapshot, not an error.** Healthy.   |
| `400`                                                          | Bad environment name (caller bug). | Failure (see §5). Retried on the next tick.  |
| `5xx`, connection reset, timeout                               | Service or network trouble.        | Failure (see §5). Last-known-good retained.  |

The `ETag` is the document `Version` in quotes (`"3"`). The client treats it as
an opaque string — it is echoed back verbatim in `If-None-Match` and never
parsed. `Cache-Control: no-cache` on 200s is why revalidation, not TTL
caching, is the right model here.

Two decisions fall out of this table and are load-bearing:

1. **404 is a state, not a failure.** A brand-new app has no flag document
   until someone creates a flag. If a 404 called `onError`, every app that
   hasn't adopted flags yet would log a warning on the first poll forever.
   404 therefore resolves `ready()`, marks the client healthy, and yields an
   empty snapshot.
2. **A failed _parse_ must not advance the `ETag`.** If the service ever
   serves a 200 with a truncated or non-JSON body, storing that response's
   `ETag` would make every subsequent poll a 304 — the client would be
   permanently pinned to a body it rejected, with no path back to health.
   The `ETag` is only stored alongside a successfully parsed document.

---

## 3. Public API

```ts
import { flags, CruFlags } from "@cruglobal/flags";

flags.enabled("checkout_v2"); // boolean, sync, never throws
await flags.ready(); // resolves after the first fetch attempt
```

### 3.1 `flags`

A module-level `CruFlags` singleton configured from the environment. Importing
it does **nothing**: no network, no timers, no env validation. See §4.1.

### 3.2 `enabled(name): boolean` and `ready(): Promise<void>`

- `enabled(name)` returns the boolean defined in §2. It is total: it never
  throws, never rejects, never blocks, and never performs I/O. The first call
  _starts_ the client (§4.1) but does not wait for it — before the first
  successful fetch every flag is `false`.
- `ready()` resolves once the first fetch **attempt** has completed —
  success, 404, or failure alike. It never rejects. It is a warmup hook, not
  a health check: a resolved `ready()` does not promise a document exists.
  On an inert client (§4.2) it resolves immediately.

The intended Lambda usage is a top-level `await flags.ready()` during init, so
the first request of a cold invocation sees real flags rather than `false`:

```ts
// handler.ts — module scope runs during Lambda init
await flags.ready();

export const handler = async (event) => {
  if (flags.enabled("checkout_v2")) {
    /* … */
  }
};
```

### 3.3 `new CruFlags(options?)`

```ts
new CruFlags({
  url, // default: process.env.CRU_FLAGS_URL, read at start time
  pollSeconds = 30, // background poll interval, jittered +/-20%
  fetchTimeoutMs = 2000,
  onError, // default: console.warn on health transitions only
});
```

Constructing a client is inert; see §4.1. The constructor is the dependency
injection seam for tests and for apps that read more than one document (e.g. a
tool that inspects several projects).

### 3.4 Secondary surface

- `snapshot(): FlagsDocument | null` — the frozen document currently in
  effect, or `null` before the first success / after a 404. Object identity is
  meaningful: a 200 always installs a **new** frozen object, a 304 keeps the
  **same** one. Tests and the live-verification script use that identity to
  observe revalidation without inspecting HTTP.
- `close(): void` — cancels the poll timer and stops the client. Optional in
  long-lived processes (the timer is unref'd; §4.4) but useful in tests and
  short-lived CLIs.
- `FlagsError` — the error passed to `onError`, carrying `code`
  (`"http" | "network" | "timeout" | "parse"`) and, for `"http"`, `status`.
- Types: `FlagsDocument`, `FlagDefinition`, `CruFlagsOptions`,
  `FlagsHealthEvent`.

Everything else is private. The class uses `#private` fields so there is no
reachable-but-unsupported surface.

---

## 4. Behaviour

### 4.1 Lazy start

Nothing happens at import or construction. The first call to `enabled()`,
`ready()` or `snapshot()` starts the client: resolve the URL, kick off fetch
#1, and schedule the poll loop.

Why: `import`-time side effects are a well-known source of pain in this
codebase's target runtimes. A module that opens a socket on import breaks
test collection (vitest imports every module), breaks bundler tree-shaking,
and in Lambda burns init time even in code paths that never read a flag. It
also makes `CRU_FLAGS_URL` ordering fragile — with lazy start, code that sets
`process.env` after importing the library still works, which is exactly what
test harnesses do.

### 4.2 Inert mode (`CRU_FLAGS_URL` unset)

If no URL is configured, the client is **inert**: `enabled()` returns `false`,
`ready()` resolves immediately, no timer is created, no fetch is attempted,
and **nothing is logged**.

Why silent: the same application image runs in local dev, in CI, in unit
tests, and in one-off `node -e` scripts, mostly without a flag service. A
warning on every process start would train everyone to ignore the library's
logs — which are the only signal that matters when the service is actually
down (§5). "Unconfigured" is a legitimate, common, boring state.

### 4.3 Polling

- Interval: `pollSeconds` with **+/-20% jitter** (`0.8x`–`1.2x`), re-rolled
  every tick.
- Scheduling: the next tick is scheduled _after_ the current fetch settles,
  never on a fixed wall-clock interval. Two consequences: polls cannot
  overlap or stampede if the service is slow, and one hung request cannot
  queue up N others behind it.
- Revalidation: `If-None-Match: <stored ETag>` whenever an `ETag` is held.
- **No retries within a tick.** A failed fetch is simply retried on the next
  tick. Retry-within-tick multiplies load on an already unhealthy service for
  no benefit, because a stale flag is a non-event (§4.5).

Why jitter: every instance of an app is deployed at the same moment by the
same pipeline, so unjittered polling produces a synchronized thundering herd
against a single ALB every `pollSeconds` — and it stays synchronized, because
a fixed interval never drifts apart on its own. +/-20% de-phases a fleet
within a few minutes.

### 4.4 The poll timer is unref'd

The poll timer is always `unref()`'d, so it does not keep the Node event loop
alive. A CLI, a test runner, or a script that merely imports a module which
imports this library must still exit on its own. This is a hard requirement,
not an optimization — a library that silently converts a 200ms script into a
process that hangs forever is a library people rip out. It is verified twice
over:

1. **Handle introspection** — a real client polls a real server with real
   timers while `process.getActiveResourcesInfo()` is checked for `Timeout`
   entries. The same test arms a deliberately ref'd control timer and asserts
   the count _does_ move for it, so a flat count is evidence rather than a
   blind spot.
2. **Real process exit** — a child `node` process starts a client, awaits
   `ready()`, and never calls `close()`. It must exit 0 on its own; a ref'd
   poll timer would hang it until the test's kill timeout. (The child runs the
   library straight from `src/` via Node's built-in type stripping, so the
   test needs no build step; it is skipped below Node 23.)

The fetch-timeout timer is unref'd for the same reason (and cleared in a
`finally` regardless).

### 4.5 Fail-static

- Before the first successful fetch: every flag is `false`.
- After the first success: the last-known-good document is served **forever**,
  through any number of consecutive failures. There is no TTL, no expiry, no
  "stale" state that starts returning `false`.

Why no expiry: expiring the snapshot converts a flag-service outage into a
simultaneous, fleet-wide, unannounced flag flip — every enabled flag turns off
at once in every instance, hours after the actual incident, while nobody is
looking at the flag service. That is strictly worse than serving slightly
stale booleans. Flags in this system gate rollout state, not security
boundaries; stale-but-stable is the correct failure mode. The service being
down must be _boring_.

A 404 is the one case where a stored document is dropped, because 404 is a
successful answer meaning "there is no document" (§2.1), not a failure.

### 4.6 Immutability

Parsed documents are deep-frozen (`Object.freeze` over every nested object and
array) before being stored, and only ever replaced wholesale — never mutated
in place. So a caller that holds a reference to `snapshot()` holds a value
that cannot change under it mid-request, and a caller that mutates it gets a
`TypeError` (strict mode) instead of quietly corrupting the flags for every
other caller in the process. The snapshot stays JSON-round-trippable, which is
the property most useful when someone is debugging: it can be logged.

### 4.7 Timeouts

`fetchTimeoutMs` (default 2000) is enforced with an `AbortController`; on
expiry the controller aborts with a `FlagsError { code: "timeout" }`, which is
what `fetch` then rejects with. 2s is chosen against the deployment reality:
the poll is background work, and a request that hasn't answered in 2s will not
answer usefully before the next tick anyway.

---

## 5. Error reporting: transitions only

`onError` is called **only on health-state transitions**:

- `ok -> failing` — once, with the `FlagsError` that broke it.
- `failing -> ok` — once, as a recovery note (no error).

It is _not_ called per failed poll. The default handler is `console.warn`.

```ts
type FlagsHealthEvent =
  | { kind: "failing"; url: string; error: FlagsError }
  | { kind: "recovered"; url: string };
```

Why transition-only: at the default 30s interval, a per-poll handler emits
2,880 identical lines per day per instance. Across a fleet that is tens of
thousands of log lines that say the same thing, which (a) costs real money in
log ingest, (b) buries the one line that matters, and (c) trains responders to
filter the library out entirely. Transitions carry all the information a
responder needs — when it broke, why, and when it came back — at two lines
per incident per instance.

The handler is invoked inside a `try`/`catch`; a throwing `onError` cannot
break the poll loop or produce an unhandled rejection. `onError` receiving a
non-error `"recovered"` event is deliberate: it is the client's health hook,
and "it's back" is worthless if it arrives on a channel nobody wired up.

---

## 6. Architecture

```
src/errors.ts     FlagsError
src/types.ts      FlagsDocument, FlagDefinition, options, events
src/document.ts   parseDocument(text) -> frozen FlagsDocument  (pure, no I/O)
src/client.ts     CruFlags: state machine, fetch, poll loop, health
src/index.ts      public exports + the `flags` singleton
```

`document.ts` is pure and synchronous: text in, frozen document out, throws
`FlagsError { code: "parse" }` on anything malformed. `client.ts` owns all
I/O and all state. That split is what makes the shape validation exhaustively
testable without a server, and the state machine testable without caring how
JSON parses.

Client state:

| Field       | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `#document` | Frozen `FlagsDocument` or `null`.                             |
| `#etag`     | Last `ETag` that accompanied a successfully parsed document.  |
| `#started`  | Lazy-start latch.                                             |
| `#healthy`  | Health-transition latch for `onError` (starts `true`).        |
| `#timer`    | Unref'd poll timer, or `null`.                                |
| `#closed`   | Terminal; suppresses further polls.                           |
| `#ready`    | Promise + resolver, resolved after the first attempt settles. |

### 6.1 Validation rules (`parseDocument`)

Malformed input throws `FlagsError { code: "parse" }`; the client turns that
into a normal failure (§4.5), so a bad deploy of the _service_ cannot take
down a client.

- Body must be JSON, and a non-null, non-array object.
- `Flags`, if present, must be a non-null, non-array object; absent or `null`
  normalizes to `{}`.
- Each flag entry must be an object; entries that are not are dropped rather
  than failing the whole document, because one malformed flag should not blind
  the app to the other twenty.
- `Enabled` is read as `=== true`; a missing or non-boolean `Enabled` means
  `false`, not an error.
- `Project` / `Environment` / `Version` / `NotifySlack` and any unknown
  top-level or per-flag keys are preserved verbatim, unvalidated. Forward
  compatibility: the service is free to add fields, and old clients must not
  reject documents from a newer service.

---

## 7. Testing strategy

The behavioural contract in §2–§5 is written so each bullet maps to a test.

- **Unit** (`test/document.test.ts`) — shape validation, `Enabled` coercion
  rules, deep freeze, JSON round-trip of the stored snapshot.
- **Integration against a real `node:http` server** (`test/*.test.ts`) — a
  local harness serves real 200/304/404/400/500 responses, real `ETag`
  revalidation, real hangs for timeouts, and records every request it sees.
  Preferring a real socket over a stubbed `fetch` is deliberate: `ETag`
  revalidation, `AbortController` timeouts, and 304-with-no-body are exactly
  the places where a hand-written `fetch` double would encode our assumptions
  instead of testing them.
- **Timers** — real timers for the unref/handle-introspection test; fake
  timers only where the assertion is about scheduling arithmetic.
- **Live** (`npm run verify:live`, `test/live.test.ts`) — opt-in, gated on
  `CRU_FLAGS_LIVE=1`, hits `https://deploys.cru.org/flags/ararat/release-candidate`
  (public, read-only) and asserts a real document parses and that the second
  poll revalidates to a 304. **CI never runs it**: a red build must mean "our
  code is broken", never "a service was rebooting".

---

## 8. Packaging & distribution

- npm: `@cruglobal/flags`, public, BSD-3-Clause, zero runtime dependencies.
- `tsup` builds ESM + CJS + `.d.ts` / `.d.cts`, target `es2022`.
- `engines.node >= 20` — global `fetch` and `AbortSignal` without polyfills.
  Dev/CI Node is pinned in `.tool-versions` (asdf locally, `setup-node`'s
  `node-version-file` in CI) so the two cannot drift.
- Versioning: release-please on `main` (conventional commits), `0.x` while the
  API settles.
- Publishing: GitHub Releases trigger `npm publish --provenance` via npm
  **trusted publishing** (OIDC). No npm token lives in this repo.

---

## 9. Risks & open questions

- **Poll interval vs. flip latency.** 30s means a flag flip reaches the fleet
  in up to ~36s (jitter included). Fine for rollout gating; not a kill switch
  with an SLA. If sub-second propagation is ever needed, that is a different
  transport, not a smaller `pollSeconds`.
- **One document per client.** Multiple `CruFlags` instances poll
  independently. A shared-cache-by-URL registry is deliberately not built
  until someone needs it.
- **`ETag` is the `Version`.** If the service ever changes `ETag` derivation,
  nothing here breaks (the value is opaque), but a weak-`ETag` (`W/"3"`)
  prefix change would be echoed back verbatim, which is still correct.
- **No `Retry-After` handling.** If the service starts rate-limiting, honoring
  `Retry-After` on 429 is the natural first extension.
