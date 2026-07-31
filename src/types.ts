import type { FlagsError } from "./errors.js";

/**
 * One flag entry inside a flag document.
 *
 * `Enabled` is the only field this library interprets. Everything else is
 * carried through verbatim — the service is free to add fields, and an older
 * client must never reject a document from a newer service. Today the extra
 * fields are `Description`, `CreatedAt`, `UpdatedAt` and `UpdatedBy`.
 */
export interface FlagDefinition {
  readonly Enabled?: boolean;
  readonly [key: string]: unknown;
}

/**
 * A flag document, exactly as published by the service:
 *
 * ```jsonc
 * {
 *   "Project": "ararat",
 *   "Environment": "release-candidate",
 *   "Version": 3,
 *   "NotifySlack": true,
 *   "Flags": { "pilot_banner": { "Enabled": true } }
 * }
 * ```
 *
 * Stored documents are deep-frozen and JSON-round-trippable.
 */
export interface FlagsDocument {
  readonly Project?: string;
  readonly Environment?: string;
  readonly Version?: number;
  readonly NotifySlack?: boolean;
  readonly Flags: Readonly<Record<string, FlagDefinition>>;
  readonly [key: string]: unknown;
}

/**
 * A health-state transition. Emitted at most once per transition — never once
 * per poll (see `docs/design.md` §5).
 */
export type FlagsHealthEvent =
  | {
      /** Polling just started failing. */
      readonly kind: "failing";
      readonly url: string;
      readonly error: FlagsError;
    }
  | {
      /** A poll succeeded after one or more failures. */
      readonly kind: "recovered";
      readonly url: string;
    };

/** Health-transition handler. Must not throw (a throw is caught and ignored). */
export type FlagsErrorHandler = (event: FlagsHealthEvent) => void;

/** Options for {@link CruFlags}. */
export interface CruFlagsOptions {
  /**
   * Flag document URL. Defaults to `process.env.CRU_FLAGS_URL`, read when the
   * client starts (first `enabled()` / `ready()` call), not at construction.
   * An empty or absent URL makes the client inert: every flag is `false`, no
   * timers, no requests, no logging.
   */
  readonly url?: string;

  /**
   * Background poll interval in seconds, jittered ±20% on every tick.
   * Defaults to 30.
   */
  readonly pollSeconds?: number;

  /** Per-request timeout in milliseconds. Defaults to 2000. */
  readonly fetchTimeoutMs?: number;

  /**
   * Called on health transitions only. Defaults to a `console.warn` handler.
   */
  readonly onError?: FlagsErrorHandler;
}
