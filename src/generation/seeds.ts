/**
 * SEED DERIVATION
 *
 * "A seed" means one number to the player and to the URL. The engine's entry
 * points disagree about what a seed is -- `generateBlueprint` takes a string,
 * `generateBlueprintSeed` takes a number, `stockDungeon` defaults to
 * `blueprint.seed + 7919` -- so the mapping is settled here, once, rather than
 * at each call site.
 *
 * Generation and play draw from SEPARATE streams. Re-rolling a character or
 * replaying a run must not shift the dungeon, and vice versa.
 *
 * Entity ids are NOT derived from any of these: `makeId` uses crypto.randomUUID
 * deliberately, on the grounds that ids are identity rather than content. Two
 * generations of the same seed therefore agree on everything except ids, which
 * is why determinism tests compare an id-stripped form.
 */

import type { Size } from "./content/blueprint.ts";
import { makeRng, type Params as GraphParams } from "./floorplan/graph.ts";

export interface RunSeeds {
  /** the user-facing number: URL, save file, "seed 1005" */
  dungeonSeed: number;
  /** the graph generator wants a string */
  graphSeed: string;
  /** the rolled genome */
  blueprintSeed: number;
  /** stocking; matches stockDungeon's own default so both agree */
  stockSeed: number;
  /**
   * The floorplan. Its own stream because the packer retries — it advances this
   * seed until a plan draws — and a run of failed attempts must not shift what
   * is in the rooms.
   */
  layoutSeed: number;
  /** play-time rolls, independent of everything above */
  runSeed: number;
}

export function deriveSeeds(dungeonSeed: number, runSeed?: number): RunSeeds {
  return {
    dungeonSeed,
    graphSeed: String(dungeonSeed),
    blueprintSeed: dungeonSeed,
    stockSeed: dungeonSeed + 7919,
    layoutSeed: dungeonSeed + 104_729,
    runSeed: runSeed ?? dungeonSeed ^ 0x5f3759df,
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

/**
 * A dungeon's shape, from its size: how many rooms and loops, and how strict
 * the graph's checks are. Rolled once per dungeon from its own stream, before
 * any graph attempt, so a retried graph keeps the room and loop counts.
 *
 * Small dungeons get slack: five or six rooms can't carry a bypass and a
 * balance check as well as two routes.
 *
 *   size        rooms   loops           dead ends   routes   bypass, balance
 *   1 small     5-6     1-2, mostly 2   <= 1        >= 2     no
 *   2 medium    7-9     2-3             <= 1        >= 3     yes
 *   3 large     10-12   3-4             <= 2        >= 3     yes
 */
export function shapeFor(size: Size, graphSeed: string): GraphParams {
  const rng = makeRng(`${graphSeed}:shape`);
  const between = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  switch (size) {
    case 1:
      return { rooms: between(5, 6), loops: rng() < 2 / 3 ? 2 : 1, maxDeadEnds: 1, minRoutes: 2, bypass: false, balance: false };
    case 2:
      return { rooms: between(7, 9), loops: between(2, 3), maxDeadEnds: 1, minRoutes: 3, bypass: true, balance: true };
    case 3:
      return { rooms: between(10, 12), loops: between(3, 4), maxDeadEnds: 2, minRoutes: 3, bypass: true, balance: true };
  }
}

/** What a size is called wherever a player reads it. */
export const SIZE_NAMES: Record<Size, string> = { 1: "small", 2: "medium", 3: "large" };
