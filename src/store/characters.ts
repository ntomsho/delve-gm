/**
 * WHERE CHARACTERS LIVE
 * =====================
 *
 * One module, one job: hand out the saved characters. Today that is an array
 * with the test character in it. Later it is a database, and when it is, this
 * is the only file that changes — nothing above it knows or asks where a
 * character came from.
 *
 * The functions are async now, before there is anything to await. That is
 * deliberate. A database is async, and a component tree built on the
 * assumption that reading a character is free has to be unpicked a screen at a
 * time when that stops being true — the same retrofit BUILD-PLAN §6 warns
 * about for `turnCount`. One `await` against an array costs nothing today and
 * buys the swap for free later.
 *
 * Saving and deleting arrived with Phase 5, and they write to the same array.
 * **A character does not survive a reload.** That is deliberate for this pass:
 * serialising them is its own decision — what the record looks like, what
 * happens to one saved against an older shape — and making that decision badly
 * now would be harder to undo than making it later. So a character made this
 * session can be taken into a run this session, and the seeded one comes back
 * either way.
 */

import type { PlayerCharacter } from "../engine/index.ts";
import { testCharacter } from "../runtime/__fixtures__/offline.ts";

/**
 * The stock. Seeded with the fixture, which is why the first occupant is called
 * Testy and has +3 in everything — that one is scaffolding and the dev
 * quick-start, not a character anyone rolled up.
 */
const STOCK: PlayerCharacter[] = [testCharacter()];

export async function listCharacters(): Promise<PlayerCharacter[]> {
  return [...STOCK];
}

export async function getCharacter(id: string): Promise<PlayerCharacter | undefined> {
  return STOCK.find((c) => c.id === id);
}

/** Add a newly made character, or replace one with the same id. */
export async function saveCharacter(pc: PlayerCharacter): Promise<PlayerCharacter> {
  const i = STOCK.findIndex((c) => c.id === pc.id);
  if (i === -1) STOCK.push(pc);
  else STOCK[i] = pc;
  return pc;
}

/** Remove one. Returns whether there was anything to remove. */
export async function deleteCharacter(id: string): Promise<boolean> {
  const i = STOCK.findIndex((c) => c.id === id);
  if (i === -1) return false;
  STOCK.splice(i, 1);
  return true;
}
