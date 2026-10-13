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

/**
 * Enough of a run for the client to work on. `transcript` and `log` are here
 * because the client writes the player's line into both the moment they press
 * return — see the optimistic stage below — rather than waiting for the server
 * to hand its copy back.
 */
const run = (version: number, stage = "awaiting_action", extra: Record<string, unknown> = {}) => ({
  id: "run-1",
  version,
  state: { stage, step: "1-target", log: [], transcript: [], turnCount: 0, ...extra },
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
      // The cover, asked for as the run starts and not waited on.
      "GET /api/runs/run-1/cover",
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

/*
 * PHASE 13a. A world outlives the run played in it, so going back down one that
 * is already written must not build anything. What is worth pinning here is the
 * ABSENCE of requests: the failure mode is a path that quietly generates anyway
 * and costs N+2 model calls to arrive at a dungeon that was already there.
 */
describe("going down a world that is already written", () => {
  it("is one request and no generation at all", async () => {
    routes.set("POST /api/runs", () => ({ json: { run: run(1), dungeon: { id: "dungeon_rx" } } }));
    routes.set("POST /api/runs/run-1/enter", () => ({ json: { state: run(2).state, version: 2 } }));

    const session = createRemoteSession();
    await session.beginIn!({ dungeonId: "dungeon_rx", character: testCharacter() });

    // No structure pass, no regions, no join — and therefore no bill.
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/runs",
      // The cover, asked for as the run starts and not waited on.
      "GET /api/runs/run-1/cover",
      "POST /api/runs/run-1/enter",
    ]);
  });

  /**
   * THE DUNGEON IS NAMED, NOT DESCRIBED. Size, level and seed are facts about a
   * world that exists; a client restating them could state them wrongly, and the
   * server would then have to decide which of the two it believed.
   */
  it("sends the dungeon id and the character, and nothing about the dice", async () => {
    routes.set("POST /api/runs", () => ({ json: { run: run(1), dungeon: { id: "dungeon_rx" } } }));
    routes.set("POST /api/runs/run-1/enter", () => ({ json: { state: run(2).state, version: 2 } }));

    const session = createRemoteSession();
    await session.beginIn!({ dungeonId: "dungeon_rx", character: testCharacter() });

    expect(Object.keys(sent[0]!.body!).sort()).toEqual(["character", "dungeonId"]);
    expect(sent[0]!.body).toMatchObject({ dungeonId: "dungeon_rx" });
  });

  it("lands the run and the world it came back with", async () => {
    routes.set("POST /api/runs", () => ({ json: { run: run(1), dungeon: { id: "dungeon_rx" } } }));
    routes.set("POST /api/runs/run-1/enter", () => ({
      json: { state: run(2, "awaiting_action", { turnCount: 0 }).state, version: 2 },
    }));

    const session = createRemoteSession();
    await session.beginIn!({ dungeonId: "dungeon_rx", character: testCharacter() });

    expect(session.store.getState().dungeon).toMatchObject({ id: "dungeon_rx" });
    expect(session.store.getState().run).toMatchObject({ stage: "awaiting_action" });
  });

  /** The same latch `begin` and `resume` hold — StrictMode's double mount. */
  it("does not send two people down one hole", async () => {
    routes.set("POST /api/runs", () => ({ json: { run: run(1), dungeon: { id: "dungeon_rx" } } }));
    routes.set("POST /api/runs/run-1/enter", () => ({ json: { state: run(2).state, version: 2 } }));

    const session = createRemoteSession();
    await session.beginIn!({ dungeonId: "dungeon_rx", character: testCharacter() });
    const after = sent.length;

    await session.beginIn!({ dungeonId: "dungeon_rx", character: testCharacter() });
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

    // The turn comes back with a roll on the table, which is what makes the
    // roll below a legal move — the client refuses one otherwise.
    const offered = run(3, "roll_offered", { pendingRoll: { ability: "str", dc: 12 } });
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: offered.state, version: 3 } }));
    await session.submit("one");
    routes.set("POST /api/runs/run-1/roll", () => ({ json: { state: run(4).state, version: 4 } }));
    await session.roll();

    expect(sent.at(-1)!.body).toEqual({ version: 3 });
    expect(session.store.getState().run).toMatchObject({ stage: "awaiting_action" });
  });
});

