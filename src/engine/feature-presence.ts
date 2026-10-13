/**
 * FEATURE PRESENCE
 * ================
 *
 * What KIND of thing a feature is to the eye, which decides how a room plate
 * treats it:
 *
 *   object   a thing standing somewhere — an altar, a lever, a heap of tablets.
 *            Drawn where it is, with a placement mark in the guide image.
 *   surface  something on the walls, the floor or the air of the room — smoke
 *            stains, slime trails, a mural, haze. Drawn, but as a treatment of
 *            the room rather than at a spot, so it gets no placement mark.
 *   sense    a sound, a smell, a draft. Not drawable at all.
 *
 * Decided from the TABLE ENTRY the feature was rolled from (`keywords`), not by
 * reading the prose: the tables are finite and their entries mean the same
 * thing every time, so a lookup is exact and free. A fixture is always an
 * object — the fixture menu is a list of drawable things by construction. The
 * one judgement the content pass did make, "throughout", already says the
 * thing is everywhere rather than somewhere, and is read as a surface.
 *
 * Anything not listed is an object. A new table entry that is not a thing will
 * get a mark it should not have until it is added here, which is the cheap
 * failure: a dashed outline where a smell should be, not a missing altar.
 */

export type Presence = "object" | "surface" | "sense";

/** Table entries that are heard, smelled or felt, never seen. */
const SENSE = new Set([
  // Maze Rats room details
  "Faint breeze",
  "Faint footsteps",
  "Stench",
  "Unusual smell",
  "Vibrations",
  "Whispers",
  // Cairn specials and clues
  "Voices",
  "Draft",
  "Echoes",
  "Noise",
  "Smell",
  "Tapping",
  "Temperature",
  "Scurrying",
  // Maze Rats hazards
  "Deafening noise",
]);

/** Table entries that cover the room — its walls, floor or air — rather than stand in it. */
const SURFACE = new Set([
  // Maze Rats room details
  "Bas-relief",
  "Blood trail",
  "Chalk marks",
  "Claw marks",
  "Crumbling walls",
  "Dripping water",
  "Fading murals",
  "Fungus",
  "Graffiti",
  "Mosaics",
  "Slime trails",
  "Smoke stains",
  "Spider webs",
  "Thick dust",
  "Tree roots",
  "Vines",
  // Cairn specials and clues
  "Decay",
  "Decor",
  "Footprints",
  "Light",
  "Markings",
  "Moisture",
  "Mural",
  "Residue",
  "Shadows",
  "Smoke",
  "Stains",
  "Surface",
  "Writing",
  // Maze Rats hazards that fill the air
  "Choking dust",
  "Dense fog",
  "Spores",
  "Toxic fumes",
]);

export function featurePresence(keywords: Record<string, string> | undefined, position?: string): Presence {
  const rolled = Object.entries(keywords ?? {});
  if (rolled.some(([table]) => table === "Fixture")) return "object";
  const values = rolled.map(([, v]) => v);
  if (values.some((v) => SENSE.has(v))) return "sense";
  if (values.some((v) => SURFACE.has(v))) return "surface";
  if (position === "throughout") return "surface";
  return "object";
}
