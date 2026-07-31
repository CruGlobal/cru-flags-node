import { parseDocument } from "./document.js";
import { FlagsError } from "./errors.js";
import type {
  CruFlagsOptions,
  FlagsDocument,
  FlagsErrorHandler,
  FlagsHealthEvent,
} from "./types.js";

/** Environment variable holding the flag document URL. */
export const URL_ENV_VAR = "CRU_FLAGS_URL";

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_FETCH_TIMEOUT_MS = 2000;

/** ±20% — see `docs/design.md` §4.3 (why jitter). */
const JITTER = 0.2;

/** Longest error-body excerpt carried into a `FlagsError` message. */
const SNIPPET_LIMIT = 200;

/**
 * A client for one flag document.
 *
 * Most applications use the pre-built {@link flags} singleton. Construct this
 * directly to inject configuration in tests, or to read more than one
 * document in the same process.
 *
 * Construction is inert: no environment is read, no request is made and no
 * timer is created until the first {@link CruFlags.enabled},
 * {@link CruFlags.ready} or {@link CruFlags.snapshot} call.
 *
 * @example
 * ```ts
 * const client = new CruFlags({ url, pollSeconds: 30 });
 * await client.ready();
 * client.enabled("checkout_v2");
 * ```
 */
export class CruFlags {
  readonly #configuredUrl: string | undefined;
  readonly #pollSeconds: number;
  readonly #fetchTimeoutMs: number;
  readonly #onError: FlagsErrorHandler;

  /** Resolved at start; `null` means inert (no URL configured). */
  #url: string | null = null;

  /** Last-known-good document, or `null` before the first success / after 404. */
  #document: FlagsDocument | null = null;

  /** `ETag` of the document in `#document` — only ever set with a good parse. */
  #etag: string | null = null;

  #started = false;
  #closed = false;

  /** Health latch for `onError`. Starts healthy so the first failure reports. */
  #healthy = true;

  #timer: ReturnType<typeof setTimeout> | null = null;

  readonly #ready: Promise<void>;
  readonly #resolveReady: () => void;

  constructor(options: CruFlagsOptions = {}) {
    this.#configuredUrl = normalizeUrl(options.url);
    this.#pollSeconds = positive(options.pollSeconds, DEFAULT_POLL_SECONDS);
    this.#fetchTimeoutMs = positive(
      options.fetchTimeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
    );
    this.#onError = options.onError ?? warnOnHealthChange;