/**
 * WHAT THE SCREEN DOES WHILE THE SERVER THINKS.
 *
 * The whole interface reads `run.stage`, and this file used not to move it until
 * the reply landed — so for the length of a referee call the input stayed open,
 * the sweep never ran, and the player's own line was not on the page. It read as
 * a game that had not noticed them. These pin the stage DURING the request,
 * which is the only place the bug ever existed.
 */
describe("while the request is in flight", () => {
  it("closes the input and puts the player's line up the moment they submit", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3).state, version: 3 } }));
    const inFlight = session.submit("I search the floor");

    // Read WITHOUT awaiting: this is the tick the keypress happens on, and the
    // request has not been answered on it. Everything the interface needs is
    // already true here or it is not optimistic at all.
    const during = session.store.getState().run!;
    expect(during.stage).toBe("thinking");
    expect(during.log.at(-1)).toMatchObject({ kind: "player", text: "I search the floor" });
    expect(during.transcript.at(-1)).toMatchObject({ role: "player", text: "I search the floor" });

    await inFlight;
    expect(session.store.getState().run).toMatchObject({ stage: "awaiting_action" });
  });

  it("refuses a second action while the first is still out", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3).state, version: 3 } }));
    const first = session.submit("I search the floor");

    // The player, seeing nothing happen, types three more things. Every one of
    // them used to become a request the server refused as `busy`.
    const before = sent.length;
    await session.submit("hello?");
    await session.submit("is this on?");
    await session.roll();
    expect(sent).toHaveLength(before);

    await first;
  });

  /*
   * TWO REQUESTS FOR ONE ROLL. The dice came back with the prose, so the
   * player watched a spinner over a number the server already had. Now
   * `/roll` answers at once with the die in the log, and `/resolve` is the wait.
   */
  it("throws the dice, shows them, and only then asks for the outcome", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    const offered = run(3, "roll_offered", { pendingRoll: { ability: "str", dc: 12 } });
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: offered.state, version: 3 } }));
    await session.submit("I heave at the slab");

    const thrown = run(4, "resolving", {
      step: "5-resolution",
      log: [{ kind: "roll", text: "STR save: 15 +2 = 17", turn: 0 }],
      pending: { roll: { total: 17 }, step: "5-resolution", entering: false },
    });
    let resolveSeen: unknown;
    routes.set("POST /api/runs/run-1/roll", () => ({ json: { state: thrown.state, version: 4 } }));
    routes.set("POST /api/runs/run-1/resolve", (body) => {
      resolveSeen = session.store.getState().run;
      return { json: { state: run(5, "awaiting_action").state, version: 5, body } };
    });

    const rolling = session.roll();
    // The throw is a fast request; `rolling` is honest for its length.
    expect(session.store.getState().run).toMatchObject({ stage: "rolling" });
    await rolling;

    const paths = sent.map((x) => x.path).filter((p) => /roll|resolve/.test(p));
    expect(paths).toEqual(["/api/runs/run-1/roll", "/api/runs/run-1/resolve"]);
    // While the outcome was being written, the die was already on the screen.
    expect(resolveSeen).toMatchObject({ stage: "resolving", log: [{ kind: "roll" }] });
    // And `/resolve` answered the version `/roll` handed back.
    expect(sent.at(-1)!.body).toMatchObject({ version: 4 });
    expect(session.store.getState().run).toMatchObject({ stage: "awaiting_action" });
  });

  it("does not ask for an outcome when the throw did not land", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    const offered = run(3, "roll_offered", { pendingRoll: { ability: "str", dc: 12 } });
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: offered.state, version: 3 } }));
    await session.submit("I heave at the slab");

    routes.set("POST /api/runs/run-1/roll", () => ({ status: 500, json: { error: "down" } }));
    await session.roll();

    expect(sent.some((x) => x.path.endsWith("/resolve"))).toBe(false);
    expect(session.store.getState().run).toMatchObject({ stage: "error" });
  });

  it("does not act at all once the run is over", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3, "dead").state, version: 3 } }));
    await session.submit("I drink the vial");

    const after = sent.length;
    await session.submit("I get up");
    await session.roll();
    await session.retry();
    expect(sent).toHaveLength(after);
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

  /**
   * NOT a rejection any more, and that is the fix.
   *
   * `App` calls these as `void session.submit(…)`, so a thrown error was an
   * unhandled promise and nothing whatsoever on the screen — the run sat in
   * `thinking` with no way out. The in-process machine has always reported a
   * failed turn by landing on `error`, where the interface has a card and a
   * button for it, and this reports it the same way.
   */
  it("lands on the error stage when the request itself fails", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ status: 500, json: { error: "the model is down" } }));
    await expect(session.submit("I search the floor")).resolves.toBeUndefined();
    expect(session.store.getState().run).toMatchObject({ stage: "error" });
  });
});

