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

export interface RunSeeds {
  /** the user-facing number: URL, save file, "seed 1005" */
  dungeonSeed: number;
  /** phase A wants a string */
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
 * A size-n dungeon is n chunks of six rooms: size 1 is 6 rooms, size 5 is 30.
 * Identity, so there is no table -- but the two types are declared
 * independently, so assert rather than assume.
 */
export function chunksFor(size: Size): number {
  return size;
}
