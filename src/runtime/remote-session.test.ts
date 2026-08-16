/**
 * The client half of the API.
 *
 * What is worth checking here is not that fetch works — it is that the client
 * sends exactly what the server's contract says and nothing more. The whole
 * security posture of Phase 10 is that the client asserts no rule: it says what
 * the player typed and which version it last saw, and the server decides
 * everything else. A client that quietly grew a `stage` field would break that
 * without breaking anything visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteSession } from "./remote-session.ts";
import type { GenerationProgress } from "./generate.ts";
import { testCharacter } from "./__fixtures__/offline.ts";

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

let sent: Sent[];
/** Keyed by `METHOD /path`; a function so a route can answer differently. */
let routes: Map<string, (body: unknown) => { status?: number; json: unknown }>;

beforeEach(() => {
  sent = [];
  routes = new Map();

  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });

    const route = routes.get(`${method} ${path}`);
    if (!route) return { ok: false, status: 404, json: async () => ({ error: `no route ${method} ${path}` }) };

    const { status = 200, json } = route(body);
    return { ok: status < 400, status, json: async () => json };
  });
});

afterEach(() => vi.unstubAllGlobals());

const run = (version: number, stage = "awaiting_action") => ({
  id: "run-1",
  version,
  state: { stage, log: [], turnCount: 0 },
});

/** The happy path through generation, so `begin` can get to a playable run. */
function wireGeneration(chunks = [0, 1]) {
  routes.set("POST /api/dungeons", () => ({ json: { dungeonId: "dungeon_rx", chunks } }));
  for (const n of chunks) {
    routes.set(`POST /api/dungeons/dungeon_rx/chunks/${n}`, () => ({ json: { chunk: n, done: true } }));
  }
  routes.set("POST /api/dungeons/dungeon_rx/finish", () => ({ json: { dungeonId: "dungeon_rx" } }));
  routes.set("POST /api/runs", () => ({ json: { run: run(1), dungeon: { id: "dungeon_rx" } } }));
  routes.set("POST /api/runs/run-1/enter", () => ({ json: { state: run(2).state, version: 2 } }));
}

const begin = (s: ReturnType<typeof createRemoteSession>) =>
  s.begin({ seed: 1005, size: 2, level: 1, character: testCharacter() });

describe("generating through the API", () => {
  it("is three requests, with the regions in parallel", async () => {
    wireGeneration([0, 1, 2]);
    const progress: GenerationProgress[] = [];
    await begin(createRemoteSession({ onProgress: (p) => progress.push(p) }));

    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/dungeons",
      "POST /api/dungeons/dungeon_rx/chunks/0",
      "POST /api/dungeons/dungeon_rx/chunks/1",
      "POST /api/dungeons/dungeon_rx/chunks/2",
      "POST /api/dungeons/dungeon_rx/finish",
      "POST /api/runs",
      "POST /api/runs/run-1/enter",
    ]);

    // Each region reports as it lands, which is a real thing finishing rather
    // than a step inside a function nobody can see.
    const writing = progress.filter((p) => p.stage === "writing");
    expect(writing.map((p) => p.chunksDone)).toEqual([0, 1, 2, 3]);
  });

  it("does not build a second dungeon on a second begin", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);
    const after = sent.length;

    // StrictMode's development double-mount.
    await begin(session);
    expect(sent).toHaveLength(after);
  });
});

describe("a turn", () => {
  it("sends what the player typed and the version, and nothing else", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3).state, version: 3 } }));
    await session.submit("I search the floor");

    const turn = sent.at(-1)!;
    // THE WHOLE CONTRACT. No stage, no commit, no roll, no dice — a client that
    // could name its own stage could name a flattering one.
    expect(turn.body).toEqual({ text: "I search the floor", version: 2 });
  });

  it("carries the new version into the next turn", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3).state, version: 3 } }));
    await session.submit("one");
    routes.set("POST /api/runs/run-1/roll", () => ({ json: { state: run(4).state, version: 4 } }));
    await session.roll();

    expect(sent.at(-1)!.body).toEqual({ version: 3 });
    expect(session.store.getState().run).toMatchObject({ stage: "awaiting_action" });
  });
});

/**
 * PHASE 11. The runtime does not know what a token is — it is handed a `fetch`
 * and uses it. What these check is that it uses THAT ONE for everything, because
 * the failure mode is a single overlooked call site going out unauthenticated
 * and 401ing in a corner nobody exercises. The 409 resync path was exactly such
 * a call site before this.
 */
describe("the injected fetch", () => {
  /** Records which requests went through the injected function rather than the global. */
  function spyFetch() {
    const seen: string[] = [];
    const fn = ((url: string, init?: RequestInit) => {
      seen.push(String(url));
      return (globalThis.fetch as unknown as typeof fn)(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { seen, fn };
  }

  it("is used for every request generation and a turn make", async () => {
    wireGeneration([0, 1]);
    const { seen, fn } = spyFetch();
    const session = createRemoteSession({ fetch: fn });
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3).state, version: 3 } }));
    await session.submit("I look up");

    // Every path the session took — nothing slipped out through the global.
    expect(seen.length).toBe(sent.length);
  });

  /**
   * THE ONE THAT WAS ACTUALLY WRONG. The 409 recovery re-read the run with a
   * bare `fetch`, so it would have gone out with no token and failed as a 401
   * inside the handler for a 409 — a failure inside a recovery, which is the
   * hardest kind to see.
   */
  it("is used by the 409 resync path too", async () => {
    wireGeneration([0]);
    const { seen, fn } = spyFetch();
    const session = createRemoteSession({ fetch: fn });
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({
      status: 409,
      json: { error: "stale", current: run(7) },
    }));
    routes.set("GET /api/runs/run-1", () => ({ json: { run: run(7) } }));

    const before = seen.length;
    await session.submit("anything");

    // The failed turn AND the re-read, both through the injected fetch.
    expect(seen.slice(before)).toEqual(["/api/runs/run-1/turn", "/api/runs/run-1"]);
  });
});

describe("a refusal", () => {
  it("resyncs instead of surfacing an error", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    // The other tab played three turns while this one sat there.
    routes.set("POST /api/runs/run-1/turn", () => ({ status: 409, json: { error: "stale" } }));
    routes.set("GET /api/runs/run-1", () => ({ json: { run: run(9, "roll_offered") } }));

    await expect(session.submit("I search the floor")).resolves.toBeUndefined();

    // What is on the screen is now what is true, rather than an error about it.
    expect(session.store.getState().run).toMatchObject({ stage: "roll_offered" });

    // And the next turn answers the version it just learned, not the one it had.
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(10).state, version: 10 } }));
    await session.submit("again");
    expect(sent.at(-1)!.body).toMatchObject({ version: 9 });
  });

  it("still raises anything that is not a refusal", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ status: 500, json: { error: "the model is down" } }));
    await expect(session.submit("I search the floor")).rejects.toThrow("the model is down");
  });
});
