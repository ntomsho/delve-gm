/**
 * THE API
 * =======
 *
 * One Hono app, mounted as a single catch-all function. Every route the client
 * calls is here; every statement they run is in `repo.ts`.
 *
 * TWO RULES SHAPE THIS WHOLE FILE.
 *
 * ONE MODEL CALL PER REQUEST. A Vercel Hobby invocation may run for 300
 * seconds, and generation is N+2 calls. So building a dungeon is three routes —
 * structure, a region at a time, then apply-and-join — and the client fires the
 * middle one N times in parallel. A turn is one request because a turn is one
 * exchange; its worst case is `maxRounds` calls, which fits.
 *
 * THE CLIENT NEVER ASSERTS A RULE. It sends what the player typed and the
 * version it last saw. It does not say which stage it is on: a client that
 * names its own stage can name a flattering one and be handed a roll it never
 * earned. The version is opaque, so there is no value more favourable than
 * another — see `commitTurn`.
 *
 * Node only. This is the file `vite.config.ts` used to fake with two middleware
 * shims: the Anthropic proxy and the journal writer.
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import {
  chunksOf,
  finishGeneration,
  generateChunk,
  generateStructure,
} from "../runtime/generate.ts";
import { createGameSession, describeFailure } from "../runtime/session.ts";
import { newRun, type RunState } from "../store/game.ts";
import { createJournal, runId } from "../runtime/journal.ts";
import { render } from "../runtime/journal-render.ts";
import { MODELS } from "../runtime/llm/models.ts";
import { configureTransport } from "../runtime/llm/client.ts";
import type { PlayerCharacter, Size } from "../engine/index.ts";
import * as repo from "./repo.ts";

// ---------------------------------------------------------------------------
// THE APP
// ---------------------------------------------------------------------------

/**
 * WHERE THE MODEL CALLS GO, now that there is no dev proxy.
 *
 * `llm/client.ts` defaults to the relative `/api/anthropic`, which the Vite dev
 * server used to intercept and attach the key to — the arrangement that kept
 * the key out of the browser. That proxy is gone and this file is its
 * replacement: the API calls Anthropic directly, and the key is read from the
 * server's environment. The rule has not moved, only the wall — the key still
 * never reaches a browser, because a browser now talks only to this.
 *
 * Once per process. `configureTransport` is module state in the client, which
 * is right for a process that only ever talks to one provider.
 */
