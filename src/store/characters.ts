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

const BASE = "/api/characters";

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`could not ${what} (${res.status})`);
  return (await res.json()) as T;
}

export async function listCharacters(): Promise<PlayerCharacter[]> {
  return json(await fetch(BASE), "read the characters");
}

export async function getCharacter(id: string): Promise<PlayerCharacter | undefined> {
  const all = await listCharacters();
  return all.find((c) => c.id === id);
}

/** Add a newly made character, or replace one with the same id. */
export async function saveCharacter(pc: PlayerCharacter): Promise<PlayerCharacter> {
  return json(
    await fetch(BASE, {
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
    await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    "delete the character"
  );
  return deleted;
}
