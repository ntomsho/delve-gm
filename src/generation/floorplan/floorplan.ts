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
 * graphs that have no such drawing (`planarity.ts`). Success here is a
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
 *   1. chambers  — a family footprint each, depth-first with backtracking
 *   2. corridors — regions of free cells grown to touch every neighbour
 *   3. doors     — one per connector, in the wall its two rooms share
 *   4. relief    — niches and bays, decorating a plan that already holds
 *
 * Corridors are never adjacent to each other (stocking guarantees it), so every
 * corridor's neighbours are chambers, all of them placed before step 2 begins.
 *
 * RELIEF RUNS LAST, AFTER THE DOORS. Niches only remove cells, so they can never
 * cause an overlap; bays add cells outside the placed footprint, so they can —
 * but applied into cells already verified as empty rock they cannot fail. By
 * step 4 every loop is closed and every door is placed, so relief is decoration
 * on a plan that has already been proved. Its guard is three things and no more:
 * never remove a cell carrying a door, keep the footprint in one piece, and stop
 * before the floor area leaves its band. 6a's guard also refused any cell
 * abutting another room, which put the whole length of every shared wall off
 * limits and is why 70 of its 119 "irregular" rooms came out as rectangles.
 *
 * SHAPE IS FOUR AXES, NOT ONE LIST. `family` (rect/L/T/cross/round), `proportion`,
 * `relief` and a size band, varying independently — see `RoomShape`. 6a had a
 * single five-valued `form` doing all three jobs and drew 86% of chambers as
 * plain rectangles as a result.
 *
 * FAMILY IS CHOSEN INSIDE THE PACKER, and that is the point rather than a detail.
 * A rectangle's area is width times height, so a room pinned between two fixed
 * neighbours has its width dictated and its achievable areas quantised to
 * multiples of that width; one of those has to land in the band. A cross in the
 * same dictated box takes almost any area by varying arm thickness. The shaped
 * families decouple the bounding box from the floor area, which is exactly the
 * coupling that was strangling placement.
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

import { Rng } from "../../shared/utils/rng.ts";
import type { Dungeon } from "./graph.ts";
import type { RoomStock, StockedDungeon } from "../content/types.ts";
import {
  ARCHETYPES,
  AREA,
  CLASSES,
  classOf,
  classRank,
  type Family,
  type Proportion,
  type Relief,
  type RoomShape,
  type SizeClass,
} from "./room-size.ts";
import type { Point } from "../../shared/utils/grid.ts";

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type DoorKind = "plain" | "gated" | "concealed";
export type Orientation = "horizontal" | "vertical";

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
  /** chambers only — a corridor is whatever shape the connection needed */
  shape?: RoomShape;
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

/**
 * Why an attempt gave up. The packer declining is not the same as the packer
 * drawing something bad — everything it does hand back passes
 * `validateFloorplan` — so when the draw rate is low this is the only thing that
 * says which of the three quite different problems is actually biting.
 */
export type GiveUp =
  | "placement-budget"    // the search ran out of positions to try
  | "placement-stuck"     // the search exhausted the tree without spending the budget
  | "corridor-adjacent"   // a corridor next to a corridor, which stocking should prevent
  | "corridor-route"      // a corridor could not reach all its neighbours through the rock
  | "no-shared-wall";     // two connected rooms ended up not touching

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

/** proportion -> [min aspect, max aspect], long side over short. */
const ASPECT: Record<Proportion, [number, number]> = {
  square: [1, 1.25],
  moderate: [1.25, 2],
  long: [2, 4],
};

/**
 * The bounding box may not exceed this on a side. Relief 2 is allowed to push
 * past it, since a bay is by definition outside the placed footprint.
 */
const BOX_CAP = 24;

/** A round room needs a flat run of boundary per door, and an ellipse has four. */
const ROUND_MAX_DEGREE = 4;



export { ASPECT, BOX_CAP, ROUND_MAX_DEGREE };

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
// FAMILIES
// ---------------------------------------------------------------------------

const FAMILIES: Family[] = ["rect", "L", "T", "cross", "round"];
const PROPORTIONS: Proportion[] = ["square", "moderate", "long"];

/**
 * One way of drawing a family inside a given bounding box, plus the floor area
 * it comes to. The two parameters mean something different per family and
 * nothing outside `carve` reads them:
 *
 *   rect / round   unused — the box determines the footprint outright
 *   L              the corner rectangle bitten out, `a` wide by `b` tall
 *   T              bar thickness `a`, stem width `b`; `alt` turns it on its side
 *   cross          horizontal bar `a` thick, vertical bar `b` thick
 *
 * EVERY CONFIGURATION TOUCHES ALL FOUR SIDES OF THE BOX. That is not decoration:
 * placement pins a room's edges against its neighbours, so a footprint that
 * pulled back from a side would silently stop sharing a wall there and the
 * connector would have nowhere to put its door.
 */
interface Config {
  a: number;
  b: number;
  alt: boolean;
  area: number;
}

/**
 * Every configuration of a family in a `w` by `h` box, sorted by floor area.
 *
 * Memoised, and deliberately not parameterised by the wanted area: the same few
 * thousand (family, w, h) triples come up over and over across rooms, attempts
 * and seeds, and keeping the range out of the key is what makes the cache hit.
 * Callers binary-search the sorted areas instead — see `nearestArea`.
 */
const CONFIGS = new Map<string, Config[]>();

