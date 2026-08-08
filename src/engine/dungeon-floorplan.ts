/**
 * FLOORPLAN — the dungeon as a drawing rather than a graph.
 *
 * Phase A gives force-relaxed points. This turns them into a real plan: every
 * room a footprint of grid cells, every connector a door in a wall two rooms
 * actually share. One cell is five feet.
 *
 * THE PLANE IS FLAT AND NOTHING OVERLAPS. Stairs, shafts and ramps are flavour
 * inside the room that names them; nothing in the model has a z. That makes the
 * plan a planar drawing of the Phase A graph, which is why Phase A now rejects
 * graphs that have no such drawing (`dungeon-planarity.ts`). Success here is a
 * *contact representation*: rooms are disjoint regions and a connection is a
 * shared wall, so a plan that draws at all cannot contain a crossing.
 *
 * CONNECTED ROOMS SHARE AN EXACT WALL — no rock between them, no gap. The wall
 * is a stroke on the shared boundary and the door is a break in it. Only
 * connected pairs must abut: the graph averages 2.4 edges per room, so rock
 * remains everywhere the graph is silent. This is not a honeycomb. Two rooms
 * that end up neighbours without an edge get a solid wall and no door, which is
 * also correct.
 *
 * CORRIDORS CARRY ALL OF THE SLACK. A corridor is a room whose identity is a
 * passage (`RoomStock.isCorridor`), and it is the only thing in the layout
 * allowed to stretch: it takes whatever shape the connection needed, so when
 * two chambers cannot be brought face to face the corridor between them bends
 * instead of the placement failing. That is what makes the packer tractable,
 * and it is why corridors are placed second, once the chambers are down:
 *
 *   1. chambers  — rectangles, depth-first with backtracking
 *   2. corridors — regions of free cells grown to touch every neighbour
 *   3. doors     — one per connector, in the wall its two rooms share
 *
 * Corridors are never adjacent to each other (stocking guarantees it), so every
 * corridor's neighbours are chambers, all of them placed before step 2 begins.
 *
 * Pure, seeded, no React. A failed layout returns null and the caller advances
 * the layout seed — the same escape hatch Phase A uses, and cheap for the same
 * reason.
 *
 * ON THE CELL TYPE. Cells are packed integers rather than `"x,y"` strings.
 * Placement tries tens of thousands of positions and the string version spent
 * most of its time allocating and re-parsing keys; the packed form is the
 * difference between a plan in milliseconds and one in minutes. Coordinates are
 * exposed as `Point`s at the boundary and the packing never escapes this file.
 */

import { Rng } from "./dungeon-blueprint.ts";
import type { Dungeon } from "./dungeon-phase-a.ts";
import type { RoomStock, StockedDungeon } from "./dungeon-rooms-loop.ts";

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type RoomForm = "rect" | "long" | "round" | "irregular" | "composite";
export type SizeClass = "tiny" | "small" | "medium" | "large" | "vast";
export type DoorKind = "plain" | "gated" | "concealed";
export type Orientation = "horizontal" | "vertical";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorplanRoom {
  roomId: string;
  /** graph index, so the plan joins back to the graph and the stock */
  index: number;
  isCorridor: boolean;
  form: RoomForm;
  /** chambers only — a corridor is whatever shape the connection needed */
  sizeClass?: SizeClass;
  /** the footprint, one point per five-foot cell */
  cells: Point[];
  bounds: Rect;
  /** the outline, clockwise, with collinear points collapsed */
  outline: Point[];
}

export interface FloorplanDoor {
  connectorId: string;
  /** room ids, not graph indices */
  from: string;
  to: string;
  kind: DoorKind;
  /**
   * A unit segment of wall: from (x, y) to (x+1, y) when horizontal, and to
   * (x, y+1) when vertical.
   */
  x: number;
  y: number;
  orientation: Orientation;
}

export interface Floorplan {
  seed: number;
  rooms: FloorplanRoom[];
  doors: FloorplanDoor[];
  bounds: Rect;
  /** how many layout seeds were spent getting here */
  attempts: number;
}

export interface FloorplanOptions {
  seed: number;
  /**
   * Floor a room needs for what the entities pass already minted in it, keyed
   * by room id. A soft floor: it raises the size class, it never shrinks one.
   */
  minCells?: Record<string, number>;
  /** layout seeds to try before giving up */
  attempts?: number;
}

// ---------------------------------------------------------------------------
// FOOTPRINT TABLES
// ---------------------------------------------------------------------------

/** class -> [min area, max area]. Bands, not dimension pairs, so `long` has somewhere to go. */
const AREA: Record<SizeClass, [number, number]> = {
  tiny: [4, 9],
  small: [12, 36],
  medium: [42, 81],
  large: [90, 144],
  vast: [156, 225],
};

const CLASSES: SizeClass[] = ["tiny", "small", "medium", "large", "vast"];
const classRank = (c: SizeClass) => CLASSES.indexOf(c) + 1;

/** form -> [min aspect, max aspect], long side over short. */
const ASPECT: Record<RoomForm, [number, number]> = {
  rect: [1, 1.5],
  long: [2, 4],
  round: [1, 1],
  irregular: [1, 1.5],
  composite: [1, 2],
};

