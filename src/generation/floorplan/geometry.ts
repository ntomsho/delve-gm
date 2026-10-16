/**
 * THE DRAWN ROOM, AS WORDS.
 *
 * The block plan knows every room as a set of grid cells and every way through
 * as a break in a shared wall. That is enough to say how big a room is, which
 * way it runs, whether it is a clean rectangle or a notched one, and which wall
 * each of its exits is in — all of it a bounding box and a compass lookup away,
 * with no new geometry and no model call.
 *
 * WHY IT EXISTS. Until now the writing pass saw a room's rolled identity and
 * nothing else, so it wrote "a long banquet hall" while the plan drew a squarish
 * one. The map and the prose were describing different rooms and only the player
 * was in a position to notice. Handing the same derivation to the content pass
 * at generation and to the room block at runtime is what makes them agree.
 *
 * TWO RULES ABOUT WHAT LEAVES HERE.
 *
 *   Geometry goes out as WORDS, never as coordinates. "A long hall, about 20 by
 *   55 feet, with three ways off the east wall" is something a model can write
 *   to. A cell list is something it would have to do arithmetic on, and the
 *   arithmetic would be where it went wrong.
 *
 *   The compass is MAP-ABSOLUTE. North is up, the drawing never rotates, and
 *   nothing here knows which way the player is facing. So "the north wall" is
 *   always safe and "on your left" is always a guess — which is worth saying out
 *   loud in the prompt, because a game master handed compass directions will reach
 *   for the relative ones on its own.
 *
 * Screen coordinates throughout, matching the block plan and the SVG: y grows
 * DOWNWARD, so north is -y.
 */

import type { BlockPlan } from "./blockplan.ts";
import type { Point } from "../../shared/utils/grid.ts";
import type { Dungeon } from "./graph.ts";
import { classOf, type Proportion, type SizeClass } from "./room-size.ts";
import { cellKey } from "../../shared/utils/grid.ts";

/**
 * One grid cell, in feet.
 *
 * Five is the dungeon-map convention and it is the number that makes the bands
 * read right: a four-cell closet comes out 10 by 10, a forty-cell hall comes out
 * something like 30 by 35. It lives here as one constant because the moment two
 * places convert cells to feet they will disagree.
 */
export const CELL_FEET = 5;

export type Wall = "north" | "south" | "east" | "west";

/**
 * Where along a wall something sits, named by the compass, or null for the
 * middle.
 *
 * One type rather than a per-wall pair: on a north or south wall the ends are
 * west and east, on an east or west wall they are north and south, and which
 * applies falls out of the wall itself. `alongPhrase` does the rendering.
 */
export type Along = "north" | "south" | "east" | "west" | null;

export type Axis = "north-south" | "east-west";

/**
 * How much of its bounding box the room actually fills.
 *
 * A drawn room has no shape family — no round, cross or T — so this is the whole
 * shape vocabulary the block plan can honestly support. It is small and it is
 * true, which is the better trade: a room described as notched really is notched.
 *
 * THE THRESHOLDS ARE MEASURED, NOT GUESSED. Over 1,520 chambers across sizes
 * 1–5 the fill runs min 0.04, p25 0.53, median 0.67, p75 0.78, max 1.00 — the
 * block plan grows rooms cell by cell out of a skeleton, so a clean rectangle is
 * the rare case rather than the default. A first pass cut at 0.95 / 0.68 and
 * called 56% of the dungeon "ragged, nothing like a rectangle", which is a
 * strong claim about the majority and therefore no information at all. At
 * 0.85 / 0.60 the three words come out near 16 / 48 / 36 and each of them
 * distinguishes its rooms from the others, which is the whole job.
 */
export type Outline = "rectangular" | "notched" | "ragged";

/** See `Outline` — measured, and re-measure before changing either. */
const FILL_RECTANGULAR = 0.85;
const FILL_NOTCHED = 0.6;

export interface GeometryExit {
  /**
   * The `IRoomConnector` id, or NULL for the way out of the dungeon — which is
   * minted by the entities pass rather than by Phase A and so is not on
   * `graph.edges` for this module to read an id off. Same convention as
   * `LayoutSurface`.
   */
  connectorId: string | null;
  /** graph index of the room on the far side; null for the way out */
  to: number | null;
  wall: Wall;
  along: Along;
}