function familyConfigs(family: Family, w: number, h: number): Config[] {
  const key = `${family}:${w}:${h}`;
  const hit = CONFIGS.get(key);
  if (hit) return hit;

  const out: Config[] = [];
  if (family === "rect") {
    out.push({ a: 0, b: 0, alt: false, area: w * h });
  } else if (family === "round") {
    const area = ellipseCells({ x: 0, y: 0, w, h }).length;
    if (area >= 4) out.push({ a: 0, b: 0, alt: false, area });
  } else if (w >= 3 && h >= 3) {
    if (family === "L") {
      for (let cw = 1; cw < w; cw++) {
        for (let ch = 1; ch < h; ch++) out.push({ a: cw, b: ch, alt: false, area: w * h - cw * ch });
      }
    } else if (family === "T") {
      // A bar with a stem. The stem is kept off both ends so the room has two
      // shoulders — one shoulder is an L, and L is its own family.
      for (let t = 1; t <= h - 2; t++) {
        for (let sw = 1; sw <= w - 2; sw++) {
          out.push({ a: t, b: sw, alt: false, area: w * t + sw * (h - t) });
        }
      }
      for (let t = 1; t <= w - 2; t++) {
        for (let sw = 1; sw <= h - 2; sw++) {
          out.push({ a: t, b: sw, alt: true, area: h * t + sw * (w - t) });
        }
      }
    } else {
      // Two bars crossing, each kept clear of both edges so the arms are real.
      // The bars need not be centred and their thicknesses are independent,
      // which is where a medium cross's ~15,600 distinct silhouettes come from.
      for (let th = 1; th <= h - 2; th++) {
        for (let tw = 1; tw <= w - 2; tw++) {
          out.push({ a: th, b: tw, alt: false, area: w * th + h * tw - th * tw });
        }
      }
    }
  }

  out.sort((p, q) => p.area - q.area || p.a - q.a || p.b - q.b || Number(p.alt) - Number(q.alt));
  CONFIGS.set(key, out);
  return out;
}

/** An ellipse inscribed in the box. Square proportions give a circle, long an oval. */
function ellipseCells(box: Rect): Cell[] {
  const out: Cell[] = [];
  const rx = box.w / 2;
  const ry = box.h / 2;
  for (let i = 0; i < box.w; i++) {
    for (let j = 0; j < box.h; j++) {
      const dx = (i + 0.5 - rx) / rx;
      const dy = (j + 0.5 - ry) / ry;
      if (dx * dx + dy * dy <= 1 + 1e-9) out.push(cell(box.x + i, box.y + j));
    }
  }
  return out;
}

