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
import { currentUser, requireUser, type AuthEnv } from "./auth.ts";
import {
  chunksOf,
  finishGeneration,
  generateChunk,
  generateStructure,
} from "../generation/generate.ts";
import { createGameSession, describeFailure } from "../gameplay/sessions/session.ts";
import { newRun, type RunState } from "../gameplay/state/store.ts";
import { createJournal, runId } from "../journal/journal.ts";
import { render } from "../journal/render.ts";
import { MODELS } from "../llm/models.ts";
import { configureTransport } from "../llm/client.ts";
import type { PlayerCharacter } from "../rules/knave/character.ts";
import type { Size } from "../generation/content/blueprint.ts";
import * as repo from "./db/repo.ts";
import { allowanceOf, hasRunLeft, mayStartRunIn, refusal } from "./allowance.ts";
import {
  coverKey,
  liveIllustrationWork,
  illustrationUrl,
  serveCover,
  serveIllustration,
  type IllustrationAnswer,
  type IllustrationWork,
} from "./illustrations/serve.ts";
import { illustrationEntryFor } from "../illustrations/room-illustration.ts";
import { waitUntil } from "@vercel/functions";

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

/**
 * Who may call this API from a browser.
 *
 * Was a bare `cors()` — any origin at all — which was survivable while there
 * was nothing behind it worth taking. Now there are accounts, and an open CORS
 * policy means any page the player visits can spend their tokens with their
 * session. `CORS_ORIGINS` exists so a preview deployment or an itch.io embed is
 * an environment variable rather than a redeploy.
 */
function allowedOrigins(): string[] {
  const extra = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return ["https://aidungeon.vercel.app", "http://localhost:5173", ...extra];
}

