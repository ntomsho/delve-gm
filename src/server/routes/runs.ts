/**
 * RUNS: the list, today's allowance, reading one, and a character walking into
 * a finished dungeon.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { currentUser, type AuthEnv } from "../auth.ts";
import { newRun } from "../../gameplay/state/store.ts";
import { createJournal } from "../../journal/journal.ts";
import { MODELS } from "../../llm/models.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import * as repo from "../db/repo.ts";
import { allowanceOf, hasTurnLeft, mayStartRunIn, refusal, turnRefusal } from "../allowance.ts";
import { closed } from "../spend.ts";
import { mustGetDungeon, mustGetRun } from "./lookup.ts";

export function runRoutes(app: Hono<AuthEnv>): void {
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
    // Even a run that rides on its writing: the writing was paid for, the turns are not.
    if (allowance.closed) throw closed();
    if (!mayStartRunIn(allowance, stored.id)) {
      return c.json({ error: refusal(allowance), allowance }, 429);
    }
    // Nor one they have no turns left to play: it would be counted and sit there.
    if (!hasTurnLeft(allowance)) {
      return c.json({ error: turnRefusal(allowance), allowance }, 429);
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
}
