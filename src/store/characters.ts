/**
 * WHERE CHARACTERS LIVE
 * =====================
 *
 * One module, one job: hand out the saved characters. It was an array with the
 * test character in it; **as of Phase 10 it is the database**, and this file is
 * the only one that changed — nothing above it knew or asked where a character
 * came from, which is what the header here promised in Phase 5 and is now the
 * receipt for it.
 *
 * The functions were made async before there was anything to await, and that is
 * why: a component tree built on the assumption that reading a character is
 * free would have had to be unpicked a screen at a time when that stopped being
 * true. One `await` against an array cost nothing then and bought the swap for
 * free now.
 *
 * **A character survives a reload now**, which settles the open question
 * CODING-PLAN §3.6 left deliberately unanswered — what the stored record looks
 * like, and what happens to one saved against an older shape. The record is the
 * sheet, whole, in a jsonb column: `PlayerCharacter` is already the serialisable
 * thing that goes in and out of a run, so there is no second shape to keep in
 * step and no migration to write when the sheet grows a field. A sheet stored
 * before a field existed reads back without it, exactly as a save from before
 * `fiction` did — see `worldOf` in game.ts.
 *
 * THE SEEDED FIXTURE IS GONE from here. `testCharacter()` is the dev
 * quick-start and belongs to the fixtures; a shared database that hands every
 * visitor somebody called Testy with +3 in everything is a different thing
 * entirely. `?offline` and `?stub` still get it — see App.tsx.
 */

import type { PlayerCharacter } from "../engine/index.ts";
import { authedFetch } from "./auth.ts";

const BASE = "/api/characters";

/**
 * The server's own sentence when it has one.
 *
 * Refusals here are things the player can act on — "that character is in a run"
 * is a instruction, and `could not delete the character (409)` is a number. The
 * status stays as the fallback for a failure with no body worth reading.
 */
async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `could not ${what} (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * What has happened to a character, and where they are.
 *
 * NONE OF IT IS STORED ON THE CHARACTER. The four counters are a grouping of
 * `runs.status` and the active run is a row in `runs`; the server derives both
 * on read. So this is a view of a character rather than a bigger character, and
 * `sheet` is still the only part of it anybody saves.
 */
export interface CharacterRecord {
  dead: number;
  abandoned: number;
  escaped: number;
  goalMet: number;
}

export interface ActiveRun {
  id: string;
  dungeonId: string;
  dungeonName: string;
  turnCount: number;
}

export interface CharacterEntry {
  sheet: PlayerCharacter;
  record: CharacterRecord;
  /** Present exactly when this character may not be sent anywhere else. */
  activeRun?: ActiveRun;
}

/**
 * Everyone the player has, with their record and their whereabouts.
 *
 * THE ONLY READ, since Phase 12. There were a `listCharacters` and a
 * `getCharacter` beside this returning bare sheets, and they went with the
 * screen that could use one: a sheet on its own cannot answer the question the
 * roster asks, which is whether this person can be sent anywhere. Anything
 * wanting sheets alone maps over these, and `RunSetup` does exactly that after
 * `App` has dropped the ones already in a run.
 */
export async function listRoster(): Promise<CharacterEntry[]> {
  return json(await authedFetch(BASE), "read the characters");
}

/** A character with no runs behind them, for the paths that have no server. */
export const NO_RECORD: CharacterRecord = { dead: 0, abandoned: 0, escaped: 0, goalMet: 0 };

/** Add a newly made character, or replace one with the same id. */
export async function saveCharacter(pc: PlayerCharacter): Promise<PlayerCharacter> {
  return json(
    await authedFetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pc),
    }),
    "save the character"
  );
}

/** Remove one. Returns whether there was anything to remove. */
export async function deleteCharacter(id: string): Promise<boolean> {
  const { deleted } = await json<{ deleted: boolean }>(
    await authedFetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    "delete the character"
  );
  return deleted;
}
