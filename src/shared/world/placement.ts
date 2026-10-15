/**
 * WHERE THINGS STAND IN A ROOM
 *
 * The vocabulary a room is furnished in: the drawable fixture kinds, the
 * position words a model picks from, and a placement on the grid. Generation
 * places things (`generation/floorplan/fixtures.ts`); the map, the
 * illustrations and the prose all read where they ended up.
 */

import type { Point } from "../utils/grid.ts";

export const FIXTURE_KINDS = [
  "altar",
  "bunks",
  "cells",
  "hearth",
  "pews",
  "pillars",
  "pit",
  "pool",
  "rubble",
  "sarcophagi",
  "shelves",
  "stair",
  "stalls",
  "well",
] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export const POSITION_WORDS = [
  "north wall",
  "south wall",
  "east wall",
  "west wall",
  "centre",
  "a corner",
  "near the entrance",
  "far end",
  "throughout",
] as const;

export type PositionWord = (typeof POSITION_WORDS)[number];

/**
 * A position word as something you could say out loud.
 *
 * The words are ENUM VALUES — short, unambiguous, easy for a model to pick from
 * a list — and they do not survive being dropped into a sentence: "at
 * throughout" and "at near the entrance" are what a naive prefix produces. So
 * the wire form and the prose form are separate, and this is the only place the
 * second one is decided.
 *
 * Falls through unchanged for anything it does not recognise, because the
 * caller is rendering an entity that was stored, not validating a response.
 */
const POSITION_PHRASE: Record<PositionWord, string> = {
  "north wall": "along the north wall",
  "south wall": "along the south wall",
  "east wall": "along the east wall",
  "west wall": "along the west wall",
  centre: "in the middle of the room",
  "a corner": "in a corner",
  "near the entrance": "near the way in",
  "far end": "at the far end",
  throughout: "spread through the room",
};

export function positionPhrase(word: string): string {
  return isPositionWord(word) ? POSITION_PHRASE[word] : word;
}

export const isFixtureKind = (s: string): s is FixtureKind =>
  (FIXTURE_KINDS as readonly string[]).includes(s);

export const isPositionWord = (s: string): s is PositionWord =>
  (POSITION_WORDS as readonly string[]).includes(s);

/**
 * Where something stands, as a fact about the room.
 *
 * `position` is kept alongside the cells because it is what the PROSE is allowed
 * to say. The cells are for the drawing; "the north wall" is for the sentence,
 * and the two must not be re-derived from each other or they will drift.
 *
 * Written once at generation. Not on the applier's writable-path allowlist —
 * a brazier that gets knocked over changes its `state`, not its geometry, and
 * moving furniture is a map problem nobody has yet asked to have.
 */
export interface Placement {
  cells: Point[];
  position: PositionWord;
  /** which drawable thing, when it came from the menu. Absent on stocked things. */
  fixture?: FixtureKind;
}
