/**
 * ILLUSTRATIONS: a room's picture, a creature's sprite and the dungeon's cover,
 * each drawn by the first request that asks and served from then on. The
 * workers are shared with `play.ts`, which starts a room's drawing the moment
 * the player arrives.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { currentUser, type AuthEnv } from "../auth.ts";
import type { RunState } from "../../gameplay/state/store.ts";
import {
  liveIllustrationWork,
  serveCover,
  serveIllustration,
  type IllustrationAnswer,
  type IllustrationWork,
} from "../illustrations/serve.ts";
import { illustrationEntryFor } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, spriteKeyOf } from "../../illustrations/figures.ts";
import {
  liveSpriteWork,
  serveSprite,
  type SpriteAnswer,
  type SpriteWork,
} from "../illustrations/sprites.ts";
import { mustGetDungeon, mustGetRun } from "./lookup.ts";
import * as repo from "../db/repo.ts";
import { recentShowcase, SHOWCASE_MAX } from "../illustrations/showcase.ts";

export function illustrationRoutes(app: Hono<AuthEnv>): void {
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
   * A creature's sprite, for standing it in an illustration. See `sprites.ts`.
   *
   * Only a kind this run can see: some creature carrying the key (`spriteKeyOf`)
   * that is not hidden and stands in a room the run has entered. A sprite of
   * anything else is a look at a creature the player has not met. Read from
   * the run's entities, so a creature brought in mid-run is drawn too.
   *
   * `202` while somebody else's request is drawing it; the page asks again.
   */
  app.get("/api/runs/:id/sprites/:spriteId", async (c) => {
    const user = currentUser(c);
    const run = await mustGetRun(c.req.param("id"), user.id);
    const spriteId = c.req.param("spriteId");
    if (!mayDrawSprite(run.state, spriteId)) {
      throw new HTTPException(404, { message: "no sprite for a creature this run has not met" });
    }
    const work = spriteWorker();
    if (!work) return c.json({ status: "none" } satisfies SpriteAnswer);
    const dungeon = await mustGetDungeon(run.dungeonId, user.id);
    const answer = await serveSprite(run.state.entities, dungeon.doc.pass.theme, spriteId, work);
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
}

/**
 * The landing page's pictures: rooms and covers already drawn in recent runs.
 * See `showcase.ts`.
 *
 * OUTSIDE THE SIGN-IN GATE, so `app.ts` registers it before the gate. It
 * spends nothing (it reads, and never draws) and it answers with what
 * the library already shows anyone: pictures, and the names of rooms and
 * dungeons. Cached at the edge, so a busy landing page is one query every
 * few minutes rather than one per visit.
 */
export function showcaseRoutes(app: Hono<AuthEnv>): void {
  app.get("/api/illustrations/recent", async (c) => {
    const illustrations = illustrationWorker();
    const sprites = spriteWorker();
    c.header("cache-control", "public, max-age=60, s-maxage=600, stale-while-revalidate=3600");
    if (!illustrations || !sprites) return c.json([]);
    const asked = Math.trunc(Number(c.req.query("limit")));
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), SHOWCASE_MAX) : SHOWCASE_MAX;
    const work = {
      illustrationReferences: illustrations.references,
      spriteReferences: sprites.references,
      urlOf: illustrations.urlOf,
    };
    return c.json(await recentShowcase(work, repo, limit));
  });
}

/**
 * The illustration worker, made on the first illustration asked for rather than at start-up:
 * it reads the reference files, and an app that never draws should not need
 * them. `null` is "not set up", and every room then has no illustration.
 */
let illustrationWork: IllustrationWork | null | undefined;
export function illustrationWorker(): IllustrationWork | undefined {
  if (illustrationWork === undefined) illustrationWork = liveIllustrationWork() ?? null;
  return illustrationWork ?? undefined;
}

/** The sprite worker, made on first use for the same reason as the illustration worker. */
let spriteWork: SpriteWork | null | undefined;
export function spriteWorker(): SpriteWork | undefined {
  if (spriteWork === undefined) spriteWork = liveSpriteWork() ?? null;
  return spriteWork ?? undefined;
}

/** Some creature carrying this sprite key is in sight in a room the run has entered. */
function mayDrawSprite(state: RunState, spriteId: string): boolean {
  const entered = new Set([state.currentRoomId, ...state.log.flatMap((e) => (e.kind === "arrival" && e.roomId ? [e.roomId] : []))]);
  return [...entered].some((room) =>
    drawableCreatures(state.entities.creatures, room).some((c) => spriteKeyOf(c) === spriteId)
  );
}
