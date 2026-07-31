/**
 * Why a poll failed.
 *
 * - `http` — the service answered with an unexpected status (5xx, 400, …).
 *   `status` carries it. Note that 404 is *not* an error (see
 *   `docs/design.md` §2.1) and 304 is a success.
 * - `network` — the request never completed: DNS, connection reset, TLS.
 * - `timeout` — `fetchTimeoutMs` elapsed and the request was aborted.
 * - `parse` — a 200 whose body was not a usable flag document.
 */
export type FlagsErrorCode = "http" | "network" | "timeout" | "parse";

/**
 * The error handed to {@link CruFlagsOptions.onError} when the client
 * transitions from healthy to failing.
 *
 * Consumers never have to catch this: `enabled()` cannot throw and
 * `ready()` cannot reject. It exists so an error handler can branch on
 * `code` / `status` instead of matching on message text.
 */
export class FlagsError extends Error {
  override readonly name = "FlagsError";

  /** Why the poll failed. */
  readonly code: FlagsErrorCode;

  /** HTTP status, when `code === "http"`. */
  readonly status: number | undefined;

  constructor(
    code: FlagsErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = options.status;
  }
}