interface Archetype {
  form?: RoomForm;
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
const ARCHETYPES: Record<string, Archetype> = {
  // long and narrow
  "Banquet hall": { form: "long" },
  Ballroom: { form: "long" },
  Gallery: { form: "long" },
  Barracks: { form: "long" },
  Dormitory: { form: "long" },
  Stables: { form: "long" },
  Kennel: { form: "long" },
  Catacombs: { form: "long" },
  Sewers: { form: "long" },

  // round
  Well: { form: "round", sizeClass: "tiny" },
  Fountain: { form: "round" },
  Pool: { form: "round" },
  "Fighting pit": { form: "round" },
  Oubliette: { form: "round" },
  Observatory: { form: "round" },

  // irregular — irregular in SHAPE. `Attic`, `Garret`, `Root cellar` and
  // `Junk room` were considered and rejected: they are irregular only in their
  // contents.
  Cavern: { form: "irregular" },
  Chasm: { form: "irregular" },
  "Mine shaft": { form: "irregular" },

  // axial with an end feature
  Chapel: { form: "composite" },
  Shrine: { form: "composite" },
  Temple: { form: "composite", minClass: "medium" },
  "Throne room": { form: "composite", minClass: "medium" },
  Courthouse: { form: "composite" },
  "Opera house": { form: "composite", minClass: "large" },

  // large and open
  Courtyard: { minClass: "large" },
  Garden: { minClass: "large" },
  Marketplace: { minClass: "large" },
  Park: { minClass: "large" },
  Theater: { minClass: "large" },
  Warehouse: { minClass: "large" },

  // tiny
  Privy: { sizeClass: "tiny" },
  Cabinet: { sizeClass: "tiny" },
  Cloakroom: { sizeClass: "tiny" },
  Wardrobe: { sizeClass: "tiny" },
  Pantry: { sizeClass: "tiny" },
  Larder: { sizeClass: "tiny" },
};

export { ARCHETYPES, AREA, ASPECT, CLASSES };

// ---------------------------------------------------------------------------
// GRID
// ---------------------------------------------------------------------------

type Cell = number;

const SPAN = 4096;
const BIAS = 2048;
const cell = (x: number, y: number): Cell => (x + BIAS) * SPAN + (y + BIAS);
const cellX = (c: Cell) => Math.floor(c / SPAN) - BIAS;
const cellY = (c: Cell) => (c % SPAN) - BIAS;
const asPoint = (c: Cell): Point => ({ x: cellX(c), y: cellY(c) });

/** East, west, south, north. */
const STEP: Cell[] = [SPAN, -SPAN, 1, -1];

function rectCells(r: Rect): Cell[] {
  const out: Cell[] = [];
  for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) out.push(cell(x, y));
  return out;
}

function boundsOf(cells: Iterable<Cell>): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cells) {
    const x = cellX(c), y = cellY(c);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Walk the boundary of a cell set into a clockwise outline. Each cell edge with
 * nothing on the far side is one segment; segments are stitched head to tail
 * and collinear runs collapsed, since a plan of rectangles is mostly long
 * straight walls.
 */
function outlineOf(cells: Iterable<Cell>): Point[] {
  const set = new Set(cells);
  const next = new Map<number, number>();
  const corner = (x: number, y: number) => (x + BIAS) * SPAN + (y + BIAS);

  for (const c of set) {
    const x = cellX(c), y = cellY(c);
    // Clockwise in screen coordinates, where y grows downward.
    if (!set.has(cell(x, y - 1))) next.set(corner(x, y), corner(x + 1, y));
    if (!set.has(cell(x + 1, y))) next.set(corner(x + 1, y), corner(x + 1, y + 1));
    if (!set.has(cell(x, y + 1))) next.set(corner(x + 1, y + 1), corner(x, y + 1));
    if (!set.has(cell(x - 1, y))) next.set(corner(x, y + 1), corner(x, y));
  }
  if (next.size === 0) return [];

  // The topmost-then-leftmost corner is always on the outer boundary.
  let start = -1;
  let bestX = Infinity, bestY = Infinity;
  for (const k of next.keys()) {
    const x = cellX(k), y = cellY(k);
    if (y < bestY || (y === bestY && x < bestX)) {
      bestX = x;
      bestY = y;
      start = k;
    }
  }

  const loop: Point[] = [];
  let cur = start;
  for (let guard = 0; guard <= next.size; guard++) {
    loop.push(asPoint(cur));
    const n = next.get(cur);
    if (n === undefined || n === start) break;
    cur = n;
  }

  const out: Point[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length];
    const b = loop[i];
    const c = loop[(i + 1) % loop.length];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue;
    out.push(b);
  }
  return out.length ? out : loop;
}

/** Exported for the map and for tests; takes and returns plain points. */
export function traceOutline(cells: Iterable<Point>): Point[] {
  return outlineOf([...cells].map((p) => cell(p.x, p.y)));
}

// ---------------------------------------------------------------------------
// FOOTPRINT CHOICE
// ---------------------------------------------------------------------------

/** Every (w, h) whose area sits in the class's band and whose aspect suits the form. */
function dimensionsFor(cls: SizeClass, form: RoomForm): Rect[] {
  const [lo, hi] = AREA[cls];
  const [aLo, aHi] = ASPECT[form];
  const out: Rect[] = [];
  for (let w = 2; w <= 24; w++) {
    for (let h = 2; h <= w; h++) {
      const area = w * h;
      if (area < lo || area > hi) continue;
      const aspect = w / h;
      if (aspect < aLo - 1e-9 || aspect > aHi + 1e-9) continue;
      out.push({ x: 0, y: 0, w, h });
      if (w !== h) out.push({ x: 0, y: 0, w: h, h: w });
    }
  }
  return out;
}