/**
 * THE WAY OUT OF `error`, which had none.
 *
 * `POST /retry` asks the server to repeat the ask it recorded, and it only has
 * one to repeat if it got far enough to record it. A request that never arrived
 * left the server on the stage before, so retrying it there would be asking a
 * run that is not in trouble to recover from trouble — it has to be sent again
 * as itself instead. Both routes end at the same button.
 */
describe("trying again", () => {
  it("re-sends the request that never landed", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ status: 500, json: { error: "the model is down" } }));
    await session.submit("I search the floor");
    expect(session.store.getState().run).toMatchObject({ stage: "error" });

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3).state, version: 3 } }));
    await session.retry();

    // The same action, at the same version — not a bare `/retry` the server
    // would have had nothing to do with.
    expect(sent.at(-1)).toMatchObject({
      path: "/api/runs/run-1/turn",
      body: { text: "I search the floor", version: 2 },
    });
    expect(session.store.getState().run).toMatchObject({ stage: "awaiting_action" });
  });

  it("asks the server to repeat an ask that failed on its side", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    // The referee failed on the server: it caught that itself, stored what it
    // was doing, and answered normally with the run in `error`.
    const broken = run(3, "error", {
      step: "3-standard",
      pending: { input: "I search the floor", step: "3-standard", entering: false },
    });
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: broken.state, version: 3 } }));
    await session.submit("I search the floor");

    routes.set("POST /api/runs/run-1/retry", () => ({ json: { state: run(4).state, version: 4 } }));
    const retrying = session.retry();
    // Back to the stage the ask was made from, read off the server's own record
    // of it — the same three-way `turn.ts` makes from the same field.
    expect(session.store.getState().run).toMatchObject({ stage: "thinking", step: "3-standard" });
    await retrying;

    expect(sent.at(-1)).toMatchObject({ path: "/api/runs/run-1/retry", body: { version: 3 } });
  });

  it("shows a failed room entry as one, not as a turn", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    const broken = run(3, "error", {
      step: "room-entry",
      pending: { step: "room-entry", entering: true },
    });
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: broken.state, version: 3 } }));
    await session.submit("I go north");

    routes.set("POST /api/runs/run-1/retry", () => ({ json: { state: run(4).state, version: 4 } }));
    const retrying = session.retry();
    expect(session.store.getState().run).toMatchObject({ stage: "room_entry" });
    await retrying;
  });

  it("does nothing when there is nothing to repeat", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    // An error with no record of what caused it — a run that broke before the
    // server kept one. There is no honest guess to make.
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3, "error").state, version: 3 } }));
    await session.submit("I search the floor");

    const after = sent.length;
    await session.retry();
    expect(sent).toHaveLength(after);
  });
});

/*
 * PHASE 12. A run outlives the tab it was played in, and can be ended by the
 * player rather than only by the fiction.
 */