/** First index whose area is at or above `v`. */
function lowerBound(cfgs: Config[], v: number): number {
  let lo = 0;
  let hi = cfgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cfgs[mid].area < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The achievable area inside `[lo, hi]` that sits closest to the rolled band,
 * or null when the family cannot reach the range at all in this box. All binary
 * search: this runs a few thousand times per room and a linear scan of the
 * configuration list would dominate the packer.
 */
function nearestArea(cfgs: Config[], lo: number, hi: number, tLo: number, tHi: number): number | null {
  if (!cfgs.length) return null;
  const first = lowerBound(cfgs, lo);
  if (first >= cfgs.length || cfgs[first].area > hi) return null;

  // Anything inside the rolled band, clamped to what is allowed, is a free hit.
  const wantLo = Math.max(tLo, lo);
  const wantHi = Math.min(tHi, hi);
  if (wantLo <= wantHi) {
    const i = lowerBound(cfgs, wantLo);
    if (i < cfgs.length && cfgs[i].area <= wantHi) return cfgs[i].area;
  }

  // Otherwise the nearest on either side of it, still inside `[lo, hi]`.
  const at = lowerBound(cfgs, wantLo);
  const above = at < cfgs.length && cfgs[at].area <= hi ? cfgs[at].area : null;
  const below = at > 0 && cfgs[at - 1].area >= lo ? cfgs[at - 1].area : null;
  if (above === null) return below;
  if (below === null) return above;
  return Math.abs(above - wantLo) <= Math.abs(wantLo - below) ? above : below;
}

// ---------------------------------------------------------------------------
// THE SHAPE ROLL
// ---------------------------------------------------------------------------

/** A bounding box worth trying, and the family that will be drawn inside it. */
interface Dim {
  w: number;
  h: number;
  family: Family;
  /** how far this is from what the room rolled; added to the placement score */
  penalty: number;
}

/**
 * What a room rolled, what it is allowed to become, and the boxes that satisfy
 * both. Family, proportion and size are preferences the packer may miss; the
 * area interval and the degree floor are not.
 */
interface ShapeRoll {
  family: Family;
  proportion: Proportion;
  relief: Relief;
  /** the class the room wanted, before the packer had its say */
  sizeClass: SizeClass;
  /** the allowed floor-area interval — one interval, because the bands abut */
  areaLo: number;
  areaHi: number;
  /** the rolled class's own band, used to choose among configurations */
  targetLo: number;
  targetHi: number;
  boxes: Dim[];
  /**
   * `boxes` indexed by width and by height.
   *
   * Neighbours on opposite sides dictate a dimension outright, and then all but
   * a handful of the boxes are dead on arrival — `span` would return null for
   * every one of them. Scanning the whole list to discover that is what made the
   * first cut of this six times slower than 6a at size 3, because it happens
   * inside the arrangement loop, inside the backtracking search.
   */
  byW: Map<number, Dim[]>;
  byH: Map<number, Dim[]>;
  degree: number;
}

/** Boxes kept per room. Enough variety to place with; bounded so the packer stays quick. */
const MAX_BOXES = 300;

/**
 * Roll a room's four axes and work out which bounding boxes can serve them.
 *
 * FAMILY IS HARD, PROPORTION IS FIRM, SIZE IS SOFT. A well that is not round is
 * wrong; a banquet hall that is not long is wrong; a well one class larger than
 * it rolled is nobody's problem. 6a made all three equally rigid and the packer
 * had nowhere to give, which is most of why it could not draw sizes 4 and 5. So
 * the rolled family and proportion are merely cheapest here, and every other
 * combination stays available at a penalty.
 *
 * Two hard floors sit under the size roll. `class >= degree - 1`, because what a
 * high-degree room needs is placement freedom — neighbours arranged on several
 * sides at once — and that is what size buys. And enough floor for what the
 * entities pass has already put in the room. Both outrank an archetype's pin: a
 * Well with four ways out stops being tiny, because the structure is real and
 * the fiction is a preference.
 */
function shapeFor(room: RoomStock, minCells: number, rng: Rng): ShapeRoll {
  const arch = ARCHETYPES[room.identity] ?? {};

  const family: Family = arch.family
    ? rng.pick(arch.family)
    : rng.pick<Family>([
        "rect", "rect", "rect",
        "L", "L", "L",
        "T", "T",
        "cross", "cross",
        "round", "round",
      ]);

  const proportion: Proportion =
    arch.proportion ??
    rng.pick<Proportion>(["square", "square", "moderate", "moderate", "moderate", "long"]);

  // Relief 2 never rolls — it appears only where an archetype demands it.
  const rolledRelief = rng.pick<Relief>([0, 1, 1, 1]);
  const relief: Relief =
    arch.relief ?? (Math.min(arch.maxRelief ?? 2, rolledRelief) as Relief);

  const forEntities = CLASSES.findIndex((c) => AREA[c][1] >= minCells) + 1;
  const pinned = arch.sizeClass ? classRank(arch.sizeClass) : 0;
  const floorRank = Math.max(
    arch.minClass ? classRank(arch.minClass) : 1,
    room.degree - 1,
    forEntities || 1,
    pinned
  );
  const ceilRank = pinned ? Math.max(pinned, floorRank) : CLASSES.length;
  const rolledRank = Math.min(
    ceilRank,
    Math.max(floorRank, pinned || Math.min(CLASSES.length, rng.pick([2, 2, 3, 3, 3, 4, 4, 5])))
  );

  const areaLo = Math.max(AREA[CLASSES[floorRank - 1]][0], minCells);
  const areaHi = AREA[CLASSES[ceilRank - 1]][1];
  const [targetLo, targetHi] = AREA[CLASSES[rolledRank - 1]];

  // Preference order: the rolled value first, everything else behind it.
  const props = [proportion, ...PROPORTIONS.filter((p) => p !== proportion)];
  const fams = [family, ...FAMILIES.filter((f) => f !== family)];

  const boxes: Dim[] = [];
  for (let w = 2; w <= BOX_CAP; w++) {
    for (let h = 2; h <= BOX_CAP; h++) {
      const aspect = Math.max(w, h) / Math.min(w, h);
      const pi = props.findIndex(
        (p) => aspect >= ASPECT[p][0] - 1e-9 && aspect <= ASPECT[p][1] + 1e-9
      );
      if (pi < 0) continue;

      let best: Dim | null = null;
      for (let fi = 0; fi < fams.length; fi++) {
        const f = fams[fi];
        // The one place a rolled family is refused outright. An ellipse meets
        // its orthogonal neighbours along four short flat runs, and a door needs
        // one each; `class >= degree - 1` does not cover it, because that floor
        // buys area and a vast ellipse has no more flat runs than a small one.
        if (f === "round" && room.degree > ROUND_MAX_DEGREE) continue;
        const near = nearestArea(familyConfigs(f, w, h), areaLo, areaHi, targetLo, targetHi);
        if (near === null) continue;
        const penalty =
          3 * pi + (fi > 0 ? 3 : 0) + 2 * Math.abs(classRank(classOf(near)) - rolledRank);
        if (!best || best.penalty > penalty) best = { w, h, family: f, penalty };
      }
      if (best) boxes.push(best);
    }
  }

  boxes.sort((a, b) => a.penalty - b.penalty || a.w * a.h - b.w * b.h || a.w - b.w);

  const kept = boxes.length
    ? boxes.slice(0, MAX_BOXES)
    : [{ w: 3, h: 3, family: "rect" as Family, penalty: 0 }];

  const byW = new Map<number, Dim[]>();
  const byH = new Map<number, Dim[]>();
  for (const d of kept) {
    (byW.get(d.w) ?? byW.set(d.w, []).get(d.w)!).push(d);
    (byH.get(d.h) ?? byH.set(d.h, []).get(d.h)!).push(d);
  }

  return {
    family,
    proportion,
    relief,
    sizeClass: CLASSES[rolledRank - 1],
    areaLo,
    areaHi,
    targetLo,
    targetHi,
    boxes: kept,
    byW,
    byH,
    degree: room.degree,
  };
}

// ---------------------------------------------------------------------------
// DRAWING A FAMILY INTO A BOX
// ---------------------------------------------------------------------------

/** A closed run of rows or columns, box-relative. */
type Iv = [number, number];

/**
 * What the placement has already committed this room to reaching, box-relative
 * and split by side: the rows a western neighbour needs the west edge to cover,
 * and so on.
 */
interface Need {
  w: Iv[];
  e: Iv[];
  n: Iv[];
  s: Iv[];
}

/**
 * Offsets at which a run of `len` still meets every interval, within `[lo, hi]`.
 *
 * This is the whole reason the shaped families work inside the packer rather
 * than beside it. A cross drawn at a random offset misses the neighbour it was
 * placed against perhaps half the time, and every miss is a rejected candidate
 * and a backtrack; solving for the offset instead makes the contact a property
 * of the construction. Measured: this is the difference between 1,700ms and
 * 200ms an attempt at size 3.
 */
function solveOffset(ivs: Iv[], len: number, lo: number, hi: number): Iv | null {
  let from = lo;
  let to = hi;
  for (const [a, b] of ivs) {
    from = Math.max(from, a - len + 1);
    to = Math.min(to, b);
  }
  return from <= to ? [from, to] : null;
}

/** Does every interval reach into `[lo, hi]`? */
const allReach = (ivs: Iv[], lo: number, hi: number) => ivs.every((v) => v[0] <= hi && v[1] >= lo);

/**
 * Paint one configuration of a family into the box, positioned so the footprint
 * still touches everything placement pinned it against.
 *
 * Returns null when this configuration cannot meet the contacts at any offset,
 * which the caller reads as "try the next configuration".
 */
function carve(box: Rect, family: Family, cfg: Config, need: Need, rng: Rng): Cell[] | null {
  const { x, y, w, h } = box;
  const pick = (r: Iv) => rng.range(r[0], r[1]);

  if (family === "rect") return rectCells(box);
  if (family === "round") return ellipseCells(box);

  const out: Cell[] = [];

  if (family === "L") {
    // A bite out of one corner. The area is the same whichever corner it is, so
    // the choice is free — which means it can be spent on keeping the contacts.
    const corners: Array<[number, number]> = [
      [0, 0],
      [w - cfg.a, 0],
      [0, h - cfg.b],
      [w - cfg.a, h - cfg.b],
    ];
    // A bitten corner only threatens the two edges it sits on, and only if it
    // swallows a neighbour's whole run there.
    const survives = ([cx0, cy0]: [number, number]) => {
      const clearsRows = (ivs: Iv[]) => ivs.every((v) => v[0] < cy0 || v[1] > cy0 + cfg.b - 1);
      const clearsCols = (ivs: Iv[]) => ivs.every((v) => v[0] < cx0 || v[1] > cx0 + cfg.a - 1);
      if (cx0 === 0 && !clearsRows(need.w)) return false;
      if (cx0 + cfg.a === w && !clearsRows(need.e)) return false;
      if (cy0 === 0 && !clearsCols(need.n)) return false;
      if (cy0 + cfg.b === h && !clearsCols(need.s)) return false;
      return true;
    };
    const ok = rng.pickN(corners, corners.length).find(survives);
    if (!ok) return null;
    const [cx0, cy0] = ok;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const bitten = i >= cx0 && i < cx0 + cfg.a && j >= cy0 && j < cy0 + cfg.b;
        if (!bitten) out.push(cell(x + i, y + j));
      }
    }
    return out;
  }

  if (family === "T") {
    // A bar down one whole side and a stem out of the middle of it. The bar's
    // side is free and the stem's offset along it is free; both get spent on
    // the contacts. `alt` stands the whole thing on its side.
    const along = cfg.alt ? h : w;
    const across = cfg.alt ? w : h;
    // Along the bar, the far edge is reached by the stem alone; the two edges
    // the bar runs between are reached by the bar alone.
    const barSides = cfg.alt ? ([need.w, need.e] as const) : ([need.n, need.s] as const);
    const runSides = cfg.alt ? [...need.n, ...need.s] : [...need.w, ...need.e];

    for (const far of rng.coin() ? [false, true] : [true, false]) {
      // `far` puts the bar on the high edge, so the bar occupies the last
      // `cfg.a` of `across` and the stem reaches the low one.
      const barLo = far ? across - cfg.a : 0;
      if (!allReach(runSides, barLo, barLo + cfg.a - 1)) continue;
      const stemSide = far ? barSides[0] : barSides[1];
      const range = solveOffset(stemSide, cfg.b, 1, along - cfg.b - 1);
      if (!range) continue;

      const off = pick(range);
      for (let i = 0; i < along; i++) {
        for (let j = 0; j < across; j++) {
          const inBar = j >= barLo && j < barLo + cfg.a;
          const inStem = i >= off && i < off + cfg.b;
          if (!inBar && !inStem) continue;
          out.push(cfg.alt ? cell(x + j, y + i) : cell(x + i, y + j));
        }
      }
      return out;
    }
    return null;
  }

  // cross — a horizontal bar `a` thick and a vertical bar `b` thick, neither
  // necessarily centred. The west and east edges are reached by the horizontal
  // bar alone, the north and south by the vertical one, so each bar's offset is
  // solved against the sides it serves.
  const rows = solveOffset([...need.w, ...need.e], cfg.a, 1, h - cfg.a - 1);
  const cols = solveOffset([...need.n, ...need.s], cfg.b, 1, w - cfg.b - 1);
  if (!rows || !cols) return null;
  const ry = pick(rows);
  const rx = pick(cols);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      if ((j >= ry && j < ry + cfg.a) || (i >= rx && i < rx + cfg.b)) out.push(cell(x + i, y + j));
    }
  }
  return out;
}