interface Dim {
  w: number;
  h: number;
  rank: number;
  /** how far this is from what the room rolled; added to the placement score */
  penalty: number;
}

interface Footprint {
  /** what the room rolled — a preference, not a pin */
  form: RoomForm;
  sizeClass: SizeClass;
  dims: Dim[];
}

/**
 * Pick a room's form and size class.
 *
 * Two hard floors sit under the roll. `class >= degree - 1`, because what a
 * high-degree room actually needs is placement freedom — neighbours arranged on
 * several sides at once — and that is what size buys; one comparison instead of
 * a perimeter calculation. And enough floor for what the entities pass has
 * already put in the room.
 *
 * The *form* only governs aspect here. Its shape — a bitten corner, an apse —
 * is carved after placement, because a notch taken before it would be free to
 * remove the very cell that was carrying a shared wall.
 */
function footprintFor(room: RoomStock, minCells: number, rng: Rng): Footprint {
  const arch = ARCHETYPES[room.identity] ?? {};

  const form: RoomForm =
    arch.form ??
    rng.pick<RoomForm>(["rect", "rect", "rect", "long", "long", "round", "irregular", "composite"]);

  const forEntities = CLASSES.findIndex((c) => AREA[c][1] >= minCells) + 1;
  const floor = Math.max(
    arch.minClass ? classRank(arch.minClass) : 1,
    room.degree - 1,
    forEntities || 1
  );
  const pinned = arch.sizeClass ? classRank(arch.sizeClass) : 0;
  const rank = Math.min(5, Math.max(floor, pinned || rng.pick([2, 2, 3, 3, 3, 4, 4, 5])));
  const sizeClass = CLASSES[rank - 1];

  // The roll is a preference and the packer is allowed to miss it. It has to
  // be: a room pinned by neighbours on opposite sides has its width dictated
  // outright, and one band of one form very rarely contains that exact number.
  // Offering every class at or above the floor, and the plain aspects as well
  // as the rolled one, is the difference between a plan that draws and one
  // that does not — so the class ends up *describing* the rectangle that fit
  // rather than dictating it, while `class >= degree - 1` still holds by
  // construction because nothing below the floor is ever offered.
  const best = new Map<string, Dim>();
  for (let r = floor; r <= 5; r++) {
    for (const f of [form, "rect", "long"] as RoomForm[]) {
      const penalty = 2 * Math.abs(r - rank) + (f === form ? 0 : 3);
      for (const d of dimensionsFor(CLASSES[r - 1], f)) {
        const k = `${d.w}x${d.h}`;
        const prev = best.get(k);
        if (!prev || prev.penalty > penalty) best.set(k, { w: d.w, h: d.h, rank: r, penalty });
      }
    }
  }

  const dims = [...best.values()].sort((a, b) => a.penalty - b.penalty);
  return { form, sizeClass, dims: dims.length ? dims : [{ w: 3, h: 3, rank: 1, penalty: 0 }] };
}

/**
 * Cut the room's form into an already-placed rectangle.
 *
 * Both operations are constrained to keep the bounding box — which is what the
 * area band is measured on — and to leave every cell that carries a shared
 * wall. A room's shape is decoration; its contacts are the plan.
 */
function carveForm(cells: Cell[], form: RoomForm, box: Rect, grid: Grid, rng: Rng): Cell[] {
  if (form !== "irregular" && form !== "composite") return cells;
  if (box.w < 5 || box.h < 5) return cells;

  const set = new Set(cells);
  const load = (c: Cell) => STEP.some((s) => grid.has(c + s) && !set.has(c + s));

  const drop = (c: Cell) => {
    if (!set.has(c) || load(c)) return;
    set.delete(c);
  };

  if (form === "irregular") {
    // A bite out of one or two corners. Kept under a third of each side so the
    // bounding box survives and the room still reads as one space.
    const corners: Point[] = [
      { x: box.x, y: box.y },
      { x: box.x + box.w - 1, y: box.y },
      { x: box.x, y: box.y + box.h - 1 },
      { x: box.x + box.w - 1, y: box.y + box.h - 1 },
    ];
    for (const c of rng.pickN(corners, rng.range(1, 2))) {
      const bw = rng.range(1, Math.max(1, Math.floor(box.w / 3)));
      const bh = rng.range(1, Math.max(1, Math.floor(box.h / 3)));
      const sx = c.x === box.x ? 1 : -1;
      const sy = c.y === box.y ? 1 : -1;
      for (let i = 0; i < bw; i++) {
        for (let j = 0; j < bh; j++) drop(cell(c.x + sx * i, c.y + sy * j));
      }
    }
  } else {
    // Axial with an end feature: the far third narrows to a sanctuary, so the
    // room reads as a nave pointing at something.
    const along = box.w >= box.h;
    const inset = 1;
    const depth = Math.max(1, Math.floor((along ? box.w : box.h) / 3));
    const far = rng.coin();
    for (let d = 0; d < depth; d++) {
      const at = along
        ? far
          ? box.x + box.w - 1 - d
          : box.x + d
        : far
          ? box.y + box.h - 1 - d
          : box.y + d;
      for (let k = 0; k < inset; k++) {
        if (along) {
          drop(cell(at, box.y + k));
          drop(cell(at, box.y + box.h - 1 - k));
        } else {
          drop(cell(box.x + k, at));
          drop(cell(box.x + box.w - 1 - k, at));
        }
      }
    }
  }

  const kept = [...set];
  return connected(kept) && kept.length >= 4 ? kept : cells;
}

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------

