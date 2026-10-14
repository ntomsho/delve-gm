/**
 * FIXTURES — what is standing in the room, and where.
 *
 * The content pass already writes what a room IS. This lets it say what is IN
 * it in a form the map can draw: a fixed menu of things, and a coarse vocabulary
 * of places to put them. The model picks a kind and a position word; the code
 * rolls how many there are and works out which cells they stand on.
 *
 * THE SPLIT IS THE POINT, and it is the CLAUDE.md rule stated for this pass:
 * the model never returns a number and never returns a coordinate. "Pillars,
 * throughout" is a decision about fiction. How many pillars and which cells they
 * occupy is a decision about a drawing, and drawings are code's.
 *
 * A menu rather than free text for the same reason the diff applier has a path
 * allowlist: an enum can be drawn, validated and drawn again next session, where
 * a free-text "some sort of apparatus" can only ever be a dot with a name on it.
 * Unrecognised values are DROPPED, never fatal — a room with one fewer bench in
 * it is a smaller loss than a generation that fails.
 *
 * A fixture becomes a real `IRoomFeature` with a name and a base, so the referee
 * can be asked about it, the player can act on it, and it can carry state. It is
 * not map decoration with prose attached; it is a thing in the room that the map
 * happens to know where to draw.
 *
 * MARKERS ARE PLAIN DOTS FOR NOW — author's call. The data is stored as cells
 * and a kind rather than as a picture, which is what leaves "the pillars are
 * cover" and a library of line art both available later without regenerating
 * anything.
 */

import { Rng } from "../content/blueprint.ts";
import type { Point } from "./blockplan.ts";
import { wallCells, type RoomGeometry, type RoomGround, type Wall } from "./geometry.ts";

// ---------------------------------------------------------------------------
// THE MENU
// ---------------------------------------------------------------------------

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

interface FixtureSpec {
  /** what it is, as the model reads it in the menu */
  gloss: string;
  /**
   * How many markers it draws, inclusive. ROLLED IN CODE. The model saying
   * "pillars" is a statement about the room; the model saying "six pillars"
   * would be a number it invented, which is the one thing it may not do.
   */
  count: [number, number];
  /** it stands against a wall, so a wall position is chosen for it if none was */
  hugsWall: boolean;
  /** narrow enough for a passage. Most things are not. */
  corridor: boolean;
}

/**
 * The fifteen drawable things, and what each one implies about its placement.
 *
 * Adding to this list is a one-line change and deliberately so: the enum is the
 * whole contract, and a kind that draws as a dot needs nothing but a gloss, a
 * count and two flags.
 */
export const FIXTURES: Record<FixtureKind, FixtureSpec> = {
  altar: { gloss: "a raised block for offering, execution or display", count: [1, 1], hugsWall: false, corridor: false },
  bunks: { gloss: "tiers of sleeping berths", count: [3, 6], hugsWall: true, corridor: false },
  cells: { gloss: "barred or barricaded holding cells", count: [2, 5], hugsWall: true, corridor: false },
  hearth: { gloss: "a fire pit, forge or chimney breast", count: [1, 1], hugsWall: true, corridor: false },
  pews: { gloss: "ranked benches facing one way", count: [4, 8], hugsWall: false, corridor: false },
  pillars: { gloss: "columns holding the ceiling up", count: [2, 6], hugsWall: false, corridor: true },
  pit: { gloss: "an opening in the floor -- a shaft, a sump, a grave", count: [1, 1], hugsWall: false, corridor: true },
  pool: { gloss: "standing water, clean or otherwise", count: [1, 1], hugsWall: false, corridor: false },
  rubble: { gloss: "fallen stone and debris", count: [1, 3], hugsWall: false, corridor: true },
  sarcophagi: { gloss: "stone coffins, niches or shelves for the dead", count: [2, 5], hugsWall: true, corridor: true },
  shelves: { gloss: "racking, stacks or storage", count: [2, 4], hugsWall: true, corridor: true },
  stair: { gloss: "steps within the room, going nowhere else", count: [1, 1], hugsWall: true, corridor: true },
  stalls: { gloss: "partitioned bays for animals or work", count: [3, 6], hugsWall: true, corridor: false },
  well: { gloss: "a lined shaft down to water", count: [1, 1], hugsWall: false, corridor: false },
};

/**
 * How many fixtures a room may hold, by how big it is.
 *
 * A cap rather than a quota. A tiny room with three fixtures in it is a room
 * with no floor, and the model has no sense of how much space a stone coffin
 * takes because it has never been shown the grid. Anything past the cap is
 * dropped, quietly.
 */
