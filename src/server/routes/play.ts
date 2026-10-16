/**
 * PLAY: every request that moves a run on, and abandoning one.
 *
 * Each turn goes through `playTurn`, which is the only place run state is
 * written; abandoning writes through the same `commitTurn` without a turn.
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { currentUser, type AuthEnv } from "../auth.ts";
import { createGameSession } from "../../gameplay/sessions/session.ts";
import type { RunState } from "../../gameplay/state/store.ts";
import { createJournal, runId } from "../../journal/journal.ts";
import * as repo from "../db/repo.ts";
import { serveIllustration } from "../illustrations/serve.ts";
import { illustrationEntryFor } from "../../illustrations/room-illustration.ts";
import { drawableCreatures, spriteKeyOf } from "../../illustrations/figures.ts";
import { serveSprite } from "../illustrations/sprites.ts";
import { waitUntil } from "@vercel/functions";
import { mustGetDungeon, mustGetRun } from "./lookup.ts";
import { illustrationWorker, spriteWorker } from "./illustrations.ts";

export function playRoutes(app: Hono<AuthEnv>): void {
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
    if (work && entryId) {
      waitUntil(
        serveIllustration(dungeon.doc, room, entryId, work).catch((e) => console.error("[illustration] early start failed", e))
      );
    }
    // The creatures in it too, one sprite per kind, for the same reason.
    const sprites = spriteWorker();
    if (!sprites) return;
    const keys = new Set(drawableCreatures(r.entities.creatures, room).map(spriteKeyOf));
    for (const key of keys) {
      waitUntil(
        serveSprite(r.entities, dungeon.doc.pass.theme, key, sprites).catch((e) =>
          console.error("[sprite] early start failed", e)
        )
      );
    }
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