describe("picking a run back up", () => {
  /** What `GET /api/runs/:id` answers with, which is the whole save. */
  function stored(stage: string, extra: Record<string, unknown> = {}) {
    return {
      run: { ...run(7, stage, extra), id: "run-1" },
      dungeon: { id: "dungeon_rx" },
    };
  }

  it("is one request, and nothing is replayed", async () => {
    routes.set("GET /api/runs/run-1", () => ({ json: stored("awaiting_action") }));
    const session = createRemoteSession();
    await session.resume!("run-1");

    // No generation, no journal, no turns re-run. `runs.state` IS the save.
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/runs/run-1"]);
  });

  it("lands the state and the version the server holds", async () => {
    routes.set("GET /api/runs/run-1", () => ({
      json: stored("awaiting_action", { turnCount: 14, currentRoomId: "room-3" }),
    }));
    const session = createRemoteSession();
    await session.resume!("run-1");

    expect(session.store.getState().run).toMatchObject({
      stage: "awaiting_action",
      turnCount: 14,
      currentRoomId: "room-3",
    });
    expect(session.store.getState().dungeon).toMatchObject({ id: "dungeon_rx" });

    // The version came from the row, so the first turn after a resume answers
    // the version the server actually holds rather than starting from zero.
    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(8).state, version: 8 } }));
    await session.submit("I look around");
    expect(sent.at(-1)!.body).toMatchObject({ version: 7 });
  });

  /*
   * THE CASE THIS EXISTS FOR. A function that timed out or was deployed over
   * mid-turn leaves the row saying `thinking`, and `thinking` closes the input —
   * so without this the player resumes into a game that will never ask them for
   * anything again.
   */
  it("turns a run stuck mid-turn into one the player can act on", async () => {
    routes.set("GET /api/runs/run-1", () => ({
      json: stored("thinking", { step: "2-classify", pending: { step: "2-classify", entering: false } }),
    }));
    const session = createRemoteSession();
    await session.resume!("run-1");

    expect(session.store.getState().run).toMatchObject({ stage: "error", step: "2-classify" });
    // Locally only. Nothing was written and no version was spent — the row still
    // says what it said.
    expect(sent).toHaveLength(1);
  });

  it("repeats the interrupted ask when the player retries", async () => {
    routes.set("GET /api/runs/run-1", () => ({
      json: stored("resolving", { step: "5-resolution", pending: { step: "5-resolution", entering: false, roll: {} } }),
    }));
    const session = createRemoteSession();
    await session.resume!("run-1");

    routes.set("POST /api/runs/run-1/retry", () => ({ json: { state: run(8).state, version: 8 } }));
    await session.retry();
    expect(sent.map((s) => `${s.method} ${s.path}`)).toContain("POST /api/runs/run-1/retry");
  });

  it("leaves a finished run finished", async () => {
    routes.set("GET /api/runs/run-1", () => ({ json: stored("dead") }));
    const session = createRemoteSession();
    await session.resume!("run-1");
    expect(session.store.getState().run).toMatchObject({ stage: "dead" });
  });

  it("does not resume twice", async () => {
    routes.set("GET /api/runs/run-1", () => ({ json: stored("awaiting_action") }));
    const session = createRemoteSession();
    await session.resume!("run-1");
    await session.resume!("run-1");
    expect(sent).toHaveLength(1);
  });
});

describe("abandoning", () => {
  it("posts the version and nothing else", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/abandon", () => ({
      json: { state: run(3, "abandoned").state, version: 3 },
    }));
    await session.abandon();

    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/runs/run-1/abandon",
      body: { version: 2 },
    });
    expect(session.store.getState().run).toMatchObject({ stage: "abandoned" });
  });

  /*
   * NO PREDICTED STAGE, unlike every other verb. The others guess a BUSY stage
   * while they wait, which is safe because a busy stage asks for nothing.
   * `abandoned` is terminal, and showing a player the end of their run before
   * the server has agreed to it would be showing them an ending that might not
   * land.
   */
  it("does not show the ending before the server has agreed to it", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    let stageWhileInFlight: string | undefined;
    routes.set("POST /api/runs/run-1/abandon", () => {
      stageWhileInFlight = session.store.getState().run!.stage;
      return { json: { state: run(3, "abandoned").state, version: 3 } };
    });
    await session.abandon();

    expect(stageWhileInFlight).toBe("awaiting_action");
  });

  it("refuses to end a run that is already over", async () => {
    wireGeneration([0]);
    const session = createRemoteSession();
    await begin(session);

    routes.set("POST /api/runs/run-1/turn", () => ({ json: { state: run(3, "dead").state, version: 3 } }));
    await session.submit("I drink the whole vial");

    const after = sent.length;
    await session.abandon();
    expect(sent).toHaveLength(after);
  });
});
