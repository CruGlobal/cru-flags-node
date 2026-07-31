import { FlagsError } from "./errors.js";
import type { FlagDefinition, FlagsDocument } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Freeze `value` and everything reachable from it.
 *
 * Flag documents come out of `JSON.parse`, so the graph is finite, acyclic,
 * and made only of objects, arrays and primitives — no cycle guard needed.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * Parse a flag document from a response body.
 *
 * Pure and synchronous: text in, deep-frozen document out. Throws
 * {@link FlagsError} with `code: "parse"` on anything unusable, which the
 * client turns into an ordinary poll failure — so a bad deploy of the
 * *service* can never take down a client (`docs/design.md` §4.5).
 *
 * Deliberately lenient about everything it does not interpret:
 *
 * - Unknown top-level and per-flag keys are preserved verbatim.
 * - A missing or `null` `Flags` normalizes to `{}`.
 * - A flag entry that is not an object is dropped, rather than failing the
 *   whole document — one malformed flag must not blind the app to the rest.
 * - A missing or non-boolean `Enabled` simply means "not enabled".
 */
export function parseDocument(text: string): FlagsDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new FlagsError("parse", "flag document is not valid JSON", { cause });
  }

  if (!isPlainObject(raw)) {
    throw new FlagsError(
      "parse",
      `flag document must be a JSON object, got ${describe(raw)}`,
    );
  }

  const rawFlags = raw.Flags;
  if (rawFlags !== undefined && rawFlags !== null && !isPlainObject(rawFlags)) {
    throw new FlagsError(
      "parse",
      `flag document "Flags" must be an object, got ${describe(rawFlags)}`,
    );
  }

  const flags: Record<string, FlagDefinition> = {};
  if (isPlainObject(rawFlags)) {
    for (const [name, entry] of Object.entries(rawFlags)) {
      if (isPlainObject(entry)) flags[name] = entry;
    }
  }

  return deepFreeze({ ...raw, Flags: flags });
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
