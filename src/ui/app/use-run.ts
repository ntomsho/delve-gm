/**
 * THE RUN IN HAND: its session, how far generation has got, and what went wrong.
 *
 * Every way a run starts goes through here — a new world, a world already
 * written, a copy of somebody else's, a run picked back up — and so does
 * walking away from one.
 */

import { useMemo, useState } from "react";
import type { PlayableSession, RunRequest } from "../../gameplay/sessions/session.ts";
import type { GenerationProgress } from "../../generation/generate.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import { duplicateDungeon, type DungeonSummary } from "../../api-client/dungeons.ts";
import { describeFailure } from "../../llm/json.ts";
import { toItems } from "../play/Narration.tsx";
import { useGame } from "../shared/use-game.ts";
import { makeSession } from "./local-run.ts";

/**
 * `onWaiting` is called as a run starts being made or fetched: the app shows
 * its loading screen while it waits for a run to appear.
 */
export function useRun({ onWaiting }: { onWaiting: () => void }) {
  const [progress, setProgress] = useState<GenerationProgress>();
  const fresh = () => makeSession(setProgress);

  /**
   * The run in hand. Made on the first render — so the store it owns is there
   * to subscribe to before there is a dungeon in it — and replaced only when a
   * failed generation is retried, because a session that has begun refuses to
   * begin again and a half-generated one is not worth resuming.
   *
   * State rather than a ref, because swapping it has to re-render: the
   * subscription below is to *this* store, and the play screen has to follow
   * the new one.
   */
  const [session, setSession] = useState<PlayableSession>(fresh);
  const { dungeon, run } = useGame(session.store);
  const [error, setError] = useState<string>();
  /** Held so a failed generation can be tried again on the same seed. */
  const [lastRequest, setLastRequest] = useState<RunRequest>();

  async function start(s: PlayableSession, request: RunRequest) {
    onWaiting();
    try {
      // A second call on the SAME session is the double-invoke of StrictMode's
      // development mount, and the session drops it — it would otherwise
      // generate a whole second dungeon over the top of the first.
      await s.begin(request);
    } catch (e) {
      // `describeFailure` puts the first few validation complaints into the
      // sentence. The whole error is already on the console and in the journal;
      // this is the part that fits on a screen.
      setError(describeFailure(e));
    }
  }

  async function begin(request: RunRequest) {
    setLastRequest(request);
    await start(session, request);
  }

  /**
   * GO BACK DOWN A WORLD THAT IS ALREADY WRITTEN.
   *
   * One request and no model call — see `beginIn` in `remote-session.ts`. It
   * still borrows the generating screen, because what the player is waiting for
   * is a run being created and that is the screen this app shows while it waits
   * for a run to appear.
   *
   * NO `lastRequest`, so the failure screen offers no retry button. That is
   * correct rather than an omission: the retry it offers is "try that seed
   * again", and there is no seed here — the world exists and a run into it that
   * failed to be created failed for a reason a second identical POST will not
   * fix. Going back to the roster is the honest way on.
   */
  async function beginExisting(dungeonId: string, character: PlayerCharacter) {
    setLastRequest(undefined);
    onWaiting();
    try {
      await session.beginIn?.({ dungeonId, character });
    } catch (e) {
      setError(describeFailure(e));
    }
  }

  /**
   * TAKE A COPY OF SOMEBODY ELSE'S WORLD, AND GO DOWN IT.
   *
   * Two requests and no model call. The copy has to happen first and cannot be
   * skipped: `POST /api/runs` reads the dungeon under an owner filter, so the
   * source row is a 404 to this player right up until they hold one of their
   * own. Taking a copy is also idempotent — a world already taken hands back the
   * copy that exists — so a player who browses to the same dungeon twice does
   * not accumulate rows.
   *
   * THROWS RATHER THAN CATCHES. `Library` is showing the card that was pressed
   * and is the right place for this to be reported, next to the thing that
   * failed — where a notice on the roster would be a message about a screen the
   * player is still looking at.
   */
  async function takeAndDescend(world: DungeonSummary, character: PlayerCharacter) {
    const { dungeonId } = await duplicateDungeon(world.id);
    await beginExisting(dungeonId, character);
  }

  /**
   * PICK A RUN BACK UP.
   *
   * One fetch and the game is on the screen — nothing is replayed, because
   * `runs.state` is the whole save, scrollback included. It borrows the
   * generating screen for the second it takes, which is honest: the game is
   * being fetched, and the loading screen is what this app shows while it waits
   * for a run to appear.
   *
   * Sessions are single-use — `begin` and `resume` both latch — so this takes a
   * fresh one. It matters when a player finishes a run, goes back to the roster
   * and picks up a different character's.
   */
  async function resume(runId: string) {
    const next = fresh();
    setSession(next);
    onWaiting();
    try {
      await next.resume?.(runId);
    } catch (e) {
      setError(describeFailure(e));
    }
  }

  /**
   * Try the same seed again, on a session of its own.
   *
   * The same seed on purpose: a generation that failed once usually succeeds on
   * the second attempt — the failure is a model having a bad round rather than
   * a dungeon that cannot be built — and if it fails twice on the same seed
   * that is worth knowing, which a fresh random seed would hide.
   */
  function retry() {
    if (!lastRequest) return;
    const next = fresh();
    setSession(next);
    setError(undefined);
    setProgress(undefined);
    void start(next, lastRequest);
  }

  /**
   * Put the run down, from one that is over or one being walked away from. A
   * fresh session, so the store the play screen was subscribed to is dropped
   * along with the run in it.
   */
  function leave() {
    setSession(fresh());
    setError(undefined);
    setProgress(undefined);
    setLastRequest(undefined);
  }

  const items = useMemo(() => {
    if (!run) return [];
    const name = (id: string) => run.entities.rooms.find((r) => r.id === id)?.name ?? "Somewhere";
    const pass = session.store.getState().dungeon?.pass;
    return toItems(run.log, name, pass && { name: pass.name, objective: pass.goal.summary });
  }, [run?.log]);

  return {
    session,
    dungeon,
    run,
    items,
    progress,
    error,
    lastRequest,
    begin,
    beginExisting,
    takeAndDescend,
    resume,
    retry,
    leave,
  };
}