export interface RoomGeometry {
  /** graph index */
  room: number;
  corridor: boolean;
  /** floor cells */
  area: number;
  /** the bounding box, in cells */
  box: { w: number; h: number };
  /** the same box in feet, which is what the prose is allowed to say */
  feet: { w: number; h: number };
  sizeClass: SizeClass;
  proportion: Proportion;
  /** which way the long side runs; null when the room is square */
  longAxis: Axis | null;
  outline: Outline;
  /** the longest unbroken run of floor against each side, in cells */
  walls: Record<Wall, number>;
  exits: GeometryExit[];
  /**
   * The exit the player most likely walks in through — the one toward the
   * shallowest neighbour, or the way out itself in the entrance room.
   *
   * This is what "near the entrance" and "far end" are measured from, and it is
   * the only thing here that is a guess rather than a fact: a player can arrive
   * from any door. It is a good enough guess to place a hearth by, and nothing
   * downstream treats it as more than that.
   */
  arrival?: GeometryExit;
}

// ---------------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------------

const WALLS: Wall[] = ["north", "south", "east", "west"];

/** The step from a cell to the cell outside it, through the named wall. */
const STEP: Record<Wall, Point> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

/** Which two compass words name the ends of this wall, low first. */
const ENDS: Record<Wall, [Along, Along]> = {
  north: ["west", "east"],
  south: ["west", "east"],
  east: ["north", "south"],
  west: ["north", "south"],
};


export function boundingBox(cells: Point[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * The floor cells that back onto each side.
 *
 * A cell is on the north wall when the cell above it is not this room's — which
 * is what "along the north wall" has to mean for a room that is not a rectangle.
 * An L has north-facing floor at two different heights and both of them are
 * genuinely the north wall of the part of the room they are in.
 */
export function wallCells(cells: Point[]): Record<Wall, Point[]> {
  const mine = new Set(cells.map(cellKey));
  const out: Record<Wall, Point[]> = { north: [], south: [], east: [], west: [] };
  for (const c of cells) {
    for (const w of WALLS) {
      const s = STEP[w];
      if (!mine.has(cellKey({ x: c.x + s.x, y: c.y + s.y }))) out[w].push(c);
    }
  }
  return out;
}

/**
 * The longest unbroken stretch of one wall, in cells.
 *
 * Not the count of wall cells: a room with four separate two-cell stretches of
 * north wall has no north wall a player would describe as one thing. Runs are
 * taken within a single row (or column), so the two arms of an L do not add up.
 */
function longestRun(facing: Point[], wall: Wall): number {
  const horizontal = wall === "north" || wall === "south";
  const rows = new Map<number, number[]>();
  for (const c of facing) {
    const row = horizontal ? c.y : c.x;
    const along = horizontal ? c.x : c.y;
    const list = rows.get(row);
    if (list) list.push(along);
    else rows.set(row, [along]);
  }
  let best = 0;
  for (const list of rows.values()) {
    list.sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i] === list[i - 1] + 1) run++;
      else {
        if (run > best) best = run;
        run = 1;
      }
    }
  }
  return best;
}

/**
 * How far along its wall a cell sits: toward one end, or in the middle.
 *
 * Thirds of the bounding box, and a wall shorter than four cells has no ends
 * worth naming — "toward the west end" of a three-foot stretch is a distinction
 * the player cannot act on, so it comes back null.
 */
function alongWall(cell: Point, wall: Wall, box: { x: number; y: number; w: number; h: number }): Along {
  const horizontal = wall === "north" || wall === "south";
  const span = horizontal ? box.w : box.h;
  if (span < 4) return null;
  const offset = horizontal ? cell.x - box.x : cell.y - box.y;
  const [low, high] = ENDS[wall];
  if (offset < span / 3) return low;
  if (offset >= (span * 2) / 3) return high;
  return null;
}

/** Which wall of the room a door in `from` leading to `to` cuts through. */
function wallOf(from: Point, to: Point): Wall {
  if (to.y < from.y) return "north";
  if (to.y > from.y) return "south";
  if (to.x > from.x) return "east";
  return "west";
}

/**
 * How far each room is from the way in, in rooms.
 *
 * Computed here rather than read off `RoomStock.depth` so this module needs only
 * the graph and the plan. That keeps it testable against a bare graph and keeps
 * the drawing independent of the stocking, which is the same separation the
 * block plan itself makes.
 */
export function roomDepths(graph: Dungeon): number[] {
  const depth = graph.rooms.map(() => Infinity);
  const adj: number[][] = graph.rooms.map(() => []);
  for (const e of graph.edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const queue = [...graph.entrances];
  for (const r of queue) depth[r] = 0;
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    for (const n of adj[at]) {
      if (depth[n] !== Infinity) continue;
      depth[n] = depth[at] + 1;
      queue.push(n);
    }
  }
  return depth;
}

// ---------------------------------------------------------------------------
// THE DERIVATION
// ---------------------------------------------------------------------------

export interface GeometryOptions {
  /** graph index -> true when the room is a passage rather than a chamber */
  isCorridor?: (room: number) => boolean;
}

