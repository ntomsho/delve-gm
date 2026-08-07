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
 * Saving and deleting are not here yet: character creation is disabled until
 * Phase 5, so there is no way to make a character that would need saving, and
 * an unused write path is a thing that rots before it is ever called.
 */

import type { PlayerCharacter } from "../engine/index.ts";
import { testCharacter } from "../runtime/__fixtures__/offline.ts";

/**
 * The whole stock, for now. Seeded from the fixture rather than created by the
 * player, which is why the one occupant is called Testy and has +3 in
 * everything — this is scaffolding standing in for Phase 5, not a pregenerated
 * character anyone chose.
 */
const SEEDED: PlayerCharacter[] = [testCharacter()];

export async function listCharacters(): Promise<PlayerCharacter[]> {
  return SEEDED;
}

export async function getCharacter(id: string): Promise<PlayerCharacter | undefined> {
  return SEEDED.find((c) => c.id === id);
}