type Grid = Set<Cell>;

interface Placement {
  index: number;
  cells: Cell[];
  set: Set<Cell>;
  form: RoomForm;
  sizeClass: SizeClass;
  bounds: Rect;
  centre: Point;
}

function place(index: number, box: Rect, fp: Footprint, rank: number): Placement {
  const cells = rectCells(box);
  return {
    index,
    cells,
    set: new Set(cells),
    form: fp.form,
    // The class the room ended up with, which is the one the band is measured
    // against. It is never below the floor `footprintFor` set.
    sizeClass: CLASSES[rank - 1],
    bounds: box,
    centre: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
  };
}

const boxFits = (grid: Grid, box: Rect): boolean => {
  for (let x = box.x; x < box.x + box.w; x++) {
    for (let y = box.y; y < box.y + box.h; y++) if (grid.has(cell(x, y))) return false;
  }
  return true;
};

const overlap1D = (a: number, al: number, b: number, bl: number) => a < b + bl && b < a + al;

/** Share of a room's wall with rock or open space on the far side. */
function openness(box: Rect, grid: Grid): number {
  let wall = 0;
  let free = 0;
  const test = (x: number, y: number) => {
    wall++;
    if (!grid.has(cell(x, y))) free++;
  };
  for (let x = box.x; x < box.x + box.w; x++) {
    test(x, box.y - 1);
    test(x, box.y + box.h);
  }
  for (let y = box.y; y < box.y + box.h; y++) {
    test(box.x - 1, y);
    test(box.x + box.w, y);
  }
  return wall === 0 ? 0 : free / wall;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function centroid(ps: Placement[]): Point {
  if (!ps.length) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of ps) {
    x += p.centre.x;
    y += p.centre.y;
  }
  return { x: x / ps.length, y: y / ps.length };
}

/** Which side of the room a placed neighbour sits on. */
type Side = "west" | "east" | "north" | "south";
const SIDES: Side[] = ["west", "east", "north", "south"];

/** Every way of putting k neighbours on k distinct sides. */
function arrangements(k: number): Side[][] {
  if (k === 0) return [[]];
  const out: Side[][] = [];
  const walk = (acc: Side[], left: Side[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = 0; i < left.length; i++) {
      acc.push(left[i]);
      walk(acc, [...left.slice(0, i), ...left.slice(i + 1)]);
      acc.pop();
    }
  };
  walk([], SIDES);
  return out;
}
const ARRANGEMENTS = [0, 1, 2, 3, 4].map(arrangements);

const MAX_CANDIDATES = 10;
/** how many positions get the more expensive second look */
const SHORTLIST = 40;
/** free-axis positions sampled per (arrangement, dimension) pair */
const SLIDES = 5;

/**
 * Positions worth trying for one room, best first.
 *
 * This does **not** slide a fixed rectangle around looking for a fit — that was
 * the first version of the packer and it could not close a cycle. Six rooms
 * arranged in a ring have to meet up at the end, and a greedy walk around the
 * ring leaves the last room needing to touch two neighbours that are by then
 * far apart, which no amount of backtracking finds cheaply.
 *
 * Instead the rectangle is **derived from its neighbours**. Assign each placed
 * neighbour to a side and the geometry is almost fully determined: a neighbour
 * to the west pins the room's left edge, one to the east pins its right, and a
 * room with both has its width dictated outright. Whatever is left free — the
 * slide along the shared wall, the missing dimension — is the only thing
 * actually searched, and it is a handful of values rather than a plane.
 *
 * A room with no placed neighbours is a group reached only through corridors.
 * That one is set down beside something already placed, with a gap of one to
 * three cells so there is rock for the corridor to run through.
 */
