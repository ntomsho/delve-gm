/**
 * DUNGEONS: writing one, three requests and one model call each, and the
 * worlds a player can see — their own, the library of everybody else's, and a
 * copy taken from it.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { currentUser, type AuthEnv } from "../auth.ts";
import {
  chunksOf,
  finishGeneration,
  generateChunk,
  generateStructure,
} from "../../generation/generate.ts";
import { createJournal } from "../../journal/journal.ts";
import type { Size } from "../../generation/content/blueprint.ts";
import * as repo from "../db/repo.ts";
import { allowanceOf, hasRunLeft, hasTurnLeft, refusal, turnRefusal } from "../allowance.ts";
import { closed } from "../spend.ts";
import { coverKey, illustrationUrl } from "../illustrations/serve.ts";
import { mustGetDungeon } from "./lookup.ts";

export function dungeonRoutes(app: Hono<AuthEnv>): void {
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
    // A closed day (`spend.ts`) is asked first: it is nobody's allowance.
    const allowance = await allowanceOf(currentUser(c));
    if (allowance.closed) throw closed();
    if (!hasRunLeft(allowance)) {
      return c.json({ error: refusal(allowance), allowance }, 429);
    }
    // A world nobody has a turn left to play is a run spent for nothing.
    if (!hasTurnLeft(allowance)) {
      return c.json({ error: turnRefusal(allowance), allowance }, 429);
    }
    if (!(size <= allowance.maxSize)) {
      return c.json({ error: `Only size ${allowance.maxSize} dungeons for now.`, allowance }, 400);
    }

    const { sink, events } = repo.collectingSink();
    const journal = createJournal(sink);
    const partial = await generateStructure({ seed, size, level, journal });

    // THE ROW ID, NOT `partial.id`. `partial.id` is the engine's derived name
    // (`dungeon_<seed>`) and is not the key, so that two players may each hold
    // their own copy of one seed. Everything downstream
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
   * the exact records `generation-error` exists to keep. The console had them; the database did not, and the
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
   * discovered at the end of a pass nobody can rerun.
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
   * a dungeon's row id is not its derived name: were the derived
   * `dungeon_<seed>` name the primary key, a second copy of one
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
}

/** A summary as the client gets it: the cover as a URL, never a storage path. */
function withCover({ coverPath, ...summary }: repo.DungeonSummary): repo.DungeonSummary & { cover?: string } {
  const cover = coverPath ? illustrationUrl(coverPath) : undefined;
  return cover ? { ...summary, cover } : summary;
}
