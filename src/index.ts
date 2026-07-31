/**
 * `@cruglobal/flags` — the official Node.js client for Cru's pipeline feature
 * flag service.
 *
 * ```ts
 * import { flags } from "@cruglobal/flags";
 *
 * await flags.ready();          // optional: warm up during init
 * flags.enabled("checkout_v2"); // boolean, sync, never throws
 * ```
 *
 * See `docs/design.md` for the wire contract and the reasoning behind the
 * behavioural guarantees (fail-static, transition-only logging, unref'd
 * timers).
 */

import { CruFlags } from "./client.js";

export { CruFlags, REFRESH_MODE_ENV_VAR, URL_ENV_VAR } from "./client.js";
export { FlagsError } from "./errors.js";
export type { FlagsErrorCode } from "./errors.js";
export type {
  CruFlagsOptions,
  FlagDefinition,
  FlagsDocument,
  FlagsErrorHandler,
  FlagsHealthEvent,
  RefreshMode,
  RefreshOptions,
} from "./types.js";

/**
 * The shared client, configured from `CRU_FLAGS_URL`.
 *
 * Importing this does nothing: the environment is read, and polling starts, on
 * the first `enabled()` / `ready()` / `snapshot()` call. With `CRU_FLAGS_URL`
 * unset the client is inert and silent — every flag is `false`.
 */
export const flags = new CruFlags();