    // The executor runs synchronously, so `resolve` is assigned before the
    // constructor returns — no definite-assignment assertion needed.
    let resolve: () => void = () => undefined;
    this.#ready = new Promise<void>((res) => {
      resolve = res;
    });
    this.#resolveReady = resolve;
  }

  /**
   * Is `name` switched on?
   *
   * Synchronous, I/O-free and total: it **never throws**. An unknown flag, a
   * document that hasn't arrived yet, a malformed entry, or an unconfigured
   * client all yield `false`. The value is exactly
   * `Flags[name]?.Enabled === true` — nothing is coerced.
   *
   * The first call starts the background poll but does not wait for it; use
   * {@link CruFlags.ready} if you need the first document before deciding.
   */
  enabled(name: string): boolean {
    try {
      this.#start();
      return this.#document?.Flags[name]?.Enabled === true;
    } catch {
      // `enabled()` is on the hot path of applications that may be mid-outage.
      // Whatever just went wrong, the answer is "not enabled".
      return false;
    }
  }

  /**
   * Resolve once the first fetch **attempt** has completed — success, 404, or
   * failure alike. Never rejects.
   *
   * This is a warmup hook (AWS Lambda init, container start), not a health
   * check: a resolved promise does not promise that a document exists. On an
   * unconfigured client it resolves immediately.
   */
  ready(): Promise<void> {
    this.#start();
    return this.#ready;
  }

  /**
   * The document currently in effect — deep-frozen, or `null` before the first
   * success and after a 404.
   *
   * Object identity is meaningful: a `200` installs a **new** frozen object,
   * while a `304` keeps the **same** one.
   */
  snapshot(): FlagsDocument | null {
    this.#start();
    return this.#document;
  }

  /**
   * Stop polling permanently and release the timer.
   *
   * Optional in long-lived processes — the poll timer is `unref()`'d, so it
   * never keeps the event loop alive — but useful in tests and short-lived
   * tools that want a hard stop.
   */
  close(): void {
    this.#closed = true;
    this.#clearTimer();
    this.#resolveReady();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Lazy start (`docs/design.md` §4.1). Resolves the URL, fires the first
   * fetch and arms the poll loop. Idempotent, synchronous, and never throws.
   */
  #start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;

    const url = this.#configuredUrl ?? urlFromEnvironment();
    if (url === undefined) {
      // Inert: no URL, so no timer, no request and — deliberately — no
      // warning. Unconfigured is a normal state (§4.2).
      this.#resolveReady();
      return;
    }

    this.#url = url;
    this.#run();
  }

  /** Run one poll tick, then arm the next one. Never rejects. */
  #run(): void {
    void this.#tick().catch(() => {
      // `#tick` is written not to reject. If it ever does, keep the loop
      // alive and unblock `ready()` rather than silently going dark.
      this.#resolveReady();
      this.#schedule();
    });
  }

  async #tick(): Promise<void> {
    const url = this.#url;
    if (url === null || this.#closed) return;
    await this.#fetchOnce(url);
    this.#resolveReady();
    this.#schedule();
  }

  /**
   * Poll interval with ±20% jitter, re-rolled every tick, scheduled only
   * *after* the previous fetch settled so polls can never overlap or pile up
   * behind a slow service.
   */
  #schedule(): void {
    if (this.#closed || this.#url === null) return;
    this.#clearTimer();

    const jitter = 1 - JITTER + Math.random() * JITTER * 2;
    const delayMs = this.#pollSeconds * 1000 * jitter;

    const timer = setTimeout(() => {
      this.#timer = null;
      this.#run();
    }, delayMs);

    // Hard requirement (§4.4): the client must never hold a process open.
    unrefTimer(timer);
    this.#timer = timer;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * One request. Never throws: every outcome ends in `#succeed` or `#fail`,
   * and a failure always leaves the previous snapshot in place (fail-static,
   * §4.5).
   */
  async #fetchOnce(url: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new FlagsError(
          "timeout",
          `flag fetch timed out after ${this.#fetchTimeoutMs}ms`,
        ),
      );
    }, this.#fetchTimeoutMs);
    unrefTimer(timeout);

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      // Revalidate rather than re-download: a 304 is ~200 bytes.
      if (this.#etag !== null) headers["if-none-match"] = this.#etag;

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "follow",
      });

      if (response.status === 304) {
        // Unchanged — keep the existing frozen snapshot object as-is.
        this.#succeed(url);
        return;
      }

      if (response.status === 404) {
        // "No document yet": a successful answer meaning "no flags", not a
        // failure. Never reported through `onError` (§2.1).
        this.#document = null;
        this.#etag = null;
        this.#succeed(url);
        return;
      }

      if (!response.ok) {
        throw new FlagsError(
          "http",
          `flag fetch failed with HTTP ${response.status}${await readSnippet(response)}`,
          { status: response.status },
        );
      }

      const document = parseDocument(await response.text());

      // Order matters: the `ETag` is stored only alongside a document we
      // actually parsed. Storing it for a body we rejected would make every
      // later poll a 304 and pin the client to that bad response forever.
      this.#document = document;
      this.#etag = response.headers.get("etag");
      this.#succeed(url);
    } catch (error) {
      this.#fail(url, toFlagsError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  #succeed(url: string): void {
    if (!this.#healthy) {
      this.#healthy = true;
      this.#emit({ kind: "recovered", url });
    }
  }

  #fail(url: string, error: FlagsError): void {
    if (this.#healthy) {
      this.#healthy = false;
      this.#emit({ kind: "failing", url, error });
    }
    // Otherwise: already known to be failing. Reporting every poll would be
    // ~2,880 identical lines per day per instance (§5).
  }

  #emit(event: FlagsHealthEvent): void {
    try {
      this.#onError(event);
    } catch {
      // A broken health handler must not break the poll loop or surface as an
      // unhandled rejection.
    }
  }
}

function normalizeUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Read the URL from the environment at *start* time, not import time, so a
 * process that sets `CRU_FLAGS_URL` after importing this module still works.
 */
function urlFromEnvironment(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return normalizeUrl(process.env[URL_ENV_VAR]);
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Release the event-loop reference. Node returns a `Timeout` object; other
 * runtimes return a number and have nothing to unref.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void };
  handle.unref?.();
}

/** Drain an error response and keep a short excerpt for the error message. */
async function readSnippet(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    if (body === "") return "";
    const excerpt =
      body.length > SNIPPET_LIMIT ? `${body.slice(0, SNIPPET_LIMIT)}…` : body;
    return `: ${excerpt}`;
  } catch {
    // The body is a nice-to-have; the status is the news.
    return "";
  }
}

function toFlagsError(error: unknown): FlagsError {
  // `fetch` rejects with the abort *reason*, so our timeout arrives here as
  // the `FlagsError` we constructed, and parse failures arrive as themselves.
  if (error instanceof FlagsError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FlagsError("network", `flag fetch failed: ${message}`, {
    cause: error,
  });
}

/** Default `onError`: one line when polling breaks, one when it recovers. */
function warnOnHealthChange(event: FlagsHealthEvent): void {
  if (event.kind === "failing") {
    console.warn(
      `[@cruglobal/flags] polling ${event.url} is failing; serving last-known-good flags (${event.error.message})`,
    );
    return;
  }
  console.warn(`[@cruglobal/flags] polling ${event.url} recovered`);
}