function* candidates(
  index: number,
  fp: Footprint,
  hard: Placement[],
  pull: Point,
  placed: Placement[],
  grid: Grid,
  rng: Rng
): Generator<Placement> {
  const scored: Array<{ box: Rect; rank: number; near: number }> = [];
  const add = (box: Rect, d: Dim) => {
    if (!boxFits(grid, box)) return;
    scored.push({
      box,
      rank: d.rank,
      near: dist({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, pull) + d.penalty,
    });
  };

  if (hard.length === 0) {
    const dims = fp.dims.slice(0, 12);
    if (placed.length === 0) {
      for (const d of dims) add({ x: 0, y: 0, w: d.w, h: d.h }, d);
    } else {
      const near = [...placed]
        .sort((p, q) => dist(p.centre, pull) - dist(q.centre, pull))
        .slice(0, 3);
      for (const d of dims) {
        for (const host of near) {
          const hb = host.bounds;
          for (const gap of [1, 2, 3]) {
            for (let y = hb.y - d.h; y <= hb.y + hb.h; y += 2) {
              add({ x: hb.x - d.w - gap, y, w: d.w, h: d.h }, d);
              add({ x: hb.x + hb.w + gap, y, w: d.w, h: d.h }, d);
            }
            for (let x = hb.x - d.w; x <= hb.x + hb.w; x += 2) {
              add({ x, y: hb.y - d.h - gap, w: d.w, h: d.h }, d);
              add({ x, y: hb.y + hb.h + gap, w: d.w, h: d.h }, d);
            }
          }
        }
      }
    }
  } else {
    for (const sides of ARRANGEMENTS[hard.length]) {
      const west: Rect[] = [], east: Rect[] = [], north: Rect[] = [], south: Rect[] = [];
      hard.forEach((n, i) => {
        const b = n.bounds;
        if (sides[i] === "west") west.push(b);
        else if (sides[i] === "east") east.push(b);
        else if (sides[i] === "north") north.push(b);
        else south.push(b);
      });

      // A neighbour to the west pins the left edge; one to the east pins the
      // right. With both, the width is dictated and only the dimensions that
      // match it are worth trying.
      const xLo = west.length ? west[0].x + west[0].w : null;
      const xHi = east.length ? east[0].x : null;
      const yLo = north.length ? north[0].y + north[0].h : null;
      const yHi = south.length ? south[0].y : null;

      const vertical = [...west, ...east];
      const horizontal = [...north, ...south];

      for (const d of fp.dims) {
        const xs = span(xLo, xHi, d.w, horizontal, "x", rng);
        if (!xs) continue;
        const ys = span(yLo, yHi, d.h, vertical, "y", rng);
        if (!ys) continue;

        for (const x of xs) {
          for (const y of ys) {
            // The side assignment fixed one axis of each contact; this is the
            // other one — the overlap along the wall the two rooms share.
            if (!vertical.every((n) => overlap1D(y, d.h, n.y, n.h))) continue;
            if (!horizontal.every((n) => overlap1D(x, d.w, n.x, n.w))) continue;
            add({ x, y, w: d.w, h: d.h }, d);
          }
        }
      }
    }
  }

  // Two passes, because the second test is the expensive one. Nearest first;
  // then among those prefer the ones leaving the most wall free. A room wedged
  // into a pocket satisfies its own edges and strands the neighbours it has not
  // met yet, which is what sends the search into backtracking.
  scored.sort((a, b) => a.near - b.near);
  const shortlist = scored
    .slice(0, SHORTLIST)
    .map((s) => ({ ...s, score: s.near - 6 * openness(s.box, grid) }));
  shortlist.sort((a, b) => a.score - b.score);

  for (const s of shortlist.slice(0, MAX_CANDIDATES)) yield place(index, s.box, fp, s.rank);
}

/**
 * The positions one axis may take: fixed at both ends, fixed at one, or free
 * within whatever range keeps the room overlapping the neighbours on the
 * perpendicular sides. Null means this dimension cannot satisfy the pinning.
 */
function span(
  lo: number | null,
  hi: number | null,
  size: number,
  across: Rect[],
  axis: "x" | "y",
  rng: Rng
): number[] | null {
  if (lo !== null && hi !== null) return hi - lo === size ? [lo] : null;
  if (lo !== null) return [lo];
  if (hi !== null) return [hi - size];
  if (across.length === 0) return null;

  const len = axis === "x" ? ("w" as const) : ("h" as const);
  let from = -Infinity;
  let to = Infinity;
  for (const n of across) {
    from = Math.max(from, n[axis] - size + 1);
    to = Math.min(to, n[axis] + n[len] - 1);
  }
  if (from > to) return null;

  const out = [from, to, (from + to) >> 1];
  for (let i = 0; i < SLIDES && from < to; i++) out.push(rng.range(from, to));
  return [...new Set(out)];
}

/**
 * Place the chambers: depth-first over a BFS ordering, trying a handful of
 * scored positions per room and backtracking when one will not fit.
 *
 * The budget counts positions tried rather than rooms reached, because a seed
 * that is going to thrash does it inside one level. Giving up early and letting
 * the caller advance the layout seed is far cheaper than exhausting the tree.
 */
function placeChambers(
  order: number[],
  hard: Map<number, number[]>,
  soft: Map<number, number[]>,
  footprints: Map<number, Footprint>,
  budget: { left: number },
  rng: Rng
): Map<number, Placement> | null {
  const placed = new Map<number, Placement>();
  const grid: Grid = new Set();

  const step = (i: number): boolean => {
    if (i === order.length) return true;
    if (budget.left <= 0) return false;

    const index = order[i];
    const here = [...placed.values()];
    const hardPlaced = (hard.get(index) ?? [])
      .map((n) => placed.get(n))
      .filter((p): p is Placement => !!p);
    const softPlaced = (soft.get(index) ?? [])
      .map((n) => placed.get(n))
      .filter((p): p is Placement => !!p);
    const pull = centroid(softPlaced.length ? softPlaced : here);

    const fp = footprints.get(index)!;
    for (const cand of candidates(index, fp, hardPlaced, pull, here, grid, rng)) {
      if (budget.left-- <= 0) return false;
      placed.set(index, cand);
      for (const c of cand.cells) grid.add(c);
      if (step(i + 1)) return true;
      placed.delete(index);
      for (const c of cand.cells) grid.delete(c);
    }
    return false;
  };

  return step(0) ? placed : null;
}

/**
 * Grow a corridor: a connected region of free cells touching every one of its
 * neighbours. Reach the first neighbour, walk to each of the rest through free
 * space, then thicken if the room needs the floor.
 */
function growCorridor(
  neighbours: Array<Set<Cell>>,
  grid: Grid,
  want: number,
  arena: Rect,
  rng: Rng
): Cell[] | null {
  if (neighbours.length === 0) return null;

  // Free space is unbounded, so every search here is fenced into the arena —
  // the drawn plan plus a margin. Without it a corridor that cannot reach its
  // last neighbour walks off across an infinite plane instead of failing.
  const inside = (c: Cell) => {
    const x = cellX(c), y = cellY(c);
    return x >= arena.x && y >= arena.y && x < arena.x + arena.w && y < arena.y + arena.h;
  };

  const rim = (room: Set<Cell>): Cell[] => {
    const out = new Set<Cell>();
    for (const c of room) {
      for (const s of STEP) {
        const n = c + s;
        if (!grid.has(n) && inside(n)) out.add(n);
      }
    }
    return [...out];
  };

  const terminals = neighbours.map(rim);
  if (terminals.some((t) => t.length === 0)) return null;

  for (const seed of rng.pickN(terminals[0], Math.min(6, terminals[0].length))) {
    const region = new Set<Cell>([seed]);
    let ok = true;

    for (let i = 1; i < terminals.length && ok; i++) {
      const goal = new Set(terminals[i]);
      if ([...region].some((c) => goal.has(c))) continue;
      const path = walkFree(region, goal, grid, inside);
      if (!path) ok = false;
      else for (const c of path) region.add(c);
    }
    if (!ok) continue;

    // Thicken until the corridor has the floor it needs. Growing outward from
    // what is already there is what produces the L, cross and blob shapes: the
    // shape is whatever the connection required.
    let guard = 0;
    while (region.size < want && guard++ < 200) {
      const edge: Cell[] = [];
      for (const c of region) {
        for (const s of STEP) {
          const n = c + s;
          if (!grid.has(n) && !region.has(n) && inside(n)) edge.push(n);
        }
      }
      if (!edge.length) break;
      region.add(rng.pick(edge));
    }

    return [...region];
  }
  return null;
}

/** Shortest run of free cells from anywhere in `from` to anywhere in `goal`. */
function walkFree(
  from: Set<Cell>,
  goal: Set<Cell>,
  grid: Grid,
  inside: (c: Cell) => boolean
): Cell[] | null {
  const prev = new Map<Cell, Cell>();
  const queue = [...from];
  for (const c of queue) prev.set(c, -1);

  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    for (const s of STEP) {
      const n = cur + s;
      if (prev.has(n) || grid.has(n) || !inside(n)) continue;
      prev.set(n, cur);
      if (goal.has(n)) {
        const path: Cell[] = [];
        for (let w = n; w !== -1; w = prev.get(w)!) path.push(w);
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Draw the dungeon. Returns null when this seed produced no legal plan; the
 * caller advances the seed, exactly as Phase A does with an invalid graph.
 */
export function generateFloorplan(
  graph: Dungeon,
  sd: StockedDungeon,
  opts: { seed: number; minCells?: Record<string, number> }
): Floorplan | null {
  const rng = new Rng(opts.seed);
  const minCells = opts.minCells ?? {};

  const stockByIndex = new Map(sd.rooms.map((r) => [r.index, r]));
  const adj: number[][] = graph.rooms.map(() => []);
  for (const e of graph.edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }

  const isCorridor = (i: number) => stockByIndex.get(i)?.isCorridor === true;
  const all = graph.rooms.map((_r, i) => i);
  const chambers = all.filter((i) => !isCorridor(i));

  // Hard neighbours abut. Soft ones are the chambers on the far side of a
  // corridor: they only need to end up near enough for the corridor to reach.
  const hard = new Map<number, number[]>();
  const soft = new Map<number, number[]>();
  for (const i of chambers) {
    hard.set(i, adj[i].filter((n) => !isCorridor(n)));
    const through = new Set<number>();
    for (const n of adj[i]) {
      if (!isCorridor(n)) continue;
      for (const m of adj[n]) if (m !== i && !isCorridor(m)) through.add(m);
    }
    soft.set(i, [...through]);
  }

  // Maximum-cardinality order: always place the room with the most already-
  // placed neighbours, breaking ties on degree.
  //
  // This is the single biggest thing that makes the packer work, and a plain
  // breadth-first walk from the entrance is what it replaces. Every chunk
  // interior is a cycle, and a cycle has to *meet up* — walked greedily around
  // the ring, the last room arrives needing to touch two neighbours that are by
  // then far apart with six rooms in between. Placing the most-constrained room
  // next closes each ring while it is still small and there is nothing in the
  // way, and leaves the spurs and dead ends — which constrain nothing — for
  // last.
  const order: number[] = [];
  const done = new Set<number>();
  const placedNeighbours = new Map<number, number>(chambers.map((i) => [i, 0]));
  while (order.length < chambers.length) {
    let best = -1;
    let bestScore = -1;
    for (const i of chambers) {
      if (done.has(i)) continue;
      const score = (placedNeighbours.get(i) ?? 0) * 100 + adj[i].length;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    done.add(best);
    order.push(best);
    for (const n of hard.get(best) ?? []) {
      placedNeighbours.set(n, (placedNeighbours.get(n) ?? 0) + 1);
    }
  }

  const footprints = new Map<number, Footprint>();
  for (const i of chambers) {
    const stock = stockByIndex.get(i)!;
    footprints.set(i, footprintFor(stock, minCells[stock.roomId] ?? 0, rng));
  }

  const placed = placeChambers(order, hard, soft, footprints, { left: 1_500 }, rng);
  if (!placed) return null;

  const grid: Grid = new Set();
  for (const p of placed.values()) for (const c of p.cells) grid.add(c);

  // Shape comes after placement, never before: a notch cut ahead of time is
  // free to remove the cell that was carrying a shared wall.
  for (const p of placed.values()) {
    const carved = carveForm(p.cells, p.form, p.bounds, grid, rng);
    if (carved.length === p.cells.length) continue;
    for (const c of p.cells) grid.delete(c);
    p.cells = carved;
    p.set = new Set(carved);
    for (const c of carved) grid.add(c);
  }

  // --- corridors ------------------------------------------------------------
  const drawn = boundsOf(grid);
  const MARGIN = 6;
  const arena: Rect = {
    x: drawn.x - MARGIN,
    y: drawn.y - MARGIN,
    w: drawn.w + MARGIN * 2,
    h: drawn.h + MARGIN * 2,
  };

  const corridors = new Map<number, Cell[]>();
  for (const i of all.filter(isCorridor)) {
    const stock = stockByIndex.get(i)!;
    const nb = adj[i].map((n) => placed.get(n)?.set).filter((s): s is Set<Cell> => !!s);
    if (nb.length !== adj[i].length) return null; // a corridor beside a corridor
    const want = Math.max(4, minCells[stock.roomId] ?? 0, rng.range(4, 12));
    const cells = growCorridor(nb, grid, want, arena, rng);
    if (!cells) return null;
    corridors.set(i, cells);
    for (const c of cells) grid.add(c);
  }

  // --- assemble -------------------------------------------------------------
  const cellsOf = new Map<string, Set<Cell>>();
  const rooms: FloorplanRoom[] = [];
  for (const stock of sd.rooms) {
    const p = placed.get(stock.index);
    const cells = p ? p.cells : corridors.get(stock.index)!;
    cellsOf.set(stock.roomId, new Set(cells));
    rooms.push({
      roomId: stock.roomId,
      index: stock.index,
      isCorridor: stock.isCorridor,
      form: p ? p.form : "irregular",
      ...(p ? { sizeClass: p.sizeClass } : {}),
      cells: cells.map(asPoint),
      bounds: boundsOf(cells),
      outline: outlineOf(cells),
    });
  }

  const doors: FloorplanDoor[] = [];
  for (const c of sd.connectors) {
    const a = cellsOf.get(c.a);
    const b = cellsOf.get(c.b);
    if (!a || !b) return null;
    const seams = sharedWall(a, b);
    if (!seams.length) return null;
    doors.push({
      connectorId: c.id,
      from: c.a,
      to: c.b,
      kind: c.hidden ? "concealed" : c.gated ? "gated" : "plain",
      ...seams[Math.floor(seams.length / 2)],
    });
  }

  return {
    seed: opts.seed,
    rooms,
    doors,
    bounds: boundsOf([...grid]),
    attempts: 1,
  };
}

/** Every unit segment of wall the two footprints have in common. */
function sharedWall(
  a: Set<Cell>,
  b: Set<Cell>
): Array<{ x: number; y: number; orientation: Orientation }> {
  const out: Array<{ x: number; y: number; orientation: Orientation }> = [];
  for (const c of a) {
    const x = cellX(c), y = cellY(c);
    if (b.has(cell(x + 1, y))) out.push({ x: x + 1, y, orientation: "vertical" });
    if (b.has(cell(x - 1, y))) out.push({ x, y, orientation: "vertical" });
    if (b.has(cell(x, y + 1))) out.push({ x, y: y + 1, orientation: "horizontal" });
    if (b.has(cell(x, y - 1))) out.push({ x, y, orientation: "horizontal" });
  }
  out.sort((p, q) => p.y - q.y || p.x - q.x || p.orientation.localeCompare(q.orientation));
  return out;
}

/**
 * Try layout seeds until one draws. The plan is persisted rather than
 * recomputed — 6c makes the prose refer to it — so the seed that worked is
 * recorded on the result.
 */
export function generateFloorplanValid(
  graph: Dungeon,
  sd: StockedDungeon,
  opts: FloorplanOptions
): Floorplan | null {
  const tries = opts.attempts ?? 24;
  for (let i = 0; i < tries; i++) {
    const fp = generateFloorplan(graph, sd, {
      seed: opts.seed + i * 7919,
      minCells: opts.minCells,
    });
    if (fp) return { ...fp, attempts: i + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

/**
 * The equivalent of `dungeon.valid`, and what makes topological accuracy a
 * guarantee rather than a hope. The map is planning information the referee has
 * to be able to agree with, so this is not optional.
 */
export function validateFloorplan(fp: Floorplan, graph: Dungeon, sd: StockedDungeon): string[] {
  const fails: string[] = [];
  const stockById = new Map(sd.rooms.map((r) => [r.roomId, r]));

  const owner = new Map<Cell, string>();
  const cellsOf = new Map<string, Set<Cell>>();

  for (const r of fp.rooms) {
    const cells = r.cells.map((p) => cell(p.x, p.y));
    cellsOf.set(r.roomId, new Set(cells));

    if (cells.length === 0) fails.push(`room ${r.roomId}: no floor`);
    for (const c of cells) {
      const prev = owner.get(c);
      if (prev !== undefined) fails.push(`room ${r.roomId}: overlaps ${prev}`);
      owner.set(c, r.roomId);
    }
    if (!connected(cells)) fails.push(`room ${r.roomId}: footprint is in pieces`);

    if (!r.isCorridor) {
      const stock = stockById.get(r.roomId);
      if (stock && classRank(r.sizeClass!) < stock.degree - 1) {
        fails.push(`room ${r.roomId}: class ${r.sizeClass} below degree ${stock.degree} - 1`);
      }
      const [lo, hi] = AREA[r.sizeClass!];
      const box = r.bounds.w * r.bounds.h;
      if (box < lo || box > hi) {
        fails.push(`room ${r.roomId}: ${box} cells outside the ${r.sizeClass} band ${lo}-${hi}`);
      }
    }
  }

  const doorCount = new Map<string, number>();
  const withDoors = new Set<string>();

  for (const d of fp.doors) {
    if (withDoors.has(d.connectorId)) fails.push(`connector ${d.connectorId}: two doors`);
    withDoors.add(d.connectorId);
    doorCount.set(d.from, (doorCount.get(d.from) ?? 0) + 1);
    doorCount.set(d.to, (doorCount.get(d.to) ?? 0) + 1);

    const a = cellsOf.get(d.from);
    const b = cellsOf.get(d.to);
    if (!a || !b) {
      fails.push(`connector ${d.connectorId}: names a room with no footprint`);
      continue;
    }
    const onWall = sharedWall(a, b).some(
      (s) => s.x === d.x && s.y === d.y && s.orientation === d.orientation
    );
    if (!onWall) fails.push(`connector ${d.connectorId}: door is not in a wall the rooms share`);
  }

  for (const c of sd.connectors) {
    if (!withDoors.has(c.id)) fails.push(`connector ${c.id}: no door`);
  }
  for (const stock of sd.rooms) {
    const n = doorCount.get(stock.roomId) ?? 0;
    if (n !== stock.degree) {
      fails.push(`room ${stock.roomId}: ${n} doors for degree ${stock.degree}`);
    }
  }

  const b = fp.bounds;
  for (const r of fp.rooms) {
    const out = r.cells.some(
      (p) => p.x < b.x || p.y < b.y || p.x >= b.x + b.w || p.y >= b.y + b.h
    );
    if (out) fails.push(`room ${r.roomId}: floor outside the bounds`);
  }

  if (fp.rooms.length !== graph.rooms.length) {
    fails.push(`${fp.rooms.length} rooms drawn for ${graph.rooms.length} in the graph`);
  }

  return fails;
}

function connected(cells: Cell[]): boolean {
  if (cells.length <= 1) return true;
  const set = new Set(cells);
  const seen = new Set<Cell>([cells[0]]);
  const queue = [cells[0]];
  for (let h = 0; h < queue.length; h++) {
    for (const s of STEP) {
      const n = queue[h] + s;
      if (set.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen.size === set.size;
}

// ---------------------------------------------------------------------------
// LINE ART
// ---------------------------------------------------------------------------

export interface SvgOptions {
  /** pixels per five-foot cell */
  scale?: number;
  padding?: number;
  /** label each room with its graph index */
  labels?: boolean;
}

/**
 * Plain line art, no decoration. This is the iteration surface — the whole
 * reason 6a is headless — and it is deliberately not the map component: nothing
 * here knows about fog, the player, or run state.
 */
export function floorplanSvg(fp: Floorplan, opts: SvgOptions = {}): string {
  const s = opts.scale ?? 12;
  const pad = opts.padding ?? 16;
  const b = fp.bounds;
  const W = b.w * s + pad * 2;
  const H = b.h * s + pad * 2;
  const px = (x: number) => (x - b.x) * s + pad;
  const py = (y: number) => (y - b.y) * s + pad;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#faf7f0"/>`,
  ];

  for (const room of fp.rooms) {
    const points = room.outline.map((p) => `${px(p.x)},${py(p.y)}`).join(" ");
    parts.push(
      `<polygon points="${points}" fill="${room.isCorridor ? "#e8e2d4" : "#ffffff"}" stroke="#231f1c" stroke-width="2" stroke-linejoin="round"/>`
    );
  }

  // Doors are breaks in the wall, so they are drawn over it in the background
  // colour, with a gated one barred and a concealed one dashed.
  for (const d of fp.doors) {
    const [x1, y1, x2, y2] =
      d.orientation === "horizontal"
        ? [px(d.x), py(d.y), px(d.x + 1), py(d.y)]
        : [px(d.x), py(d.y), px(d.x), py(d.y + 1)];
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#faf7f0" stroke-width="4"/>`);
    if (d.kind !== "plain") {
      const dash = d.kind === "concealed" ? ` stroke-dasharray="3 3"` : "";
      parts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#231f1c" stroke-width="2"${dash}/>`
      );
    }
  }

  if (opts.labels !== false) {
    for (const room of fp.rooms) {
      const cx = px(room.bounds.x + room.bounds.w / 2);
      const cy = py(room.bounds.y + room.bounds.h / 2);
      parts.push(
        `<text x="${cx}" y="${cy}" font-family="ui-monospace, monospace" font-size="${Math.max(8, s * 0.8)}" fill="#8a8178" text-anchor="middle" dominant-baseline="middle">${room.index}</text>`
      );
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
}