const CAP: Record<string, number> = { tiny: 1, small: 2, medium: 3, large: 3 };

export function fixtureCap(g: RoomGeometry): number {
  return g.corridor ? 1 : (CAP[g.sizeClass] ?? 2);
}

export const isFixtureKind = (s: string): s is FixtureKind =>
  (FIXTURE_KINDS as readonly string[]).includes(s);

export const isPositionWord = (s: string): s is PositionWord =>
  (POSITION_WORDS as readonly string[]).includes(s);

/**
 * The menu, rendered ONCE for a prompt.
 *
 * Once, and not per room: a chunk is six rooms and the list is five hundred
 * characters, so repeating it costs three kilobytes a call to say the same
 * fourteen things six times. The narrower passage menu is expressed as a star
 * on the kinds that fit rather than as a second copy of most of the list.
 */
export function fixtureMenu(): string {
  return FIXTURE_KINDS.map(
    (k) => `${k}${FIXTURES[k].corridor ? "*" : ""} (${FIXTURES[k].gloss})`
  ).join("; ");
}

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------

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

export interface FixtureRequest {
  kind: FixtureKind;
  position: PositionWord;
}

const cellKey = (p: Point) => `${p.x},${p.y}`;
const dist2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * The cells a position word admits.
 *
 * Every word resolves to a subset of the room's floor, and every subset can come
 * back empty — a room with no corner, a corridor with no middle. The caller
 * falls back rather than failing.
 */
function candidates(word: PositionWord, ground: RoomGround, geom: RoomGeometry): Point[] {
  const cells = ground.cells;
  const facing = wallCells(cells);
  // Part of the signature though nothing reads it yet, so a word that needs the
  // shape -- "along the long axis", say -- does not change every caller.
  void geom;

  switch (word) {
    case "north wall":
    case "south wall":
    case "east wall":
    case "west wall":
      return facing[word.split(" ")[0] as Wall];

    case "a corner": {
      // Two perpendicular walls meeting at one cell. An L-shaped room has more
      // than four of these, which is right: the inside of the elbow is a corner
      // to stand something in as much as the outside of one is.
      const mine = new Set(cells.map(cellKey));
      const out = (c: Point, dx: number, dy: number) => !mine.has(cellKey({ x: c.x + dx, y: c.y + dy }));
      return cells.filter(
        (c) => (out(c, 0, -1) || out(c, 0, 1)) && (out(c, -1, 0) || out(c, 1, 0))
      );
    }

    case "centre": {
      // The middle third of the bounding box, intersected with actual floor —
      // which for a ragged room can be nothing, and then it falls back.
      const xs = cells.map((c) => c.x);
      const ys = cells.map((c) => c.y);
      const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
      const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
      const inThird = (v: number, lo: number, hi: number) =>
        v >= lo + (hi - lo) / 3 && v <= hi - (hi - lo) / 3;
      return cells.filter((c) => inThird(c.x, x0, x1) && inThird(c.y, y0, y1));
    }

    case "near the entrance":
    case "far end": {
      const from = ground.arrivalCell;
      if (!from) return cells;
      const ranked = [...cells].sort((a, b) => dist2(a, from) - dist2(b, from));
      const third = Math.max(1, Math.ceil(ranked.length / 3));
      return word === "near the entrance" ? ranked.slice(0, third) : ranked.slice(-third);
    }

    case "throughout": {
      // THE INTERIOR, not the whole floor — and the difference is the whole of
      // this case. `spread` is farthest-point sampling, so with a low count it
      // takes a cell and then the cell furthest from it, which in any room is
      // a corner. Debris "scattered across the floor" came back drawn as two
      // marks in opposite corners, which reads as the precise opposite of what
      // the word means. (8a A6.)
      //
      // Dropping the boundary ring costs the sampling nothing it was using
      // well and takes the corners off the table. A corridor and a room too
      // small to have an inside fall through to the whole floor, which is the
      // right answer there: a passage is all edge.
      const mine = new Set(cells.map(cellKey));
      const surrounded = (c: Point) =>
        mine.has(cellKey({ x: c.x + 1, y: c.y })) &&
        mine.has(cellKey({ x: c.x - 1, y: c.y })) &&
        mine.has(cellKey({ x: c.x, y: c.y + 1 })) &&
        mine.has(cellKey({ x: c.x, y: c.y - 1 }));
      const interior = cells.filter(surrounded);
      return interior.length ? interior : cells;
    }

    default:
      return cells;
  }
}

/**
 * Spread the markers out.
 *
 * Farthest-point sampling: take one at random, then each next one as far as
 * possible from everything already taken. Six pillars picked at random cluster;
 * six picked this way stand in something a player would read as a colonnade,
 * and it costs one pass over a few dozen cells.
 */