/**
 * One `RoomGeometry` per room, in graph index order.
 *
 * Pure, cheap, and derived — nothing here is persisted. The block plan is the
 * durable thing and this is a reading of it, so a change to the vocabulary is a
 * change to one function rather than a migration.
 */
export function roomGeometry(
  plan: BlockPlan,
  graph: Dungeon,
  opts: GeometryOptions = {}
): RoomGeometry[] {
  const corridorAt = opts.isCorridor ?? (() => false);
  const depth = roomDepths(graph);

  // A door is stored once, from room `a` to room `b`. Both rooms want it, seen
  // from their own side, so it is indexed both ways round here.
  const exitsOf: GeometryExit[][] = graph.rooms.map(() => []);
  const byPair = new Map<string, string>();
  for (const e of graph.edges) byPair.set(`${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`, e.entityId);

  const boxes = plan.rooms.map((cells) => boundingBox(cells));

  for (const d of plan.doors) {
    const connectorId = byPair.get(`${Math.min(d.a, d.b)}-${Math.max(d.a, d.b)}`) ?? null;
    exitsOf[d.a].push({
      connectorId,
      to: d.b,
      wall: wallOf(d.from, d.to),
      along: alongWall(d.from, wallOf(d.from, d.to), boxes[d.a]),
    });
    exitsOf[d.b].push({
      connectorId,
      to: d.a,
      wall: wallOf(d.to, d.from),
      along: alongWall(d.to, wallOf(d.to, d.from), boxes[d.b]),
    });
  }

  if (plan.surface) {
    const { room, from, to } = plan.surface;
    exitsOf[room].push({
      connectorId: null,
      to: null,
      wall: wallOf(from, to),
      along: alongWall(from, wallOf(from, to), boxes[room]),
    });
  }

  return plan.rooms.map((cells, i) => {
    const box = boxes[i];
    const facing = wallCells(cells);
    const long = Math.max(box.w, box.h);
    const short = Math.min(box.w, box.h);
    const ratio = long / Math.max(short, 1);
    const fill = cells.length / (box.w * box.h);
    const exits = exitsOf[i];

    // The way out beats every door in the entrance room: it is the way the
    // player actually came in, not merely the shallowest of several guesses.
    const surfaceExit = exits.find((x) => x.to === null);
    const arrival =
      surfaceExit ??
      exits
        .filter((x) => x.to !== null)
        .sort((a, b) => depth[a.to!] - depth[b.to!])[0];

    return {
      room: i,
      corridor: corridorAt(i),
      area: cells.length,
      box: { w: box.w, h: box.h },
      feet: { w: box.w * CELL_FEET, h: box.h * CELL_FEET },
      sizeClass: classOf(cells.length),
      proportion: ratio >= 2 ? "long" : ratio >= 1.25 ? "moderate" : "square",
      longAxis: ratio < 1.25 ? null : box.h > box.w ? "north-south" : "east-west",
      outline:
        fill >= FILL_RECTANGULAR ? "rectangular" : fill >= FILL_NOTCHED ? "notched" : "ragged",
      walls: {
        north: longestRun(facing.north, "north"),
        south: longestRun(facing.south, "south"),
        east: longestRun(facing.east, "east"),
        west: longestRun(facing.west, "west"),
      },
      exits,
      arrival,
    } satisfies RoomGeometry;
  });
}

// ---------------------------------------------------------------------------
// THE GROUND ITSELF
// ---------------------------------------------------------------------------

/**
 * The cells behind the words.
 *
 * `RoomGeometry` is what goes in a prompt; this is what a placement is computed
 * against, and the two are kept apart on purpose. Nothing in here may reach the
 * model — a cell list is coordinates, and coordinates are the thing that stays
 * on this side of the boundary.
 */
export interface RoomGround {
  room: number;
  cells: Point[];
  /** cells of THIS room that a door sits in; nothing may be placed on them */
  doorCells: Point[];
  /** the door cell the player most likely walks in through, per `arrival` */
  arrivalCell?: Point;
}

export function roomGround(plan: BlockPlan, geoms: RoomGeometry[]): RoomGround[] {
  const doorCells: Point[][] = plan.rooms.map(() => []);
  /** the cell of room `i` that the door to room `j` sits in */
  const cellToward = new Map<string, Point>();

  for (const d of plan.doors) {
    doorCells[d.a].push(d.from);
    doorCells[d.b].push(d.to);
    cellToward.set(`${d.a}>${d.b}`, d.from);
    cellToward.set(`${d.b}>${d.a}`, d.to);
  }
  if (plan.surface) {
    doorCells[plan.surface.room].push(plan.surface.from);
    cellToward.set(`${plan.surface.room}>out`, plan.surface.from);
  }

  return plan.rooms.map((cells, i) => {
    const arrival = geoms[i]?.arrival;
    return {
      room: i,
      cells,
      doorCells: doorCells[i],
      arrivalCell: arrival ? cellToward.get(`${i}>${arrival.to ?? "out"}`) : undefined,
    };
  });
}