function configureAnthropic(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set; the API cannot reach the model.");
  configureTransport({
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
}

export function createApp(): Hono {
  configureAnthropic();
  const app = new Hono();

  // The client is served from a different origin in production — and could be
  // served from itch.io later — so this is not optional. Phase 11 narrows it
  // to known origins once there are accounts to protect.
  app.use("/api/*", cors());

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // `describeFailure` puts the validation complaints into the sentence; a
    // bare "response did not match the expected shape" tells a caller nothing.
    // See CODING-PLAN §6.7.
    console.error("[api]", err);
    return c.json({ error: describeFailure(err) }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // -------------------------------------------------------------------------
  // CHARACTERS
  // -------------------------------------------------------------------------

  app.get("/api/characters", async (c) => c.json(await repo.listCharacters()));

  app.post("/api/characters", async (c) => {
    const pc = (await c.req.json()) as PlayerCharacter;
    return c.json(await repo.saveCharacter(pc));
  });

  app.delete("/api/characters/:id", async (c) =>
    c.json({ deleted: await repo.deleteCharacter(c.req.param("id")) })
  );

  // -------------------------------------------------------------------------
  // GENERATION — three requests, one model call each
  // -------------------------------------------------------------------------

  /**
   * The structure and the standing fiction.
   *
   * Journalled against the DUNGEON rather than a run: the player has not
   * chosen a character yet, so there is no run for these to belong to. Every
   * run down this dungeon reads them as the opening of its own journal.
   */
  app.post("/api/dungeons", async (c) => {
    const { seed, size, level } = (await c.req.json()) as {
      seed: number;
      size: Size;
      level: number;
    };

    const { sink, events } = repo.collectingSink();
    const journal = createJournal(sink);
    const partial = await generateStructure({ seed, size, level, journal });

    await repo.insertPartialDungeon(partial);
    await repo.appendDungeonEvents(partial.id, events);

    return c.json({ dungeonId: partial.id, chunks: chunksOf(partial) });
  });

  /**
   * One region. The client fires these in parallel, which is the parallelism
   * the single-process pipeline always had — it has just moved up a layer.
   *
   * Idempotent: `saveChunk` keeps the first answer, so a retry of a call whose
   * response already landed costs a model call and changes nothing.
   */
  app.post("/api/dungeons/:id/chunks/:n", async (c) => {
    const { doc: partial } = await mustGetDungeon(c.req.param("id"));
    const chunk = Number(c.req.param("n"));
    if (!chunksOf(partial).includes(chunk)) {
      throw new HTTPException(404, { message: `no region ${chunk} in that dungeon` });
    }

    const { sink, events } = repo.collectingSink();
    const journal = createJournal(sink, await repo.lastDungeonSeq(partial.id));
    const result = await generateChunk(partial, chunk, { journal });

    await repo.saveChunk(partial.id, result);
    await repo.appendDungeonEvents(partial.id, events);

    return c.json({ chunk, done: true });
  });

  /**
   * Apply every region in ascending order, then write the ways between them.
   *
   * `finishGeneration` refuses if a region is missing, which is the check that
   * turns a lost chunk into a retryable request rather than an unwritten entity
   * discovered at the end of a pass nobody can rerun. See §1.1.
   */
  app.post("/api/dungeons/:id/finish", async (c) => {
    const stored = await mustGetDungeon(c.req.param("id"));
    if (stored.status === "complete") return c.json({ dungeonId: stored.id, already: true });

    const results = await repo.listChunks(stored.id);
    const { sink, events } = repo.collectingSink();
    const journal = createJournal(sink, await repo.lastDungeonSeq(stored.id));

    const complete = await finishGeneration(stored.doc, results, { journal });

    // The baseline every later diff is a delta from. Written here, once per
    // dungeon rather than once per run: it carries the whole world, and a copy
    // per run is what would fill a 500MB tier.
    journal.log({ kind: "dungeon", dungeon: complete });

    await repo.completeDungeon(complete);
    await repo.appendDungeonEvents(stored.id, events);

    return c.json({ dungeonId: complete.id });
  });

  // -------------------------------------------------------------------------
  // RUNS
  // -------------------------------------------------------------------------

  app.get("/api/runs", async (c) => c.json(await repo.listRuns()));

  app.get("/api/runs/:id", async (c) => {
    const run = await mustGetRun(c.req.param("id"));
    const dungeon = await mustGetDungeon(run.dungeonId);
    return c.json({ run, dungeon: dungeon.doc });
  });

  /**
   * A character walks into a finished dungeon.
   *
   * The run's journal opens here, with what this run IS. The generation events
   * above it already exist against the dungeon, and the reader concatenates.
   */
  app.post("/api/runs", async (c) => {
    const { dungeonId, character } = (await c.req.json()) as {
      dungeonId: string;
      character: PlayerCharacter;
    };

    const stored = await mustGetDungeon(dungeonId);
    if (stored.status !== "complete") {
      throw new HTTPException(409, { message: "that dungeon is still being written" });
    }

    const state = newRun(stored.doc, character);
    const run = await repo.createRun({ dungeonId, characterId: character.id, state });

    const { sink, events } = repo.collectingSink();
    createJournal(sink).log({
      kind: "run",
      runId: run.id,
      seed: stored.doc.seeds.dungeonSeed,
      size: stored.doc.size,
      level: stored.doc.level,
      offline: false,
      models: MODELS,
      character,
    });
    await repo.appendEvents(run.id, events);

    return c.json({ run, dungeon: stored.doc });
  });

  // -------------------------------------------------------------------------
  // PLAY
  // -------------------------------------------------------------------------

  app.post("/api/runs/:id/enter", (c) => playTurn(c, (s) => s.enterRoom()));
  app.post("/api/runs/:id/roll", (c) => playTurn(c, (s) => s.roll()));
  app.post("/api/runs/:id/retry", (c) => playTurn(c, (s) => s.retry()));
  app.post("/api/runs/:id/turn", (c) =>
    playTurn(c, async (s, body) => {
      const text = String((body as { text?: unknown }).text ?? "").trim();
      if (text === "") throw new HTTPException(400, { message: "nothing was typed" });
      await s.submit(text);
    })
  );

  // -------------------------------------------------------------------------
  // REVIEW
  // -------------------------------------------------------------------------

  app.get("/api/runs/:id/journal.jsonl", async (c) => {
    const run = await mustGetRun(c.req.param("id"));
    const events = await repo.readJournal(run.id, run.dungeonId);
    return c.text(events.map((e) => JSON.stringify(e)).join("\n"), 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
  });

  app.get("/api/runs/:id/transcript.md", async (c) => {
    const run = await mustGetRun(c.req.param("id"));
    const events = await repo.readJournal(run.id, run.dungeonId);
    // The same renderer the file sink has always used, so a transcript pulled
    // out of the database reads exactly like one pulled off disk.
    const text = events.map(render).filter((t) => t !== undefined).join("\n");
    return c.text(text, 200, { "content-type": "text/markdown; charset=utf-8" });
  });

  return app;
}

// ---------------------------------------------------------------------------
// A TURN
// ---------------------------------------------------------------------------

type Action = (session: ReturnType<typeof createGameSession>, body: unknown) => Promise<void>;

/**
 * The whole of playing a turn, and the only place run state is written.
 *
 * The order matters and each step earns its place:
 *
 *   1. the version, checked BEFORE anything is spent. A stale tab is turned
 *      away for free rather than after a referee conversation.
 *   2. the lock, which is not a correctness mechanism — `commitTurn` is — but
 *      stops a double-click paying for a turn that would be rejected anyway.
 *   3. the journal's starting sequence, so this request's events carry on from
 *      the last one's instead of colliding with them.
 *   4. the turn, against a session rebuilt from the row.
 *   5. the compare-and-swap, with the events in the same transaction, so a
 *      rejected turn leaves nothing at all behind.
 */
async function playTurn(c: Context, act: Action): Promise<Response> {
  // Hono types `param` as possibly-undefined on a bare `Context`, which cannot
  // know a route's parameters. Every route below has an `:id`, and a request
  // that somehow arrived without one has no run to name.
  const id = c.req.param("id");
  if (!id) throw new HTTPException(400, { message: "no run named" });

  const body = await c.req.json().catch(() => ({}));
  const expected = Number((body as { version?: unknown }).version);

  const run = await mustGetRun(id);
  if (!Number.isFinite(expected)) {
    throw new HTTPException(400, { message: "a turn must say which version it answers" });
  }
  if (expected !== run.version) {
    return c.json({ error: "stale", current: run }, 409);
  }
  if (run.status !== "active") {
    throw new HTTPException(409, { message: `that run is over: ${run.status}` });
  }
  if (!(await repo.lockRun(id))) {
    return c.json({ error: "busy", current: run }, 409);
  }

  const dungeon = await mustGetDungeon(run.dungeonId);
  const { sink, events } = repo.collectingSink();
  const session = createGameSession({
    sink: () => sink,
    startSeq: await repo.lastSeq(id),
  });
  session.resume({ dungeon: dungeon.doc, run: run.state }, runId(dungeon.doc.seeds.dungeonSeed));

  try {
    await act(session, body);
  } catch (e) {
    // Nothing is written, and the events go with it. They would take sequence
    // numbers a retry then could not reuse — `on conflict do nothing` would
    // drop the retry's events instead, which is the worse failure. The turn
    // machine catches referee errors itself and lands on `error` with the
    // journal intact, so reaching here at all is a bug rather than a bad call.
    await repo.releaseRun(id);
    throw e;
  }

  const state = session.store.getState().run as RunState;
  const result = await repo.commitTurn({ runId: id, expectedVersion: expected, state, events });

  if (!result.ok) return c.json({ error: "stale", current: result.current }, 409);
  return c.json({
    state,
    version: result.version,
    events: session.store.getState().lastEvents,
  });
}

// ---------------------------------------------------------------------------

async function mustGetDungeon(id: string) {
  const stored = await repo.getDungeon(id);
  if (!stored) throw new HTTPException(404, { message: `no such dungeon: ${id}` });
  return stored;
}

async function mustGetRun(id: string) {
  const run = await repo.getRun(id);
  if (!run) throw new HTTPException(404, { message: `no such run: ${id}` });
  return run;
}