function spread(pool: Point[], n: number, rng: Rng): Point[] {
  if (pool.length <= n) return [...pool];
  const taken: Point[] = [rng.pick(pool)];
  while (taken.length < n) {
    let best: Point | undefined;
    let bestD = -Infinity;
    for (const c of pool) {
      if (taken.some((t) => t.x === c.x && t.y === c.y)) continue;
      const d = Math.min(...taken.map((t) => dist2(t, c)));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) break;
    taken.push(best);
  }
  return taken;
}

/**
 * Which wall a wall-hugging fixture goes against when it was not given one.
 *
 * The longest wall, because that is the one a rank of bunks or a row of stalls
 * would actually have been built along, and because it is the one with room.
 */
function longestWall(geom: RoomGeometry): PositionWord {
  const walls: Wall[] = ["north", "south", "east", "west"];
  const best = walls.reduce((a, b) => (geom.walls[b] > geom.walls[a] ? b : a));
  return `${best} wall` as PositionWord;
}

export interface PlaceOptions {
  /** cells already spoken for, so two fixtures never stand in the same square */
  taken?: Set<string>;
}

/**
 * Put one fixture in the room, or fail to.
 *
 * Fails — returns undefined — only when the room has no free floor left at all,
 * which a cap of three in a room of ten cells makes rare and does not make
 * impossible. A dropped fixture is a fixture the prose never mentioned, because
 * apply drops the entity with it.
 */
export function placeFixture(
  req: FixtureRequest,
  ground: RoomGround,
  geom: RoomGeometry,
  rng: Rng,
  opts: PlaceOptions = {}
): Placement | undefined {
  const spec = FIXTURES[req.kind];
  const taken = opts.taken ?? new Set<string>();
  const blocked = new Set([...ground.doorCells.map(cellKey), ...taken]);

  // A thing that stands against a wall, asked for in the middle of the room,
  // goes against the longest wall instead. The model's position word is a
  // preference; what the object is is a fact.
  const wanted =
    spec.hugsWall && !req.position.endsWith("wall") && req.position !== "a corner"
      ? longestWall(geom)
      : req.position;

  const free = (list: Point[]) => list.filter((c) => !blocked.has(cellKey(c)));
  let position = wanted;
  let pool = free(candidates(wanted, ground, geom));

  // Fall back through the room as a whole rather than dropping the fixture: the
  // word was a preference and the thing being there is the decision.
  //
  // THE WORD GOES WITH THE CELLS, THOUGH. `position` is what the prose and the
  // map hover are allowed to say, and a hearth that could not fit against the
  // north wall is not on the north wall — keeping the request would have the
  // room block naming a wall the marker is nowhere near, which is the one
  // disagreement between the drawing and the writing that 6c exists to stop.
  if (!pool.length) {
    pool = free(ground.cells);
    position = "throughout";
  }
  if (!pool.length) return undefined;

  const [lo, hi] = spec.count;
  const cells = spread(pool, Math.min(rng.range(lo, hi), pool.length), rng);
  for (const c of cells) taken.add(cellKey(c));

  return { cells, position, fixture: req.kind };
}

/**
 * Put a thing that is already in the room somewhere in it.
 *
 * The stocked chest, the clue, the hazard: they exist whatever happens, so this
 * never fails to place them if there is a cell at all, and it takes ONE cell
 * because a chest is a chest. Without this the map would dot the furniture and
 * miss the things the player came for.
 */
export function placeAt(
  word: PositionWord,
  ground: RoomGround,
  geom: RoomGeometry,
  rng: Rng,
  opts: PlaceOptions = {}
): Placement | undefined {
  const taken = opts.taken ?? new Set<string>();
  const blocked = new Set([...ground.doorCells.map(cellKey), ...taken]);
  const free = (list: Point[]) => list.filter((c) => !blocked.has(cellKey(c)));

  let position = word;
  let pool = free(candidates(word, ground, geom));
  // Same as `placeFixture`: once the cells stop coming from the word, the word
  // stops being something the prose may repeat.
  if (!pool.length) {
    pool = free(ground.cells);
    position = "throughout";
  }
  // Last resort: share a cell rather than go unplaced. A doorway is still out.
  if (!pool.length) {
    pool = ground.cells.filter((c) => !ground.doorCells.some((d) => d.x === c.x && d.y === c.y));
    position = "throughout";
  }
  if (!pool.length) return undefined;

  const cell = rng.pick(pool);
  taken.add(cellKey(cell));
  return { cells: [cell], position };
}