/**
 * Both halves at once, indexed by graph room.
 *
 * One object because the two are always wanted together and always derived from
 * the same plan: the words go into the prompt, the cells stay behind to place
 * whatever the words came back describing. `generate.ts` builds it once and
 * hands it to the content pass, which prints one half and keeps the other.
 */
export interface Siting {
  geometry: RoomGeometry[];
  ground: RoomGround[];
}

export function siteRooms(plan: BlockPlan, graph: Dungeon, opts: GeometryOptions = {}): Siting {
  const geometry = roomGeometry(plan, graph, opts);
  return { geometry, ground: roomGround(plan, geometry) };
}

// ---------------------------------------------------------------------------
// THE WORDS
// ---------------------------------------------------------------------------

/** "toward the west end" / "at the middle" — how an `Along` is said. */
export function alongPhrase(along: Along): string {
  return along === null ? "at the middle" : `toward the ${along} end`;
}

/** "the north wall, toward the west end" — how an exit's position is said. */
export function exitPhrase(exit: GeometryExit): string {
  return `the ${exit.wall} wall, ${alongPhrase(exit.along)}`;
}

/**
 * The room's shape as one line, for a prompt.
 *
 * Deliberately one line and deliberately plain. It sits among twenty other
 * fields in a room brief, and anything longer would start competing with the
 * fiction for the model's attention — which is the opposite of the point. The
 * dimensions are the load-bearing part; everything else is a qualifier on them.
 */
/**
 * The proportion axis as an adjective.
 *
 * `moderate` is the name of a band and not a word anybody would use about a
 * room — "a small moderate chamber" reads as a mistake. The bands do not change;
 * only what they are called on the page does.
 */
const SHAPE_WORD: Record<Proportion, string> = {
  square: "roughly square",
  moderate: "oblong",
  long: "long and narrow",
};

const OUTLINE_WORD: Record<Outline, string> = {
  // Not "straight walls all round": the band starts at 0.85 of the box, so the
  // common case in it is a rectangle with a corner bitten out, and only a few
  // per cent are the real thing. The words say what is true of the band.
  rectangular: "close to a rectangle, give or take a corner",
  notched: "irregular, its walls stepping in and out",
  ragged: "ragged, nothing like a rectangle",
};

export interface DescribeOptions {
  /**
   * Connector ids to leave out of the ways-out clause.
   *
   * WHAT THIS IS FOR: a concealed way. The sentence counts doors and says which
   * walls they are in, and a count is not something a reader can partially
   * believe — told "two off the west wall" about a room with one visible door
   * and one secret one, the game master describes both, and a secret door that gets
   * described is not a secret door. So the runtime hands in the concealed ones
   * and they are simply not there to be counted.
   *
   * The CONTENT PASS passes nothing and sees them all, deliberately: it is the
   * pass that writes what the concealed way physically is, and it cannot write
   * about a door it was never told about.
   */
  omit?: ReadonlySet<string>;
}

export function describeGeometry(g: RoomGeometry, opts: DescribeOptions = {}): string {
  // Proportion is a CLAUSE and not an adjective on the noun, because the band
  // names do not survive being used as one: "a small moderate chamber" reads as
  // a typo, and "a small long and narrow chamber" reads as two mistakes.
  const kind = g.corridor ? "a passage" : `a ${g.sizeClass} chamber`;
  const runs = g.longAxis ? `, running ${g.longAxis}` : "";

  const byWall = new Map<Wall, GeometryExit[]>();
  for (const x of g.exits) {
    // The way out of the dungeon has a null id and is never omitted: it is the
    // one door the player has certainly been through.
    if (x.connectorId !== null && opts.omit?.has(x.connectorId)) continue;
    const list = byWall.get(x.wall);
    if (list) list.push(x);
    else byWall.set(x.wall, [x]);
  }
  const ways = WALLS.filter((w) => byWall.has(w))
    .map((w) => `${wordFor(byWall.get(w)!.length)} off the ${w} wall`)
    .join(", ");

  return (
    `${kind}, about ${g.feet.w} by ${g.feet.h} feet -- ` +
    `${SHAPE_WORD[g.proportion]}${runs}, ${OUTLINE_WORD[g.outline]}` +
    (ways ? `. Ways out: ${ways}` : "")
  );
}

/**
 * Counts in words, because the payload should not read as though a number were
 * being handed over to be reasoned with. Past four it stops mattering.
 */
function wordFor(n: number): string {
  return ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ?? `${n}`;
}