/** Do these two footprints share at least one unit of wall? */
function touches(a: Set<Cell>, b: Set<Cell>): boolean {
  for (const c of a) {
    for (const s of STEP) if (b.has(c + s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------

type Grid = Set<Cell>;

interface Placement {
  index: number;
  cells: Cell[];
  set: Set<Cell>;
  shape: RoomShape;
  bounds: Rect;
  centre: Point;
}

/** Configurations tried per box before the box is given up on. */
const CARVE_TRIES = 6;

/**
 * Draw the room into a box that placement has already found room for.
 *
 * This is where the family axis earns its place inside the packer. The box is
 * dictated — a room pinned between two fixed neighbours has its width decided
 * for it — and the question is what can be drawn inside it. A rectangle answers
 * with one area, quantised to a multiple of that width; a cross answers with
 * almost any area at all, by varying arm thickness. Decoupling the bounding box
 * from the floor area is the coupling 6a could not break.
 *
 * Returns null when nothing legal can be drawn here, which the caller reads as
 * "try the next box" rather than as a failure.
 */
function place(
  index: number,
  box: Rect,
  dim: Dim,
  roll: ShapeRoll,
  hard: Placement[],
  rng: Rng
): Placement | null {
  // Which side each pinned neighbour is on, and the run it needs reaching.
  const need: Need = { w: [], e: [], n: [], s: [] };
  for (const n of hard) {
    const b = n.bounds;
    if (b.x + b.w === box.x || b.x === box.x + box.w) {
      const iv: Iv = [
        Math.max(b.y, box.y) - box.y,
        Math.min(b.y + b.h, box.y + box.h) - 1 - box.y,
      ];
      if (iv[0] <= iv[1]) (b.x === box.x + box.w ? need.e : need.w).push(iv);
    } else if (b.y + b.h === box.y || b.y === box.y + box.h) {
      const iv: Iv = [
        Math.max(b.x, box.x) - box.x,
        Math.min(b.x + b.w, box.x + box.w) - 1 - box.x,
      ];
      if (iv[0] <= iv[1]) (b.y === box.y + box.h ? need.s : need.n).push(iv);
    }
  }

  const finish = (cells: Cell[] | null, family: Family): Placement | null => {
    if (!cells || cells.length < 4 || !connected(cells)) return null;
    if (cells.length < roll.areaLo || cells.length > roll.areaHi) return null;
    const set = new Set(cells);
    // The belt to `carve`'s braces. `need` is derived from bounding boxes, and
    // a footprint that satisfied it should touch — but a connector with nowhere
    // to put its door is a plan `validateFloorplan` refuses outright, so the
    // cheap direct check stays.
    for (const n of hard) if (!touches(set, n.set)) return null;
    const bounds = boundsOf(cells);
    return {
      index,
      cells,
      set,
      shape: {
        family,
        proportion: roll.proportion,
        relief: roll.relief,
        // The class DESCRIBES the room that fit rather than dictating it. It is
        // never below the floor `shapeFor` set, because nothing below the floor
        // was ever offered.
        sizeClass: classOf(cells.length),
      },
      bounds,
      centre: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    };
  };

  // The box's own family first, then the rest. A box is offered on the strength
  // of one family reaching the band in it, but others often can too, and taking
  // a second-choice silhouette here is far cheaper than backtracking.
  const order = [dim.family, ...FAMILIES.filter((f) => f !== dim.family)];
  let tries = CARVE_TRIES;

  for (const family of order) {
    if (family === "round" && roll.degree > ROUND_MAX_DEGREE) continue;
    const cfgs = familyConfigs(family, box.w, box.h);

    // Configurations that land in the allowed interval, nearest the rolled band
    // first. The band is a preference; the interval is not.
    const usable: Config[] = [];
    for (let i = lowerBound(cfgs, roll.areaLo); i < cfgs.length && cfgs[i].area <= roll.areaHi; i++) {
      usable.push(cfgs[i]);
    }
    if (!usable.length) continue;
    const want = (roll.targetLo + roll.targetHi) / 2;
    usable.sort((p, q) => Math.abs(p.area - want) - Math.abs(q.area - want));

    for (const cfg of usable) {
      if (tries-- <= 0) return null;
      const got = finish(carve(box, family, cfg, need, rng), family);
      if (got) return got;
    }
  }
  return null;
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

/** Which way each wall faces, as an angle, in screen coordinates where y grows down. */
const FACING: Array<{ side: Side; angle: number }> = [
  { side: "east", angle: 0 },
  { side: "south", angle: Math.PI / 2 },
  { side: "west", angle: Math.PI },
  { side: "north", angle: -Math.PI / 2 },
];

/**
 * The walls a neighbour lying in a given direction may attach to, nearest first.
 *
 * Phase A already relaxed the rooms into positions — connected rooms pulling
 * together, all rooms pushing apart — which is a rough sketch of the whole map.
 * The packer ignored it entirely and guessed instead, trying every permutation
 * of neighbours onto walls and scoring them. This uses the sketch: the angle
 * from a room to its neighbour says roughly where that neighbour belongs, so
 * only the walls facing that way are worth trying.
 *
 * The tolerance is a quarter turn either side, which is one point of an
 * eight-point compass. A neighbour to the north-east may attach on the north
 * wall or the east wall. One due east may attach on the east wall, or near the
 * east end of the north or south wall — a room reaches round its own corner,
 * and pretending otherwise is what made this too rigid before.
 *
 * Nothing here says a wall takes one neighbour. Two or three may share, which is
 * an ordinary room with two doors in a wall, and is also the only way to draw a
 * room with more than four connections at all.
 */
function sidesToward(dx: number, dy: number): Side[] {
  const want = Math.atan2(dy, dx);
  const off = (a: number) => {
    const d = Math.abs(((want - a + Math.PI) % (2 * Math.PI)) - Math.PI);
    return d;
  };
  return FACING.filter((f) => off(f.angle) <= Math.PI / 2 + 1e-9)
    .sort((a, b) => off(a.angle) - off(b.angle))
    .map((f) => f.side);
}

/** How many wall assignments a room will actually try. */
const MAX_ASSIGNMENTS = 24;

/**
 * Combine each neighbour's allowed walls into whole assignments, cheapest first,
 * where cost is how far each neighbour strayed from the wall it wanted.
 *
 * Kept to a beam so a room with five neighbours and three options each does not
 * enumerate 243 of them; the tail of that list is every neighbour on its worst
 * wall at once, which is not worth the arithmetic.
 */
function sideAssignments(options: Side[][]): Side[][] {
  let beam: Array<{ sides: Side[]; cost: number }> = [{ sides: [], cost: 0 }];
  for (const opts of options) {
    const next: Array<{ sides: Side[]; cost: number }> = [];
    for (const acc of beam) {
      opts.forEach((s, rank) => next.push({ sides: [...acc.sides, s], cost: acc.cost + rank }));
    }
    next.sort((a, b) => a.cost - b.cost);
    beam = next.slice(0, MAX_ASSIGNMENTS * 2);
  }
  return beam.slice(0, MAX_ASSIGNMENTS).map((e) => e.sides);
}

/**
 * How much of the search actually happens.
 *
 * 6a.2 widened what each room could be — five families, hundreds of boxes — and
 * measured no improvement at sizes 4 and 5. The reason looks like these two
 * numbers: a bigger menu changes *which* ten positions get tried, not how many.
 * The extra options never reached the search at all.
 */
const MAX_CANDIDATES = 24;
/** how many positions get the more expensive second look */
const SHORTLIST = 96;
/** free-axis positions sampled per (arrangement, dimension) pair */
const SLIDES = 5;
/**
 * Positions tried before the attempt is abandoned. Counted in positions rather
 * than rooms because a seed that is going to thrash does it inside one level.
 */
const PLACEMENT_BUDGET = 6_000;

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
 *
 * What is searched here is the *box*. What goes inside it is `place`'s business,
 * and it is chosen knowing the box — which is the 6a.2 inversion.
 */
function* candidates(
  index: number,
  roll: ShapeRoll,
  hard: Placement[],
  sketch: Map<number, Point>,
  pull: Point,
  placed: Placement[],
  grid: Grid,
  rng: Rng
): Generator<Placement> {
  const scored: Array<{ box: Rect; dim: Dim; near: number }> = [];
  const add = (box: Rect, d: Dim) => {
    if (!boxFits(grid, box)) return;
    scored.push({
      box,
      dim: d,
      near: dist({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, pull) + d.penalty,
    });
  };

  if (hard.length === 0) {
    const dims = roll.boxes.slice(0, 12);
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
    const sweep = (options: Side[][]) => {
    for (const sides of sideAssignments(options)) {
      const west: Rect[] = [], east: Rect[] = [], north: Rect[] = [], south: Rect[] = [];
      hard.forEach((n, i) => {
        const b = n.bounds;
        if (sides[i] === "west") west.push(b);
        else if (sides[i] === "east") east.push(b);
        else if (sides[i] === "north") north.push(b);
        else south.push(b);
      });

      // Two neighbours may share a side — that is an ordinary room with two
      // doors in one wall — but they can only both abut it if they present the
      // same facing edge. Checked here so an impossible pin costs nothing.
      const flush = (rs: Rect[], f: (r: Rect) => number) => rs.every((r) => f(r) === f(rs[0]));
      if (west.length > 1 && !flush(west, (r) => r.x + r.w)) continue;
      if (east.length > 1 && !flush(east, (r) => r.x)) continue;
      if (north.length > 1 && !flush(north, (r) => r.y + r.h)) continue;
      if (south.length > 1 && !flush(south, (r) => r.y)) continue;

      // A neighbour to the west pins the left edge; one to the east pins the
      // right. With both, the width is dictated and only the dimensions that
      // match it are worth trying.
      const xLo = west.length ? west[0].x + west[0].w : null;
      const xHi = east.length ? east[0].x : null;
      const yLo = north.length ? north[0].y + north[0].h : null;
      const yHi = south.length ? south[0].y : null;

      const vertical = [...west, ...east];
      const horizontal = [...north, ...south];

      // Pinned on both sides of an axis, the size along it is dictated and only
      // the boxes that already have it are worth looking at.
      const reqW = xLo !== null && xHi !== null ? xHi - xLo : null;
      const reqH = yLo !== null && yHi !== null ? yHi - yLo : null;
      let pool: Dim[];
      if (reqW !== null && reqH !== null) {
        pool = (roll.byW.get(reqW) ?? []).filter((d) => d.h === reqH);
      } else if (reqW !== null) {
        pool = roll.byW.get(reqW) ?? [];
      } else if (reqH !== null) {
        pool = roll.byH.get(reqH) ?? [];
      } else {
        pool = roll.boxes;
      }

      for (const d of pool) {
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
    };

    // Phase A's sketch says roughly where each neighbour lies, so try the walls
    // facing that way first.
    const from = sketch.get(index);
    sweep(
      hard.map((n) => {
        const to = sketch.get(n.index);
        return from && to ? sidesToward(to.x - from.x, to.y - from.y) : [...SIDES];
      })
    );

    // But the sketch is a HINT, not a ruling. It is a force-relaxed
    // approximation of a graph, not a plan, and it knows nothing about how big
    // any room turned out to be — so where it disagrees with what will actually
    // fit, the room still has to be placed. Letting it veto is what made size 1
    // fail to draw at all, which a rough sketch has no business doing.
    if (!scored.length) sweep(hard.map(() => [...SIDES]));
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

  for (const s of shortlist.slice(0, MAX_CANDIDATES)) {
    const p = place(index, s.box, s.dim, roll, hard, rng);
    if (p) yield p;
  }
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
  rolls: Map<number, ShapeRoll>,
  sketch: Map<number, Point>,
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

    const roll = rolls.get(index)!;
    for (const cand of candidates(index, roll, hardPlaced, sketch, pull, here, grid, rng)) {
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
// RELIEF
// ---------------------------------------------------------------------------

/** How many niches and how many bays, per relief level. */
const RELIEF_WORK: Record<Relief, { cuts: number; bays: number; depth: number }> = {
  0: { cuts: 0, bays: 0, depth: 0 },
  1: { cuts: 2, bays: 2, depth: 3 },
  2: { cuts: 5, bays: 5, depth: 4 },
};

/**
 * Niches and bays, cut into a plan that already holds.
 *
 * Relief is a MODIFIER, not a category — a T-shaped room can have a niche and a
 * round one can have a bay. Tangling it into 6a's `irregular` and `composite`
 * forms is why those were the only two shapes that ever got carved, and why 70
 * of 119 "irregular" rooms came out as plain rectangles anyway.
 *
 * The guard is three things and no more:
 *
 *   1. never remove a cell carrying a door
 *   2. keep the footprint in one piece
 *   3. stop before the floor area leaves its band
 *
 * Plus a cap on how far any one shared wall may be eaten, so two rooms are not
 * left joined by a single cell that looks accidental. 6a's guard also refused
 * every cell abutting another room, which — at ~2.4 connections per room — put
 * often half the perimeter off limits. The validator only asks that a
 * connector's door sit in a wall its two rooms share, and says nothing about how
 * long that wall is. The door-only rule costs two or three cells and gives back
 * roughly half the boundary, which is the half the eye reads.
 */
function applyRelief(
  own: Set<Cell>,
  relief: Relief,
  neighbours: Array<Set<Cell>>,
  doorCells: Set<Cell>,
  grid: Grid,
  areaLo: number,
  areaHi: number,
  rng: Rng
): Cell[] {
  const work = RELIEF_WORK[relief];
  if (!work.cuts && !work.bays) return [...own];

  const set = new Set(own);

  // Which neighbours a cell is in contact with, and how much contact each has
  // left to spend. Tracked incrementally: recomputing per removal would make
  // this the most expensive thing in the packer for no reason.
  const contactsOf = (c: Cell): number[] => {
    const out: number[] = [];
    for (let i = 0; i < neighbours.length; i++) {
      for (const s of STEP) {
        if (neighbours[i].has(c + s)) {
          out.push(i);
          break;
        }
      }
    }
    return out;
  };

  const contact = neighbours.map(() => 0);
  for (const c of set) for (const i of contactsOf(c)) contact[i]++;
  const keep = contact.map((n) => Math.max(1, Math.floor(n / 2)));

  const boundary = (): Cell[] => {
    const out: Cell[] = [];
    for (const c of set) {
      for (const s of STEP) {
        if (!set.has(c + s)) {
          out.push(c);
          break;
        }
      }
    }
    return out;
  };

  // --- niches ---------------------------------------------------------------
  for (let n = 0; n < work.cuts; n++) {
    if (set.size <= areaLo) break;
    const edge = boundary();
    if (!edge.length) break;

    let at: Cell | undefined = rng.pick(edge);
    for (let d = rng.range(1, work.depth); d > 0 && at !== undefined; d--) {
      const c: Cell = at;
      const touched = contactsOf(c);
      const blocked =
        doorCells.has(c) || set.size - 1 < areaLo || touched.some((i) => contact[i] <= keep[i]);
      if (!blocked) {
        set.delete(c);
        if (connected([...set])) {
          for (const i of touched) contact[i]--;
        } else {
          set.add(c); // put it back: a room in two pieces is not a room
          break;
        }
      }
      at = STEP.map((s) => c + s).find((x) => set.has(x));
    }
  }

  // --- bays -----------------------------------------------------------------
  // Only into cells already verified as empty rock, which is why relief runs
  // after the corridors: by now there is nothing left to collide with.
  let box = boundsOf(set);
  for (let n = 0; n < work.bays; n++) {
    if (set.size >= areaHi) break;
    const free: Cell[] = [];
    for (const c of set) {
      for (const s of STEP) {
        const x = c + s;
        if (!grid.has(x) && !set.has(x)) free.push(x);
      }
    }
    if (!free.length) break;

    let at: Cell | undefined = rng.pick(free);
    for (let d = rng.range(1, work.depth); d > 0 && at !== undefined; d--) {
      if (set.size >= areaHi) break;
      const c: Cell = at;
      // A bay is outside the placed footprint by definition, so it is the one
      // thing that can push a room past the box cap. Only relief 2 may.
      if (relief < 2) {
        const x = cellX(c);
        const y = cellY(c);
        if (
          Math.max(x, box.x + box.w - 1) - Math.min(x, box.x) + 1 > BOX_CAP ||
          Math.max(y, box.y + box.h - 1) - Math.min(y, box.y) + 1 > BOX_CAP
        ) {
          break;
        }
        box = {
          x: Math.min(x, box.x),
          y: Math.min(y, box.y),
          w: Math.max(x, box.x + box.w - 1) - Math.min(x, box.x) + 1,
          h: Math.max(y, box.y + box.h - 1) - Math.min(y, box.y) + 1,
        };
      }
      set.add(c);
      grid.add(c);
      at = STEP.map((s) => c + s).find((x) => !grid.has(x) && !set.has(x));
    }
  }

  return [...set];
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
  opts: { seed: number; minCells?: Record<string, number>; onGiveUp?: (r: GiveUp) => void }
): Floorplan | null {
  const rng = new Rng(opts.seed);
  const giveUp = (r: GiveUp): null => {
    opts.onGiveUp?.(r);
    return null;
  };
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

  const rolls = new Map<number, ShapeRoll>();
  for (const i of chambers) {
    const stock = stockByIndex.get(i)!;
    rolls.set(i, shapeFor(stock, minCells[stock.roomId] ?? 0, rng));
  }

  // Phase A's force-relaxed positions: a rough sketch of the whole map, which
  // the packer used to ignore completely.
  const sketch = new Map<number, Point>(graph.rooms.map((r, i) => [i, { x: r.pos.x, y: r.pos.y }]));

  const budget = { left: PLACEMENT_BUDGET };
  const placed = placeChambers(order, hard, soft, rolls, sketch, budget, rng);
  if (!placed) return giveUp(budget.left <= 0 ? "placement-budget" : "placement-stuck");

  const grid: Grid = new Set();
  for (const p of placed.values()) for (const c of p.cells) grid.add(c);

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
    if (nb.length !== adj[i].length) return giveUp("corridor-adjacent");
    const want = Math.max(4, minCells[stock.roomId] ?? 0, rng.range(4, 12));
    const cells = growCorridor(nb, grid, want, arena, rng);
    if (!cells) return giveUp("corridor-route");
    corridors.set(i, cells);
    for (const c of cells) grid.add(c);
  }

  // --- doors ----------------------------------------------------------------
  const cellsOf = new Map<string, Set<Cell>>();
  for (const stock of sd.rooms) {
    cellsOf.set(stock.roomId, new Set(placed.get(stock.index)?.cells ?? corridors.get(stock.index)!));
  }

  const doors: FloorplanDoor[] = [];
  for (const c of sd.connectors) {
    const a = cellsOf.get(c.a);
    const b = cellsOf.get(c.b);
    if (!a || !b) return giveUp("no-shared-wall");
    const seams = sharedWall(a, b);
    if (!seams.length) return giveUp("no-shared-wall");
    doors.push({
      connectorId: c.id,
      from: c.a,
      to: c.b,
      kind: c.hidden ? "concealed" : c.gated ? "gated" : "plain",
      ...seams[Math.floor(seams.length / 2)],
    });
  }

  // --- relief ---------------------------------------------------------------
  // Last, and after the doors, because the guard needs to know which cells are
  // carrying one. By this point every loop is closed and the plan is sound;
  // relief is decoration on something already proved.
  const doorsOfRoom = new Map<string, Set<Cell>>(sd.rooms.map((r) => [r.roomId, new Set<Cell>()]));
  for (const d of doors) {
    // A door segment sits between two cells; each room owns the one on its side.
    const pair =
      d.orientation === "vertical"
        ? [cell(d.x - 1, d.y), cell(d.x, d.y)]
        : [cell(d.x, d.y - 1), cell(d.x, d.y)];
    for (const roomId of [d.from, d.to]) {
      const own = cellsOf.get(roomId)!;
      for (const c of pair) if (own.has(c)) doorsOfRoom.get(roomId)!.add(c);
    }
  }

  for (const stock of sd.rooms) {
    const p = placed.get(stock.index);
    if (!p) continue; // corridors take whatever shape the connection needed
    // Tiny cannot carry relief — 20 distinct silhouettes in 583 draws — so a
    // room that came out tiny is left perfect whatever it rolled.
    if (p.shape.relief === 0 || p.shape.sizeClass === "tiny") continue;


    const own = cellsOf.get(stock.roomId)!;
    const neighbours = adj[stock.index]
      .map((n) => stockByIndex.get(n))
      .map((s) => (s ? cellsOf.get(s.roomId) : undefined))
      .filter((s): s is Set<Cell> => !!s);

    for (const c of own) grid.delete(c);
    const relieved = applyRelief(
      own,
      p.shape.relief,
      neighbours,
      doorsOfRoom.get(stock.roomId)!,
      grid,
      rolls.get(stock.index)!.areaLo,
      rolls.get(stock.index)!.areaHi,
      rng
    );
    cellsOf.set(stock.roomId, new Set(relieved));
    for (const c of relieved) grid.add(c);
  }

  // --- assemble -------------------------------------------------------------
  const rooms: FloorplanRoom[] = [];
  for (const stock of sd.rooms) {
    const p = placed.get(stock.index);
    const cells = [...cellsOf.get(stock.roomId)!];
    rooms.push({
      roomId: stock.roomId,
      index: stock.index,
      isCorridor: stock.isCorridor,
      // The class describes the room that was drawn, so it is read off the
      // final area — after relief, which may have moved it.
      ...(p ? { shape: { ...p.shape, sizeClass: classOf(cells.length) } } : {}),
      cells: cells.map(asPoint),
      bounds: boundsOf(cells),
      outline: outlineOf(cells),
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
 * guarantee rather than a hope. The map is planning information the game master has
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
      const shape = r.shape;
      if (!shape) {
        fails.push(`room ${r.roomId}: a chamber with no shape`);
      } else {
        if (stock && classRank(shape.sizeClass) < stock.degree - 1) {
          fails.push(`room ${r.roomId}: class ${shape.sizeClass} below degree ${stock.degree} - 1`);
        }
        // The band is measured on FLOOR AREA, not on the bounding box: a cross
        // fills perhaps 40% of its box and only one of those two numbers is
        // what the fiction means.
        const [lo, hi] = AREA[shape.sizeClass];
        if (cells.length < lo || cells.length > hi) {
          fails.push(
            `room ${r.roomId}: ${cells.length} cells outside the ${shape.sizeClass} band ${lo}-${hi}`
          );
        }
        // The box is capped separately, and relief 2 is allowed past it — a bay
        // is by definition outside the placed footprint.
        if (shape.relief < 2 && (r.bounds.w > BOX_CAP || r.bounds.h > BOX_CAP)) {
          fails.push(`room ${r.roomId}: ${r.bounds.w}x${r.bounds.h} exceeds the ${BOX_CAP} cap`);
        }
        if (shape.family === "round" && stock && stock.degree > ROUND_MAX_DEGREE) {
          fails.push(`room ${r.roomId}: round with degree ${stock.degree}`);
        }
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
