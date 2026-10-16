/**
 * THE TABLES ONLY STOCKING ROLLS ON, and the cascade roller over them.
 *
 * This roller is separate from the Maze Rats one in `rules/maze-rats/tables.ts`
 * because its cascade map names a different set of tables. Merging the two is
 * a change to what gets rolled, so it waits for a session that can show the
 * generation snapshots are unchanged.
 */

import {
  BUILDING_ROOMS,
  DUNGEON_ROOMS,
  LOWER_CLASS_BUILDINGS,
  UPPER_CLASS_BUILDINGS,
  TREASURE_ITEMS,
  VALUABLE_MATERIALS,
  WEAPON_ITEMS,
} from "../../../rules/maze-rats/tables.ts";
import { Rng, type Rolled } from "../../../shared/utils/rng.ts";

// ---------------------------------------------------------------------------
// TABLES
// Shared Maze Rats tables live in rules/maze-rats/tables.ts and are imported
// above -- keeping second copies here is what let "Maze potion" drift into
// "Maze pattern". Only tables used by nothing but the rooms loop stay local.
// ---------------------------------------------------------------------------

export const t = (s: string): string[] => s.split("|");

// --- Maze Rats: THE MAZE -----------------------------------------------------

export const DUNGEON_ACTIVITIES = t(
  "Besiege|Capture|City Activity|Collect|Construct|Control|Deliver|Demolish|Escape|Feed|Fortify|Guard|Hide|Hunt|Loot|Map|Mine|{Monster} Tactic|Negotiate|Patrol|Perform ritual|Purge|Question|Raid|Repair|Rescue|Research|Revive|Riddle|Scavenge|Seize|Tunnel|Unearth|Vandalize|Wild. Activity|Worship"
);

// --- Cairn 2e ---------------------------------------------------------------

export const CAIRN_SPECIAL = t(
  "Books|Bridge|Contraption|Creature|Door|Flames|Furniture|Hole|Liquid|Mirror|Mural|Pool|Shadows|Smoke|Statue|Surface|Treasure|Voices|Wheel|Writing"
);

export const CAIRN_FEATURE = t(
  "Ages|Alarms|Animates|Attracts|Charges|Closes|Falls|Glows|Grows|Illusion|Levitates|Locks|Opens|Reflects|Repels|Reveals|Shifts|Silences|Teleport|Transforms"
);

export const CAIRN_CLUE = t(
  "Decay|Decor|Draft|Echoes|Footprints|Leavings|Light|Markings|Moisture|Noise|Paraphernalia|Residue|Scurrying|Signs|Smell|Stains|Tapping|Temperature|Vibrations|Writing"
);

// ---------------------------------------------------------------------------
// CASCADES
// ---------------------------------------------------------------------------

const CASCADE_TABLES: Record<string, readonly string[]> = {
  "Building Room": BUILDING_ROOMS,
  "Dungeon Room": DUNGEON_ROOMS,
  "L. Cl. Building": LOWER_CLASS_BUILDINGS,
  "U. Cl. Building": UPPER_CLASS_BUILDINGS,
  "Treasure Item": TREASURE_ITEMS,
  "Val. Material": VALUABLE_MATERIALS,
  "Weapon Item": WEAPON_ITEMS,
};

/** Entity cascades emit a stub for the LLM instead of recursing. */
const ENTITY_CASCADES = new Set(["Monster", "NPC", "faction", "monster"]);
const MAX_CASCADE_DEPTH = 2;

function resolveCascades(entry: string, rng: Rng, depth = 0): string {
  return entry.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    // An entity reference names something the writing pass must supply; it
    // cannot come from a table, so the marker stays inline.
    if (ENTITY_CASCADES.has(key)) return key;
    const table = CASCADE_TABLES[key];
    if (!table || depth >= MAX_CASCADE_DEPTH) return key;
    return resolveCascades(rng.pick(table), rng, depth + 1);
  });
}

export function roll(table: readonly string[], rng: Rng): Rolled {
  return resolveCascades(rng.pick(table), rng);
}