export function createApp(): Hono<AuthEnv> {
  configureAnthropic();
  const app = new Hono<AuthEnv>();

  app.use("/api/*", cors({ origin: allowedOrigins(), credentials: true }));

  /**
   * THE GATE. Everything under `/api` needs an account.
   *
   * `/api/health` is the one exception and is registered before this: it is what
   * the twice-weekly Vercel cron hits to stop Supabase pausing the project
   * (§7.8), a cron holds no session, and it reads and writes nothing.
   *
   * Until Phase 11 this API was open, and it spends an Anthropic key. That is
   * the hole this line closes.
   */
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/*", requireUser);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // `describeFailure` puts the validation complaints into the sentence; a
    // bare "response did not match the expected shape" tells a caller nothing.
    // See CODING-PLAN §6.7.
    console.error("[api]", err);
    return c.json({ error: describeFailure(err) }, 500);
  });

  // -------------------------------------------------------------------------
  // CHARACTERS
  // -------------------------------------------------------------------------

  /**
   * The roster: who the player has, what has happened to them, and where they
   * are. Was `PlayerCharacter[]`; a sheet alone can no longer answer the
   * question the screen asks, which is whether this person can be sent anywhere.
   */
  app.get("/api/characters", async (c) => c.json(await repo.listRoster(currentUser(c).id)));

  /**
   * Save a sheet — a new character, or one that has been to the market.
   *
   * EDITING SOMEBODY WHO IS STILL DOWN THERE IS REFUSED, the same way deleting
   * them is and for a neighbouring reason. A run plays from its own copy of the
   * sheet and writes what survives back when it ends, so a write from up here
   * would either be overwritten without warning or overwrite the run's own
   * result. The shop is the only caller that can reach this with an existing
   * character and it does not offer the button to anyone in a run; this is the
   * rule rather than the manners.
   */
  app.post("/api/characters", async (c) => {
    const user = currentUser(c);
    const pc = (await c.req.json()) as PlayerCharacter;
    const active = await repo.activeRunFor(pc.id, user.id);
    if (active) {
      return c.json(
        { error: "that character is in a run — what they are carrying is the run's now", runId: active.id },
        409
      );
    }
    return c.json(await repo.saveCharacter(pc, user.id));
  });

  /**
   * Deleting somebody who is still down there is refused.
   *
   * The foreign key is `on delete set null`, so this would otherwise succeed and
   * leave an active run belonging to nobody: a save file with no way to reach it
   * and no way to end it, holding a lock against a character that no longer
   * exists. Abandon first — that is what the verb is for.
   */
  app.delete("/api/characters/:id", async (c) => {
    const user = currentUser(c);
    const id = c.req.param("id");
    const active = await repo.activeRunFor(id, user.id);
    if (active) {
      // JSON rather than an `HTTPException`, and for the same reason the stale
      // and busy refusals below are: Hono renders a thrown exception as a plain
      // text body, and this message is one the interface has to put in front of
      // the player. `runId` is there so it can offer the run rather than only
      // mention it.
      return c.json(
        { error: "that character is in a run — abandon it first", runId: active.id },
        409
      );
    }
    return c.json({ deleted: await repo.deleteCharacter(id, user.id) });
  });

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

    // A RETRY IS THE SAME WRITING, NOT A SECOND ONE. "Try seed N again" sends
    // the same dice; if this player already has an unfinished dungeon from
    // them, hand that back and let the client finish it. It was counted when
    // it was made, so it is not gated again — a player whose only run of the
    // day failed to write must be able to try again.
    const unfinished = await repo.findUnfinishedDungeon(currentUser(c).id, { seed, size, level });
    if (unfinished) {
      return c.json({ dungeonId: unfinished.id, chunks: chunksOf(unfinished.doc) });
    }

    // THE ONLY GATE ON GENERATION, and it sits on the first of the three
    // requests: once a structure exists, its chunks and its join are the same
    // dungeon being finished, not a new one being started. See `allowance.ts`.
    const allowance = await allowanceOf(currentUser(c));
    if (!hasRunLeft(allowance)) {
      return c.json({ error: refusal(allowance), allowance }, 429);
    }
    if (!(size <= allowance.maxSize)) {
      return c.json({ error: `Only size ${allowance.maxSize} dungeons for now.`, allowance }, 400);
    }

    const { sink, events } = repo.collectingSink();
    const journal = createJournal(sink);
    const partial = await generateStructure({ seed, size, level, journal });

    // THE ROW ID, NOT `partial.id`. `partial.id` is the engine's derived name
    // (`dungeon_<seed>`) and stopped being the key in Phase 11, so that two
    // players may each hold their own copy of one seed. Everything downstream
    // addresses the row.
    const dungeonId = await repo.insertPartialDungeon(partial, currentUser(c).id);
    await repo.appendDungeonEvents(dungeonId, events);

    return c.json({ dungeonId, chunks: chunksOf(partial) });
  });

  /**
   * A generation pass whose journal is written WHETHER OR NOT IT SUCCEEDS.
   *
   * This was the hole. A pass that throws never reached `appendDungeonEvents`,
   * so a failed dungeon left the three `generation-error` events on the floor —
   * the exact records §6.7 was built to keep, gone again the moment the runtime
   * moved to a server. The console had them; the database did not, and the
   * console belongs to whoever was tailing the function.
   *
   * Safe to write on failure here, unlike a turn: the sequence belongs to the
   * DUNGEON, and a retry reads `lastDungeonSeq` and appends after these rather
   * than colliding with them. A turn's events are dropped on a throw for that
   * exact reason — see the note in `playTurn`.
   *
   * The structure pass cannot use this: when IT fails there is no dungeon row
   * for the events to belong to. The console is the only record of that one.
   */
  async function journalled<T>(
    dungeonId: string,
    work: (journal: ReturnType<typeof createJournal>) => Promise<T>
  ): Promise<T> {
    const { sink, events } = repo.collectingSink();
    const journal = createJournal(sink, await repo.lastDungeonSeq(dungeonId));
    try {
      return await work(journal);
    } finally {
      await repo.appendDungeonEvents(dungeonId, events);
    }
  }

  /**
   * One region. The client fires these in parallel, which is the parallelism
   * the single-process pipeline always had — it has just moved up a layer.
   *
   * Idempotent: `saveChunk` keeps the first answer, so a retry of a call whose
   * response already landed costs a model call and changes nothing.
   */
  app.post("/api/dungeons/:id/chunks/:n", async (c) => {
    const stored = await mustGetDungeon(c.req.param("id"), currentUser(c).id);
    const partial = stored.doc;
    const chunk = Number(c.req.param("n"));
    if (!chunksOf(partial).includes(chunk)) {
      throw new HTTPException(404, { message: `no region ${chunk} in that dungeon` });
    }

    // Already written — a retry of a dungeon that failed somewhere else. The
    // answer is kept, so asking the model again would buy nothing.
    if ((await repo.listChunks(stored.id)).some((r) => r.chunk === chunk)) {
      return c.json({ chunk, done: true });
    }

    const result = await journalled(stored.id, (journal) =>
      generateChunk(partial, chunk, { journal })
    );
    await repo.saveChunk(stored.id, result);

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
    const stored = await mustGetDungeon(c.req.param("id"), currentUser(c).id);
    if (stored.status === "complete") return c.json({ dungeonId: stored.id, already: true });

    const results = await repo.listChunks(stored.id);
    const complete = await journalled(stored.id, async (journal) => {
      const done = await finishGeneration(stored.doc, results, { journal });
      // The baseline every later diff is a delta from. Written here, once per
      // dungeon rather than once per run: it carries the whole world, and a
      // copy per run is what would fill a 500MB tier.
      journal.log({ kind: "dungeon", dungeon: done });
      return done;
    });

    await repo.completeDungeon(stored.id, complete, currentUser(c).id);
    // Its cover is named now and drawn by the first ask for it — see
    // `GET /api/runs/:id/cover`, which the client sends as the run starts.
    const cover = coverKey(complete);
    if (cover) await repo.setDungeonCover(stored.id, cover);
    return c.json({ dungeonId: stored.id });
  });

  /** The player's own worlds. Summaries — nobody needs six whole dungeons. */
  app.get("/api/dungeons", async (c) => c.json((await repo.listDungeons(currentUser(c).id)).map(withCover)));

  /**
   * THE LIBRARY — every complete world somebody else made, newest first.
   *
   * Registered before the `:id` routes below because `library` would otherwise
   * be a plausible dungeon id, and a route that can be shadowed by a parameter
   * is a route that works until somebody changes the order.
   *
   * SUMMARIES AND A CURSOR, and the cursor goes back out exactly as it came in.
   * The client never composes one — see `listLibrary`.
   */
  app.get("/api/dungeons/library", async (c) => {
    const cursor = c.req.query("cursor");
    const limit = Number(c.req.query("limit"));
    const page = await repo.listLibrary(currentUser(c).id, {
      ...(cursor ? { cursor } : {}),
      // A limit that is not a number is no limit stated, which `listLibrary`
      // reads as the default batch. It clamps whatever it is given besides.
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return c.json({ ...page, dungeons: page.dungeons.map(withCover) });
  });

  /**
   * TAKE A COPY OF A WORLD.
   *
   * The one route that names a dungeon the caller does not own, and it is why
   * the Phase 11 key split had to happen first: under 10a's schema, where the
   * derived `dungeon_<seed>` name WAS the primary key, a second copy of one
   * world collided on it.
   *
   * IT STILL SERVES NOTHING OF THE SOURCE. The reply is the id of the caller's
   * OWN new row, and the source's `doc` — which is every answer in the world —
   * is never on the wire. What "another player may see a dungeon" means is
   * exactly this: they may have one of their own like it.
   *
   * `already` for the second click, in the shape `/finish` answers in. A copy is
   * recorded as a copy (`dungeons.copied_from`), so pressing the button twice
   * hands back the first copy rather than minting a second half-megabyte row.
   */
  app.post("/api/dungeons/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    const made = await repo.duplicateDungeon(id, currentUser(c).id);
    // "Not there" and "still being written" are one answer. A caller who may
    // not copy it either way should not learn which of the two it was.
    if (!made) throw new HTTPException(404, { message: `no such finished dungeon: ${id}` });
    return c.json({ dungeonId: made.id, already: made.already });
  });

  // -------------------------------------------------------------------------
  // RUNS
  // -------------------------------------------------------------------------

  app.get("/api/runs", async (c) => c.json(await repo.listRuns(currentUser(c).id)));

  /**
   * How many runs are left today, and how big a dungeon may be written.
   *
   * Asked by run setup when it opens, so the screen can say so before the
   * player presses anything. The gates above do not trust it: they ask again.
   */
  app.get("/api/allowance", async (c) => c.json(await allowanceOf(currentUser(c))));

  app.get("/api/runs/:id", async (c) => {
    const user = currentUser(c);
    const run = await mustGetRun(c.req.param("id"), user.id);
    const dungeon = await mustGetDungeon(run.dungeonId, user.id);
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

    const user = currentUser(c);
    const stored = await mustGetDungeon(dungeonId, user.id);
    if (stored.status !== "complete") {
      throw new HTTPException(409, { message: "that dungeon is still being written" });
    }

    /*
     * ONE RUN AT A TIME, ASKED HERE AND ENFORCED IN THE DATABASE.
     *
     * `runs_one_active_per_character` is what actually holds the rule — this
     * check could always lose a race with a second request, and the index
     * cannot. What it buys is the ANSWER: the index raises a constraint
     * violation, which tells the player nothing they can act on, and this names
     * the run they are already in so the interface can offer to resume it.
     */
    const busy = await repo.activeRunFor(character.id, user.id);
    if (busy) {
      return c.json(
        { error: "in a run", runId: busy.id, dungeonId: busy.dungeonId },
        409
      );
    }

    // AFTER the in-a-run check: a player sent here by a stale screen to start a
    // run they are already in should be told where it is, not that they are out
    // of runs. The first run into a dungeon they wrote is free — the writing was
    // the run. See `allowance.ts`.
    const allowance = await allowanceOf(user);
    if (!mayStartRunIn(allowance, stored.id)) {
      return c.json({ error: refusal(allowance), allowance }, 429);
    }

    const state = newRun(stored.doc, character);
    const run = await repo.createRun({
      dungeonId: stored.id,
      characterId: character.id,
      state,
      owner: user.id,
    });

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

  /**
   * WALK AWAY. The one ending that costs nothing.
   *
   * Not a turn and not routed through `playTurn`: there is no game master to ask, no
   * dice to throw and no world to change — the player is closing the book, not
   * doing something in the fiction. So it skips the lock (a turn in flight will
   * simply lose the compare-and-swap, which is the correct outcome for a turn
   * whose run has ended) and writes through the same `commitTurn` everything
   * else writes through, so the version, the status and the release of the lock
   * all happen exactly as they do for any other ending.
   *
   * The run keeps everything. Abandoning ENDS a run; it does not delete one, and
   * the journal, the state and the scrollback are all still there to read.
   */
  app.post("/api/runs/:id/abandon", async (c) => {
    const id = c.req.param("id");
    const owner = currentUser(c).id;
    const body = (await c.req.json().catch(() => ({}))) as { version?: unknown };
    const expected = Number(body.version);
    if (!Number.isFinite(expected)) {
      throw new HTTPException(400, { message: "an abandon must say which version it answers" });
    }

    const run = await mustGetRun(id, owner);
    if (run.status !== "active") {
      throw new HTTPException(409, { message: `that run is already over: ${run.status}` });
    }

    const state: RunState = { ...run.state, stage: "abandoned" };
    const { sink, events } = repo.collectingSink();
    createJournal(sink, await repo.lastSeq(id)).log({
      kind: "stage",
      from: run.state.stage,
      to: "abandoned",
      step: run.state.step,
    });

    const result = await repo.commitTurn({
      runId: id,
      owner,
      expectedVersion: expected,
      state,
      events,
    });
    if (!result.ok && result.reason === "gone") {
      throw new HTTPException(404, { message: `no such run: ${id}` });
    }
    if (!result.ok) return c.json({ error: "stale", current: result.current }, 409);
    return c.json({ state, version: result.version, events: [] });
  });

  app.post("/api/runs/:id/enter", (c) => playTurn(c, (s) => s.enterRoom()));
  // TWO REQUESTS FOR ONE ROLL, so the dice reach the screen before the prose.
  // `/roll` throws them and saves — no model call, back in milliseconds — and
  // `/resolve` asks the game master what they meant. A run left between the two is
  // `resolving` with the roll in `pending`, and `/retry` picks it up from there.
  app.post("/api/runs/:id/roll", (c) => playTurn(c, async (s) => s.throwDice()));
  app.post("/api/runs/:id/resolve", (c) => playTurn(c, (s) => s.resolve()));
  app.post("/api/runs/:id/retry", (c) => playTurn(c, (s) => s.retry()));
  app.post("/api/runs/:id/turn", (c) =>
    playTurn(c, async (s, body) => {
      const text = String((body as { text?: unknown }).text ?? "").trim();
      if (text === "") throw new HTTPException(400, { message: "nothing was typed" });
      await s.submit(text);
    })
  );

  // -------------------------------------------------------------------------
  // ILLUSTRATIONS
  // -------------------------------------------------------------------------

  /**
   * A room's picture, for the arrival in the scrollback. See `illustrations.ts`.
   *
   * Only a room this run has entered: an illustration of anywhere else is a look at a
   * room the player has not reached. The way in is the run's, read off its
   * log (`illustrationEntryFor`); the client names only the room.
   *
   * `202` while somebody else's request is drawing it; the page asks again.
   * Not a turn and not locked: it reads the run and writes nothing to it.
   */
  app.get("/api/runs/:id/illustrations/:roomId", async (c) => {
    const user = currentUser(c);
    const run = await mustGetRun(c.req.param("id"), user.id);
    const dungeon = await mustGetDungeon(run.dungeonId, user.id);
    const roomId = c.req.param("roomId");
    const entryId = illustrationEntryFor(dungeon.doc, run.state, roomId);
    if (!entryId) throw new HTTPException(404, { message: "no illustration for a room this run has not entered" });
    const work = illustrationWorker();
    if (!work) return c.json({ status: "none" } satisfies IllustrationAnswer);
    const answer = await serveIllustration(dungeon.doc, roomId, entryId, work);
    return c.json(answer, answer.status === "pending" ? 202 : 200);
  });

  /**
   * The dungeon's cover, for the opening. Drawn by the first ask — the client
   * sends one the moment a run starts — and served from then on.
   *
   * Through the run rather than the dungeon so the caller needs no dungeon id,
   * and so the owner check is the run's. A dungeon with no cover key (finished
   * before covers) answers `none` and is never drawn.
   */
  app.get("/api/runs/:id/cover", async (c) => {
    const user = currentUser(c);
    const run = await mustGetRun(c.req.param("id"), user.id);
    const dungeon = await mustGetDungeon(run.dungeonId, user.id);
    const work = illustrationWorker();
    if (!work || !dungeon.cover) return c.json({ status: "none" } satisfies IllustrationAnswer);
    const answer = await serveCover(dungeon.doc, dungeon.cover, work);
    return c.json(answer, answer.status === "pending" ? 202 : 200);
  });

  // -------------------------------------------------------------------------
  // REVIEW
  // -------------------------------------------------------------------------

  app.get("/api/runs/:id/journal.jsonl", async (c) => {
    const run = await mustGetRun(c.req.param("id"), currentUser(c).id);
    const events = await repo.readJournal(run.id, run.dungeonId);
    return c.text(events.map((e) => JSON.stringify(e)).join("\n"), 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
  });

  app.get("/api/runs/:id/transcript.md", async (c) => {
    const run = await mustGetRun(c.req.param("id"), currentUser(c).id);
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
 *      away for free rather than after a game master conversation.
 *   2. the lock, which is not a correctness mechanism — `commitTurn` is — but
 *      stops a double-click paying for a turn that would be rejected anyway.
 *   3. the journal's starting sequence, so this request's events carry on from
 *      the last one's instead of colliding with them.
 *   4. the turn, against a session rebuilt from the row.
 *   5. the compare-and-swap, with the events in the same transaction, so a
 *      rejected turn leaves nothing at all behind.
 */
async function playTurn(c: Context<AuthEnv>, act: Action): Promise<Response> {
  // Hono types `param` as possibly-undefined on a bare `Context`, which cannot
  // know a route's parameters. Every route below has an `:id`, and a request
  // that somehow arrived without one has no run to name.
  const id = c.req.param("id");
  if (!id) throw new HTTPException(400, { message: "no run named" });

  const owner = currentUser(c).id;
  const body = await c.req.json().catch(() => ({}));
  const expected = Number((body as { version?: unknown }).version);

  // Owner-filtered, so another player's run is a 404 and not a 403 — the API
  // does not confirm that a run it will not serve exists.
  const run = await mustGetRun(id, owner);
  if (!Number.isFinite(expected)) {
    throw new HTTPException(400, { message: "a turn must say which version it answers" });
  }
  if (expected !== run.version) {
    return c.json({ error: "stale", current: run }, 409);
  }
  if (run.status !== "active") {
    throw new HTTPException(409, { message: `that run is over: ${run.status}` });
  }
  if (!(await repo.lockRun(id, owner))) {
    return c.json({ error: "busy", current: run }, 409);
  }

  const dungeon = await mustGetDungeon(run.dungeonId, owner);
  const { sink, events } = repo.collectingSink();
  const session = createGameSession({
    sink: () => sink,
    startSeq: await repo.lastSeq(id),
  });
  session.restore({ dungeon: dungeon.doc, run: run.state }, runId(dungeon.doc.seeds.dungeonSeed));

  // A ROOM'S ILLUSTRATION STARTS THE MOMENT THE PLAYER IS IN IT, alongside the prose
  // describing it rather than after. The client only learns of the new room
  // when this whole turn comes back, arrival prose included; asking from there
  // put the ~25 s drawing behind the writing. Not awaited: the turn answers when
  // the prose is done, and the page's own ask for the illustration finds it pending,
  // then ready. `waitUntil` keeps the function alive for it on Vercel.
  const illustrationStarted = new Set<string>();
  const startIllustration = (r: RunState) => {
    const room = r.currentRoomId;
    if (illustrationStarted.has(room) || r.log.some((e) => e.kind === "arrival" && e.roomId === room)) return;
    illustrationStarted.add(room);
    const work = illustrationWorker();
    const entryId = work && illustrationEntryFor(dungeon.doc, r, room);
    if (!work || !entryId) return;
    waitUntil(
      serveIllustration(dungeon.doc, room, entryId, work).catch((e) => console.error("[illustration] early start failed", e))
    );
  };
  startIllustration(run.state);
  const stopWatching = session.store.subscribe((s) => s.run && startIllustration(s.run as RunState));

  try {
    await act(session, body);
  } catch (e) {
    stopWatching();
    // Nothing is written, and the events go with it. They would take sequence
    // numbers a retry then could not reuse — `on conflict do nothing` would
    // drop the retry's events instead, which is the worse failure. The turn
    // machine catches game master errors itself and lands on `error` with the
    // journal intact, so reaching here at all is a bug rather than a bad call.
    await repo.releaseRun(id, owner);
    throw e;
  }

  stopWatching();
  const state = session.store.getState().run as RunState;
  const result = await repo.commitTurn({
    runId: id,
    owner,
    expectedVersion: expected,
    state,
    events,
  });

  // `gone` means the run stopped being this player's between the read and the
  // write — unreachable through this handler, which read it under an owner
  // filter, and answered anyway because the alternative was a 500.
  if (!result.ok && result.reason === "gone") {
    throw new HTTPException(404, { message: `no such run: ${id}` });
  }
  if (!result.ok) return c.json({ error: "stale", current: result.current }, 409);
  return c.json({
    state,
    version: result.version,
    events: session.store.getState().lastEvents,
  });
}

// ---------------------------------------------------------------------------

/**
 * A dungeon, or a 404.
 *
 * OWNERSHIP IS AN ARGUMENT, NOT AN AFTERTHOUGHT. Both of these take the owner
 * and pass it into the `where`, so there is no arrangement of calls in which a
 * handler reads a row first and remembers to check it second. "Not yours" and
 * "not there" are one answer.
 */
async function mustGetDungeon(id: string, owner: string) {
  const stored = await repo.getDungeon(id, owner);
  if (!stored) throw new HTTPException(404, { message: `no such dungeon: ${id}` });
  return stored;
}

/**
 * The illustration worker, made on the first illustration asked for rather than at start-up:
 * it reads the reference files, and an app that never draws should not need
 * them. `null` is "not set up", and every room then has no illustration.
 */
let illustrationWork: IllustrationWork | null | undefined;
function illustrationWorker(): IllustrationWork | undefined {
  if (illustrationWork === undefined) illustrationWork = liveIllustrationWork() ?? null;
  return illustrationWork ?? undefined;
}

async function mustGetRun(id: string, owner: string) {
  const run = await repo.getRun(id, owner);
  if (!run) throw new HTTPException(404, { message: `no such run: ${id}` });
  return run;
}

/** A summary as the client gets it: the cover as a URL, never a storage path. */
function withCover({ coverPath, ...summary }: repo.DungeonSummary): repo.DungeonSummary & { cover?: string } {
  const cover = coverPath ? illustrationUrl(coverPath) : undefined;
  return cover ? { ...summary, cover } : summary;
}
