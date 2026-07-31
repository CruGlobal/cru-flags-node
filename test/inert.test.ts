/**
 * Unconfigured behaviour: with `CRU_FLAGS_URL` unset the client must be inert
 * *and silent* — no timers, no requests, no warnings (`docs/design.md` §4.2).
 *
 * This file owns the `flags` singleton assertions, so it must not set
 * `CRU_FLAGS_URL`; vitest isolates modules per file, so the singleton here is
 * unrelated to the one in other test files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CruFlags, URL_ENV_VAR, flags } from "../src/index.js";
import {
  FlagServer,
  SAMPLE_DOCUMENT,
  serveDocument,
} from "./helpers/server.js";

function timerCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

describe("with CRU_FLAGS_URL unset", () => {
  beforeEach(() => {
    delete process.env[URL_ENV_VAR];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports every flag as false", () => {
    const client = new CruFlags();

    expect(client.enabled("anything")).toBe(false);
    expect(client.snapshot()).toBeNull();
  });

  it("resolves ready() immediately", async () => {
    const client = new CruFlags();

    await expect(client.ready()).resolves.toBeUndefined();
  });

  it("never fetches", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new CruFlags();

    client.enabled("anything");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates no timer", async () => {
    const before = timerCount();
    const client = new CruFlags();

    await client.ready();
    client.enabled("anything");

    expect(timerCount()).toBe(before);
  });

  it("logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = new CruFlags();

    await client.ready();
    client.enabled("anything");

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the exported `flags` singleton inert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(flags.enabled("anything")).toBe(false);
    await expect(flags.ready()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a blank URL as unset", async () => {
    process.env[URL_ENV_VAR] = "   ";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new CruFlags();

    await client.ready();

    expect(client.enabled("alpha")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("environment configuration", () => {
  it("reads CRU_FLAGS_URL at start time, not import time", async () => {
    const server = await FlagServer.start(serveDocument(SAMPLE_DOCUMENT));
    try {
      // The module was imported at the top of this file, long before the
      // variable existed. Lazy start is what makes this work (§4.1).
      process.env[URL_ENV_VAR] = server.url;
      const client = new CruFlags();

      await client.ready();

      expect(client.enabled("alpha")).toBe(true);
      client.close();
    } finally {
      delete process.env[URL_ENV_VAR];
      await server.stop();
    }
  });

  it("prefers an explicit url over the environment", async () => {
    const server = await FlagServer.start(serveDocument(SAMPLE_DOCUMENT));
    try {
      process.env[URL_ENV_VAR] = "http://127.0.0.1:1/never-used";
      const client = new CruFlags({ url: server.url });

      await client.ready();

      expect(client.enabled("alpha")).toBe(true);
      expect(server.hits).toBe(1);
      client.close();
    } finally {
      delete process.env[URL_ENV_VAR];
      await server.stop();
    }
  });
});
