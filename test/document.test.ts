import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/document.js";
import { FlagsError } from "../src/errors.js";

/** The exact shape served by https://deploys.cru.org/flags/<p>/<e>. */
const LIVE_SHAPE = JSON.stringify({
  Project: "ararat",
  Environment: "release-candidate",
  Version: 3,
  NotifySlack: true,
  Flags: {
    pilot_banner: {
      Enabled: true,
      Description: "Pilot: flag-gated banner proving the flag service",
      CreatedAt: "2026-07-31T14:09:01.119Z",
      UpdatedAt: "2026-07-31T14:09:08.777Z",
      UpdatedBy: "Omicron7",
    },
  },
});

describe("parseDocument", () => {
  it("parses the live document shape", () => {
    const document = parseDocument(LIVE_SHAPE);

    expect(document.Project).toBe("ararat");
    expect(document.Environment).toBe("release-candidate");
    expect(document.Version).toBe(3);
    expect(document.NotifySlack).toBe(true);
    expect(document.Flags["pilot_banner"]?.Enabled).toBe(true);
    expect(document.Flags["pilot_banner"]?.["UpdatedBy"]).toBe("Omicron7");
  });

  it("round-trips through JSON unchanged", () => {
    const document = parseDocument(LIVE_SHAPE);

    expect(JSON.parse(JSON.stringify(document))).toEqual(
      JSON.parse(LIVE_SHAPE),
    );
  });

  it("deep-freezes the document, the flag map and each entry", () => {
    const document = parseDocument(LIVE_SHAPE);

    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.Flags)).toBe(true);
    expect(Object.isFrozen(document.Flags["pilot_banner"])).toBe(true);
  });

  it("rejects mutation of a stored snapshot", () => {
    const document = parseDocument(LIVE_SHAPE);
    const mutable = document as unknown as {
      Flags: Record<string, { Enabled: boolean }>;
    };

    expect(() => {
      mutable.Flags["pilot_banner"] = { Enabled: false };
    }).toThrow(TypeError);
    expect(document.Flags["pilot_banner"]?.Enabled).toBe(true);
  });

  it("preserves unknown top-level and per-flag fields verbatim", () => {
    const document = parseDocument(
      JSON.stringify({
        Project: "p",
        Something: { new: ["from", "a", "newer", "service"] },
        Flags: { a: { Enabled: true, Owner: "team" } },
      }),
    );

    expect(document["Something"]).toEqual({
      new: ["from", "a", "newer", "service"],
    });
    expect(document.Flags["a"]?.["Owner"]).toBe("team");
    // Nested arrays are frozen too.
    expect(
      Object.isFrozen((document["Something"] as { new: string[] }).new),
    ).toBe(true);
  });

  it("normalizes a missing or null Flags map to empty", () => {
    expect(parseDocument(JSON.stringify({ Project: "p" })).Flags).toEqual({});
    expect(
      parseDocument(JSON.stringify({ Project: "p", Flags: null })).Flags,
    ).toEqual({});
  });

  it("drops flag entries that are not objects, keeping the rest", () => {
    const document = parseDocument(
      JSON.stringify({ Flags: { good: { Enabled: true }, bad: "nope" } }),
    );

    expect(Object.keys(document.Flags)).toEqual(["good"]);
  });

  it.each([
    ["a missing Enabled", { a: {} }],
    ["a string Enabled", { a: { Enabled: "true" } }],
    ["a numeric Enabled", { a: { Enabled: 1 } }],
    ["a null Enabled", { a: { Enabled: null } }],
  ])("does not coerce %s to true", (_label, Flags) => {
    const document = parseDocument(JSON.stringify({ Flags }));

    expect(document.Flags["a"]?.Enabled === true).toBe(false);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["a JSON array", "[]"],
    ["a JSON string", '"nope"'],
    ["JSON null", "null"],
    ["a number", "3"],
    ["an array Flags", '{"Flags":[]}'],
    ["a string Flags", '{"Flags":"nope"}'],
  ])("throws a parse FlagsError for %s", (_label, body) => {
    expect(() => parseDocument(body)).toThrow(FlagsError);
    try {
      parseDocument(body);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FlagsError);
      expect((error as FlagsError).code).toBe("parse");
    }
  });

  it("does not pollute Object.prototype via a __proto__ key", () => {
    const document = parseDocument(
      '{"__proto__":{"polluted":true},"Flags":{}}',
    );

    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(document)).toBe(Object.prototype);
  });
});
