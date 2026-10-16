/**
 * ROOM SIZE — the vocabulary, and nothing that uses it.
 *
 * Its own module because both ends of the pipeline need it and they sit on
 * opposite sides of the drawing. `blockplan.ts` reads the bands to say
 * how big a room came out; `stock.ts` reads `sizeAllows` to decide
 * what that room is then allowed to be. Neither should have to import the other.
 *
 * Tables and predicates only. No geometry.
 */

/** Long side over short: how a room grows inside its zone (`blockplan.ts`). */
export type Proportion = "square" | "moderate" | "long";

export type SizeClass = "tiny" | "small" | "medium" | "large";

/**
 * class -> [min area, max area], measured in floor cells.
 *
 * THE BANDS ARE CONTIGUOUS, so a range of classes is a single interval of areas
 * and there is no hole for a room's only achievable area to fall into.
 *
 * FOUR BANDS, AND THEY ARE TIGHT. These describe what the block plan actually
 * draws — rooms of ten to forty cells, on zones of twenty to forty — rather than
 * an idealised spread. `large` is the top band and open-ended in intent; the
 * number is only the largest footprint that can be drawn at all. An earlier
 * five-band spread ran to 196 and put three of its five bands out of reach,
 * which made the size a worse signal than no size at all.
 */
export const AREA: Record<SizeClass, [number, number]> = {
  tiny: [4, 9],
  small: [10, 25],
  medium: [26, 35],
  large: [36, 576],
};

export const CLASSES: SizeClass[] = ["tiny", "small", "medium", "large"];
export const classRank = (c: SizeClass) => CLASSES.indexOf(c) + 1;

/** The class an area falls in. Total, because the bands are contiguous. */
export function classOf(area: number): SizeClass {
  for (const c of CLASSES) if (area <= AREA[c][1]) return c;
  return "large";
}

/** What a noun says about the size of the room it can be. */
export interface Archetype {
  /** pins the class outright */
  sizeClass?: SizeClass;
  /** raises the floor without pinning it */
  minClass?: SizeClass;
}

/**
 * `identity` rolls on DUNGEON_ROOMS, whose three nested references reach
 * BUILDING_ROOMS, LOWER_CLASS_BUILDINGS and UPPER_CLASS_BUILDINGS — about 130
 * distinct nouns. A complete mapping would be a chore that rots, so only the
 * nouns that genuinely imply a size are annotated and the rest fall through
 * to a default that **still rolls among the classes**: monotony is the failure
 * mode to design against, not inaccuracy.
 *
 * Every key here is asserted reachable from those four tables (see the tests) —
 * an annotation keyed on a noun that never rolls is dead weight that looks
 * live. `Silo`, `Tidal cave` and `Sinkhole` were cut from an earlier draft for
 * exactly that reason: the first is on no table, the second is a Dungeon
 * Entrance and the third a Dungeon Hazard.
 */
export const ARCHETYPES: Record<string, Archetype> = {
  // Large and open: a courtyard the size of a cupboard is not a courtyard.
  Courtyard: { minClass: "large" },
  Garden: { minClass: "large" },
  Marketplace: { minClass: "large" },
  Park: { minClass: "large" },
  Theater: { minClass: "large" },
  Warehouse: { minClass: "large" },

  // Tiny: a shaft, a closet, a cupboard of a room.
  Well: { sizeClass: "tiny" },
  Privy: { sizeClass: "tiny" },
  Cabinet: { sizeClass: "tiny" },
  Cloakroom: { sizeClass: "tiny" },
  Wardrobe: { sizeClass: "tiny" },
  Pantry: { sizeClass: "tiny" },
  Larder: { sizeClass: "tiny" },
};

/**
 * May a room of this size be this thing?
 *
 * A room's size is decided by the ground it was given, before anything rolls
 * what it is. So the pin is a CONDITION ON THE ROLL, not an instruction to the
 * drawing: a four-cell closet does not get to be a courtyard, and a hall the
 * size of a courtyard does not get to be a privy.
 *
 * Everything unannotated passes at every size, which is most of the table.
 */
export function sizeAllows(identity: string, cls: SizeClass): boolean {
  const arch = ARCHETYPES[identity];
  if (!arch) return true;
  if (arch.sizeClass && arch.sizeClass !== cls) return false;
  if (arch.minClass && classRank(cls) < classRank(arch.minClass)) return false;
  return true;
}

