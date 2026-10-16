/**
 * THE CENSUS: every creature in the dungeon the player is not standing next to.
 * For the game master only.
 */

import { maxHp } from "../../shared/world/entities.ts";
import { roomDistances } from "../mechanics/travel.ts";
import type { RunState } from "../state/store.ts";

// ===========================================================================
// EVERY OTHER CREATURE IN THE DUNGEON
// ===========================================================================

/**
 * One line of the census — a creature the player is not standing next to.
 *
 * GAME MASTER ONLY, like `CombatView` in `entities.ts` and for a stronger reason: this is the
 * one thing the runtime hands over that the *character* does not have. Nothing
 * in `ui/` reads it.
 */
export interface CensusEntry {
  id: string;
  name: string;
  /** how many bodies; 1 for a lone specimen */
  count: number;
  roomId: string;
  roomName: string;
  /** rooms crossed to get there; absent when no way leads to it at all */
  roomsAway?: number;
  /** the player has stood in that room, so they could name it */
  roomVisited: boolean;
  /** hurt, without saying how badly — the numbers are `renderRoom`'s job */
  wounded: boolean;
  activity?: string;
}

/**
 * ALL OF THEM, EVERY CALL.
 *
 * The whole design turns on how many there are, so it was measured before it
 * was designed: the largest dump in the repo — 18 rooms — holds 12 creature
 * entities across 6 rooms, and a full census one line each is about 625 tokens
 * against ~11,500 for a resolution turn. There is no version of this worth
 * being clever about, so there is no filtering, no radius and no budget.
 *
 * WHAT IS NOT IN IT is the room the player is standing in. `roomView` already
 * carries those creatures with `base`, `state`, `composed`, `activity`,
 * defenses and hit points; a census line for them would be a second, poorer
 * copy, and two renderings of one creature is an invitation for the two to
 * disagree.
 *
 * A GROUP OF NONE IS GONE. `count: 0` is a wiped-out group the applier has not
 * removed, and listing it invites the game master to send a dead pack somewhere.
 *
 * Distances come from `roomDistances`, which walks the graph WITHOUT the
 * visited-only rule `shortestPath` applies to the player — a creature knows its
 * own home. One BFS answers for every line.
 */
export function censusView(run: RunState): CensusEntry[] {
  const e = run.entities;
  const away = roomDistances(run, run.currentRoomId);

  return e.creatures
    .filter((c) => c.roomId !== run.currentRoomId)
    .filter((c) => c.count === undefined || c.count > 0)
    .map((c): CensusEntry => {
      const room = e.rooms.find((r) => r.id === c.roomId);
      const distance = away.get(c.roomId);
      return {
        id: c.id,
        name: c.name,
        count: c.count ?? 1,
        roomId: c.roomId,
        roomName: room?.name ?? "(nowhere)",
        ...(distance !== undefined ? { roomsAway: distance } : {}),
        // The same test the map uses for "the player has been here" — a room's
        // `composed` is written the first time they walk in and never before.
        roomVisited: room?.composed !== undefined,
        wounded: c.stats.hp < maxHp(c.stats),
        ...(c.activity !== undefined ? { activity: c.activity } : {}),
      };
    });
}
