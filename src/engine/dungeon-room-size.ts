/**
 * ROOM SIZE AND SHAPE — the vocabulary, and nothing that uses it.
 *
 * Its own module because both ends of the pipeline need it and they sit on
 * opposite sides of the drawing. `dungeon-blockplan.ts` reads the bands to say
 * how big a room came out; `dungeon-rooms-loop.ts` reads `sizeAllows` to decide
 * what that room is then allowed to be. Neither should have to import the other,
 * and before this module existed the vocabulary lived in `dungeon-floorplan.ts`
 * with the rooms loop importing it back through a type-only cycle.
 *
 * Tables and predicates only. No geometry.
 */

/**
 * The silhouette. `round` is an ellipse inscribed in the bounding box; the other
 * four are orthogonal. A cave is not a family — it is relief 2 over whatever
 * family is underneath, which is more expressive than a category of its own: a
 * heavily relieved cross is a fissure and a heavily relieved rect is a collapsed
 * hall.
 */
export type Family = "rect" | "L" | "T" | "cross" | "round";

/** Long side over short. Governs the bounding box; nothing else does. */
export type Proportion = "square" | "moderate" | "long";

/** 0 perfect · 1 irregular but the shape still reads · 2 highly irregular. */
export type Relief = 0 | 1 | 2;

export type SizeClass = "tiny" | "small" | "medium" | "large";

/**
 * Four axes that vary independently. Kept as one object rather than four loose
 * fields because 6c hands the whole thing to the content pass, as named axes
 * rather than geometry — "a long cross-shaped hall, heavily broken up" is
 * something a model can write to without ever seeing a coordinate.
 */
export interface RoomShape {
  family: Family;
  proportion: Proportion;
  relief: Relief;
  /** derived from the floor area the room ended up with, never dictated to it */
  sizeClass: SizeClass;
}

/**
 * class -> [min area, max area], measured on FLOOR AREA and not on the bounding
 * box. A cross fills perhaps 40% of its box, so the two numbers come apart badly
 * on the shaped families and only one of them is what the fiction means. The box
 * is capped separately, by `BOX_CAP`.
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

/**
 * An archetype constrains the axes it means and leaves the rest to roll, which
 * is where the variety comes from. `Well` is round and tiny and says nothing
 * about proportion or relief; `Cavern` is relief 2 over any family at all.
 */
export interface Archetype {
  family?: Family[];
  proportion?: Proportion;
  /** pins relief outright — the only way relief 2 ever appears */
  relief?: Relief;
  /** caps it without pinning */
  maxRelief?: Relief;
  /** pins the class outright */
  sizeClass?: SizeClass;
  /** raises the floor without pinning it */
  minClass?: SizeClass;
}

/**
 * `identity` rolls on DUNGEON_ROOMS, whose three nested references reach
 * BUILDING_ROOMS, LOWER_CLASS_BUILDINGS and UPPER_CLASS_BUILDINGS — about 130
 * distinct nouns. A complete mapping would be a chore that rots, so only the
 * nouns that genuinely imply a geometry are annotated and the other ~90 fall
 * through to a default that **still rolls among the classes**: monotony is the
 * failure mode to design against, not inaccuracy.
 *
 * Every key here is asserted reachable from those four tables (see the tests) —
 * an annotation keyed on a noun that never rolls is dead weight that looks
 * live. `Silo`, `Tidal cave` and `Sinkhole` were cut from an earlier draft for
 * exactly that reason: the first is on no table, the second is a Dungeon
 * Entrance and the third a Dungeon Hazard.
 */
export const ARCHETYPES: Record<string, Archetype> = {
  // Long and narrow. Family, relief and size all stay free.
  "Banquet hall": { proportion: "long" },
  Ballroom: { proportion: "long" },
  Gallery: { proportion: "long" },
  Barracks: { proportion: "long" },
  Dormitory: { proportion: "long" },
  Stables: { proportion: "long" },
  Kennel: { proportion: "long" },
  Catacombs: { proportion: "long" },
  Sewers: { proportion: "long" },

  // Round. Square + relief 0 is a circle, `long` is an oval; proportion and
  // size stay free, and only the Well is pinned small enough to be a shaft.
  Well: { family: ["round"], maxRelief: 1, sizeClass: "tiny" },
  Fountain: { family: ["round"], maxRelief: 1 },
  Pool: { family: ["round"], maxRelief: 1 },
  "Fighting pit": { family: ["round"], maxRelief: 1 },
  Oubliette: { family: ["round"], maxRelief: 1 },
  Observatory: { family: ["round"], maxRelief: 1 },

  // Irregular in SHAPE, which on these axes is relief 2 over any family —
  // 6a's `irregular` form was a shape and a modifier tangled together.
  // `Attic`, `Garret`, `Root cellar` and `Junk room` were considered and
  // rejected: they are irregular only in their contents.
  Cavern: { relief: 2 },
  Chasm: { relief: 2 },
  "Mine shaft": { relief: 2 },

  // Axial with an end feature — nave and transept, stem and bar. 6a called
  // this `composite` and invented a form for it; it is simply a T.
  Chapel: { family: ["T", "cross"], proportion: "long", maxRelief: 1 },
  Shrine: { family: ["T", "cross"], proportion: "long", maxRelief: 1 },
  Temple: { family: ["T", "cross"], proportion: "long", maxRelief: 1 },
  "Throne room": { family: ["T", "cross"], proportion: "long", maxRelief: 1 },
  Courthouse: { family: ["T", "cross"], proportion: "long", maxRelief: 1 },
  "Opera house": { family: ["T", "cross"], proportion: "long", maxRelief: 1 },

  // Large and open: a courtyard with a bitten corner is not a courtyard.
  Courtyard: { minClass: "large", relief: 0 },
  Garden: { minClass: "large", relief: 0 },
  Marketplace: { minClass: "large", relief: 0 },
  Park: { minClass: "large", relief: 0 },
  Theater: { minClass: "large", relief: 0 },
  Warehouse: { minClass: "large", relief: 0 },

  // Tiny, and tiny cannot carry relief — 20 distinct silhouettes in 583 draws.
  Privy: { sizeClass: "tiny", relief: 0 },
  Cabinet: { sizeClass: "tiny", relief: 0 },
  Cloakroom: { sizeClass: "tiny", relief: 0 },
  Wardrobe: { sizeClass: "tiny", relief: 0 },
  Pantry: { sizeClass: "tiny", relief: 0 },
  Larder: { sizeClass: "tiny", relief: 0 },
};

/**
 * May a room of this size be this thing?
 *
 * Read the other way round from how 6a used it. There, an archetype's size pin
 * was an instruction to the packer — a Well had to come out tiny — and the
 * packer frequently could not oblige, because a room's size is decided by the
 * ground available and not by what it rolled. Here the geometry is already
 * settled and the pin is a CONDITION ON THE ROLL: a four-cell closet does not
 * get to be a banquet hall, and a hall the size of a courtyard does not get to
 * be a privy.
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

/** Every annotated noun a room of this size may be, for measuring the squeeze. */
export function identitiesForSize(cls: SizeClass): string[] {
  return Object.keys(ARCHETYPES).filter((k) => sizeAllows(k, cls));
}
