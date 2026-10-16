/**
 * BLOCK PLAN — the dungeon as a partition of the grid, before any room has a shape.
 *
 * The first drawing was a packer, and it searched: it picked a rectangle for a
 * room, tried it against its placed neighbours, and backtracked when the rest of
 * the dungeon would not fit around it. Measured, that search ran out of its
 * position budget rather than out of options — it thrashed — and at thirty rooms
 * it drew about one time in a hundred, because every room had to succeed and the
 * odds multiplied. (It is in git history: `git log -- src/generation/floorplan/floorplan.ts`.)
 *
 * This builds instead of searching. One cell per room, a line between every pair
 * that connects, then the rooms grow outward until they have divided the space
 * between them. Nothing backtracks and nothing compounds, so a thirty-room
 * dungeon is not meaningfully harder than a six-room one.
 *
 * This file covers the first two steps only:
 *
 *   1. CENTRES — one cell per room, from the graph's relaxed positions, spaced so
 *      that connected rooms sit 4 to 8 cells apart measured round a corner.
 *   2. PATHS   — a line from each room's centre to each of its neighbours',
 *      turning at most once, no two lines sharing a cell.
 *
 * Step 2 is the only one that can fail, and it is why this returns null. The graph
 * guarantees the graph *can* be drawn without crossings; it does not guarantee
 * that its force-relaxed positions are such a drawing, and a one-turn line has
 * only two routes to choose between. When it fails the caller advances the seed,
 * exactly as everything else here does.
 */

import { Rng } from "../../shared/utils/rng.ts";
import { classOf, type Proportion, type SizeClass } from "./room-size.ts";
import type { Dungeon } from "./graph.ts";
import { cellKey } from "../../shared/utils/grid.ts";
import type { Point } from "../../shared/utils/grid.ts";

export interface BlockPath {
  /** graph indices of the two rooms */
  a: number;
  b: number;
  /** the cells strictly between the two centres, corner included */
  cells: Point[];
}

export interface BlockSeed {
  seed: number;
  /** graph index -> the anchor cell the spacing pass chose */
  centres: Point[];
  /** graph index -> its four starting cells */
  blocks: Point[][];
  paths: BlockPath[];
  attempts: number;
}

/** How far apart connected rooms should sit, measured round one corner. */
const SPAN_MIN = 5;
const SPAN_MAX = 9;
/** Rooms in different chunks sit at the far end of that: a chunk boundary is a journey. */
const TARGET_SAME = 6;
const TARGET_ACROSS = 9;
/** No two centres closer than this, connected or not. */
const CLEAR = 3;

// Spacing was tried at +50% (7.5 / 12 / 4) on the theory that more free ground
// means fewer collisions. It measured WORSE — size 3 fell from 4 of 8 dungeons
// solved to 2. A one-turn route lays down a full row segment plus a full column
// segment, so a longer connection is a longer barrier across the map, and that
// costs more than the extra space buys.

/** How many times a failing connection may move a room before the seed is given up on. */
const REPAIRS = 250;

const manhattan = (p: Point, q: Point) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);

/**
 * Space the rooms out.
 *
 * The graph already relaxed them — connected rooms pulling together, all rooms
 * pushing apart — so the shape is right and only the scale is wrong. This takes
 * that shape, sizes it so a typical connection comes out in range, and then runs
 * a short relaxation of its own against the actual targets, because scaling
 * alone leaves the short edges too short and the long ones too long.
 */
function spaceOut(graph: Dungeon, chunkOf: Map<number, number>, rng: Rng): Point[] {
  const n = graph.rooms.length;
  const edges = graph.edges.map((e) => ({
    a: e.a,
    b: e.b,
    target: chunkOf.get(e.a) === chunkOf.get(e.b) ? TARGET_SAME : TARGET_ACROSS,
  }));

  // Scale so the middling connection lands mid-range. Manhattan runs about a
  // quarter longer than straight-line for an arbitrary angle, so the straight
  // -line target is discounted to match.
  const raw = graph.edges
    .map((e) => Math.hypot(
      graph.rooms[e.a].pos.x - graph.rooms[e.b].pos.x,
      graph.rooms[e.a].pos.y - graph.rooms[e.b].pos.y
    ))
    .sort((p, q) => p - q);
  const median = raw[Math.floor(raw.length / 2)] || 1;
  const scale = ((TARGET_SAME + TARGET_ACROSS) / 2 / 1.27) / median;

  // Jitter of a couple of cells, not a fraction of one. The relaxation below is
  // a convergent process: nudge it by a tenth of a cell and it settles into the
  // same layout every time, so every "retry" is the same attempt and a dungeon
  // that will not route never starts routing. Measured, that is exactly what
  // happened — a couple of graphs succeeded on nearly every try and the rest on
  // none at all. The seed has to reach the starting conditions, not just the
  // tie-breaks.
  const pos = graph.rooms.map((r) => ({
    x: r.pos.x * scale + rng.range(-2000, 2000) / 1000,
    y: r.pos.y * scale + rng.range(-2000, 2000) / 1000,
  }));

  // Relax against the real targets: pull a connection toward its wanted length,
  // and push any two rooms apart that have crowded each other.
  const springs = (passes: number) => {
  for (let pass = 0; pass < passes; pass++) {
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);

    for (const e of edges) {
      const dx = pos[e.b].x - pos[e.a].x;
      const dy = pos[e.b].y - pos[e.a].y;
      const d = Math.abs(dx) + Math.abs(dy) || 0.001;
      const pull = (d - e.target) / d * 0.12;
      fx[e.a] += dx * pull;
      fy[e.a] += dy * pull;
      fx[e.b] -= dx * pull;
      fy[e.b] -= dy * pull;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const d = Math.abs(dx) + Math.abs(dy) || 0.001;
        if (d >= CLEAR + 1) continue;
        const push = (CLEAR + 1 - d) / d * 0.25;
        fx[i] -= dx * push;
        fy[i] -= dy * push;
        fx[j] += dx * push;
        fy[j] += dy * push;
      }
    }

    for (let i = 0; i < n; i++) {
      pos[i].x += fx[i];
      pos[i].y += fy[i];
    }
  }
  };
  springs(240);

  // Swapping two rooms fixes a crossing but knows nothing about spacing, and the
  // spring pass restores spacing but can reintroduce a crossing. So they take
  // turns, and the last word goes to untangling — a layout that is a cell out of
  // range still routes, and one with a crossing in it cannot.
  const eList = edges.map((e) => ({ a: e.a, b: e.b }));
  for (let round = 0; round < 6; round++) {
    untangle(pos, eList, rng, 1200);
    springs(50);
  }
  untangle(pos, eList, rng, 1200);

  // Snap, then walk anything that landed on top of something else outward until
  // it has its own cell and its clearance.
  const cells = pos.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const taken = new Set<string>();
  for (let i = 0; i < n; i++) {
    let guard = 0;
    while (guard++ < 400) {
      const clash =
        taken.has(cellKey(cells[i])) ||
        cells.some((c, j) => j !== i && taken.has(cellKey(c)) && manhattan(c, cells[i]) < CLEAR);
      if (!clash) break;
      cells[i].x += rng.pick([-1, 0, 1]);
      cells[i].y += rng.pick([-1, 0, 1]);
    }
    taken.add(cellKey(cells[i]));
  }
  return cells;
}

/** Do the open segments p1p2 and p3p4 properly cross? */
function segsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const side = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** How many pairs of connections cross. Pairs sharing a room are skipped. */
export function countCrossings(pos: Point[], edges: ReadonlyArray<{ a: number; b: number }>): number {
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i];
      const f = edges[j];
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      if (segsCross(pos[e.a], pos[e.b], pos[f.a], pos[f.b])) n++;
    }
  }
  return n;
}

/**
 * Pull the crossings out of the layout.
 *
 * THIS IS THE ONE THAT MATTERS. The graph's `relax()` is a plain spring simulation
 * with no notion of a crossing, and measured over 25 dungeons a size-4 layout has
 * 3.4 crossing pairs and a size-5 has 6.0 — every single size-4 dungeon has at
 * least one. `graph.ts` validates that the *graph* is planar, which says a
 * crossing-free drawing exists; it does not say the positions it hands out are
 * one. Those are different claims and the difference is most of why nothing here
 * would draw.
 *
 * A crossing cannot be nudged away — undoing one means moving a room to the far
 * side of something, which is why retrying and repairing both failed on exactly
 * the dungeons that had them. Swapping the two rooms is that move.
 */
function untangle(
  pos: Point[],
  edges: ReadonlyArray<{ a: number; b: number }>,
  rng: Rng,
  budget: number
): number {
  let best = countCrossings(pos, edges);
  const swap = (u: number, v: number) => {
    const t = pos[u];
    pos[u] = pos[v];
    pos[v] = t;
  };

  for (let step = 0; step < budget && best > 0; step++) {
    // Find a pair that crosses and work on it.
    let e = -1;
    let f = -1;
    outer: for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const p = edges[i];
        const q = edges[j];
        if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
        if (segsCross(pos[p.a], pos[p.b], pos[q.a], pos[q.b])) {
          e = i;
          f = j;
          break outer;
        }
      }
    }
    if (e < 0) break;

    const four = [edges[e].a, edges[e].b, edges[f].a, edges[f].b];
    const pairs: Array<[number, number]> = [
      [four[0], four[2]],
      [four[0], four[3]],
      [four[1], four[2]],
      [four[1], four[3]],
    ];

    let improved = false;
    for (const [u, v] of rng.pickN(pairs, pairs.length)) {
      swap(u, v);
      const now = countCrossings(pos, edges);
      if (now < best) {
        best = now;
        improved = true;
        break;
      }
      swap(u, v);
    }
    if (improved) continue;

    // No swap helped: shove one of the four and take it if things did not get
    // worse. Sideways moves are what gets off a plateau.
    const who = rng.pick(four);
    const saved = { ...pos[who] };
    pos[who] = { x: pos[who].x + rng.range(-4, 4), y: pos[who].y + rng.range(-4, 4) };
    const now = countCrossings(pos, edges);
    if (now <= best) best = now;
    else pos[who] = saved;
  }
  return best;
}

/** Every cell from `from` to `to` along one axis, excluding `from`, including `to`. */
function leg(from: Point, to: Point): Point[] {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const cells: Point[] = [];
  let { x, y } = from;
  while (x !== to.x || y !== to.y) {
    x += dx;
    y += dy;
    cells.push({ x, y });
  }
  return cells;
}

/** The two ways to get from a to b turning once: along x first, or along y first. */
function lRoutes(a: Point, b: Point): Point[][] {
  const via = (corner: Point) => [...leg(a, corner), ...leg(corner, b)];
  if (a.x === b.x || a.y === b.y) return [leg(a, b)];
  return [via({ x: b.x, y: a.y }), via({ x: a.x, y: b.y })];
}

/** The four 2x2 blocks that have the anchor cell as one of their corners. */
const CORNERS: Array<[number, number]> = [
  [0, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
];

const blockAt = (p: Point, [ox, oy]: [number, number]): Point[] => [
  { x: p.x + ox, y: p.y + oy },
  { x: p.x + ox + 1, y: p.y + oy },
  { x: p.x + ox, y: p.y + oy + 1},
  { x: p.x + ox + 1, y: p.y + oy + 1 },
];

/**
 * Grow each anchor into a 2x2, with the anchor at a randomly chosen corner.
 *
 * A single cell has four ways out, and a one-turn line can only leave toward its
 * target — so a room with three or four connections has to find distinct exits
 * among neighbours that each offer only two, and often cannot. Measured, that
 * alone took size 2 to zero. A 2x2 has eight cells around it, which doubles the
 * exits and lets two connections heading the same way leave side by side.
 *
 * The corner is free variety, but it is also the slack that keeps two blocks
 * whose anchors are close from landing on top of each other, so it is chosen
 * against what is already down rather than blindly.
 */
function makeBlocks(centres: Point[], rng: Rng): Point[][] | null {
  const taken = new Set<string>();
  const blocks: Point[][] = [];
  for (const p of centres) {
    let placed: Point[] | null = null;
    for (const corner of rng.pickN(CORNERS, CORNERS.length)) {
      const cells = blockAt(p, corner);
      if (cells.some((c) => taken.has(cellKey(c)))) continue;
      placed = cells;
      break;
    }
    if (!placed) return null;
    for (const c of placed) taken.add(cellKey(c));
    blocks.push(placed);
  }
  return blocks;
}

/** Cells orthogonally touching the block but not in it. */
function rimOf(block: Point[]): Point[] {
  const inside = new Set(block.map(cellKey));
  const out = new Map<string, Point>();
  for (const c of block) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (!inside.has(cellKey(n))) out.set(cellKey(n), n);
    }
  }
  return [...out.values()];
}

/** How many exit pairs a single connection will try before giving up on it. */
const ROUTE_TRIES = 96;

/**
 * Lay the connections down, shortest first.
 *
 * Short connections have the least room to go anywhere else, so they get the
 * clear ground; longer ones arriving later take whatever is still free. With
 * blocks rather than points there is real choice now: eight cells to leave from,
 * eight to arrive at, and two ways to turn between any pair of them.
 */
type RouteResult = { ok: true; paths: BlockPath[] } | { ok: false; a: number; b: number };

function route(blocks: Point[][], graph: Dungeon, rng: Rng): RouteResult {
  const solid = new Set<string>();
  for (const b of blocks) for (const c of b) solid.add(cellKey(c));
  const used = new Set<string>(solid);

  const centreOf = (b: Point[]) => ({ x: b[0].x + 0.5, y: b[0].y + 0.5 });
  const order = graph.edges
    .map((e, i) => ({
      e,
      i,
      d: manhattan(centreOf(blocks[e.a]) as Point, centreOf(blocks[e.b]) as Point),
    }))
    .sort((p, q) => p.d - q.d || p.i - q.i);

  const paths: BlockPath[] = [];
  for (const { e } of order) {
    const A = new Set(blocks[e.a].map(cellKey));
    const B = new Set(blocks[e.b].map(cellKey));

    // Already touching: the two rooms need no corridor between them at all.
    if (rimOf(blocks[e.a]).some((c) => B.has(cellKey(c)))) {
      paths.push({ a: e.a, b: e.b, cells: [] });
      continue;
    }

    const exits = rimOf(blocks[e.a]).filter((c) => !used.has(cellKey(c)));
    const entries = rimOf(blocks[e.b]).filter((c) => !used.has(cellKey(c)));

    const pairs: Array<{ from: Point; to: Point; d: number }> = [];
    for (const from of exits) {
      for (const to of entries) pairs.push({ from, to, d: manhattan(from, to) });
    }
    pairs.sort((p, q) => p.d - q.d);

    let laid: Point[] | null = null;
    for (const { from, to } of pairs.slice(0, ROUTE_TRIES)) {
      const routes = lRoutes(from, to);
      if (rng.coin()) routes.reverse();
      for (const rest of routes) {
        const cells = [from, ...rest];
        if (cells.some((c) => used.has(cellKey(c)) || A.has(cellKey(c)) || B.has(cellKey(c)))) continue;
        laid = cells;
        break;
      }
      if (laid) break;
    }
    if (!laid) return { ok: false, a: e.a, b: e.b };

    for (const c of laid) used.add(cellKey(c));
    paths.push({ a: e.a, b: e.b, cells: laid });
  }
  return { ok: true, paths };
}

/**
 * Shove one room a couple of cells and see if that unjams things.
 *
 * Restarting from a fresh seed does not work here: the spacing pass is a
 * convergent relaxation, so a new seed lands in much the same layout and a
 * dungeon that will not route keeps not routing however many times it is asked.
 * Measured, half the graphs at size 3 failed every one of a hundred attempts.
 * Moving the room that actually failed is the difference between rerolling the
 * problem and addressing it.
 */
function shift(blocks: Point[][], i: number, graph: Dungeon, rng: Rng): boolean {
  const others = new Set<string>();
  blocks.forEach((b, j) => {
    if (j !== i) for (const c of b) others.add(cellKey(c));
  });
  const linked = graph.edges
    .filter((e) => e.a === i || e.b === i)
    .map((e) => (e.a === i ? e.b : e.a));

  const clear: Point[][] = [];
  const ideal: Point[][] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      const moved = blocks[i].map((c) => ({ x: c.x + dx, y: c.y + dy }));
      if (moved.some((c) => others.has(cellKey(c)))) continue;
      clear.push(moved);
      // Prefer a move that leaves every connection still the right length.
      const spans = linked.every((j) => {
        const d = manhattan(moved[0], blocks[j][0]);
        return d >= SPAN_MIN && d <= SPAN_MAX;
      });
      if (spans) ideal.push(moved);
    }
  }
  const pool = ideal.length ? ideal : clear;
  if (!pool.length) return false;
  blocks[i] = rng.pick(pool);
  return true;
}

/**
 * One attempt at centres and connections. Null when a connection had nowhere to
 * go; the caller advances the seed.
 */
export function seedBlockPlan(graph: Dungeon, seed: number): BlockSeed | null {
  const rng = new Rng(seed);
  const chunkOf = new Map(graph.rooms.map((r, i) => [i, r.chunk]));
  const centres = spaceOut(graph, chunkOf, rng);
  const blocks = makeBlocks(centres, rng);
  if (!blocks) return null;

  // Route, and when a connection has nowhere to go, move one of its two rooms
  // and try again rather than throwing the whole layout away.
  for (let repair = 0; repair <= REPAIRS; repair++) {
    const got = route(blocks, graph, rng);
    if (got.ok) return { seed, centres, blocks, paths: got.paths, attempts: 1 };
    if (repair === REPAIRS) break;
    const who = rng.coin() ? got.a : got.b;
    if (!shift(blocks, who, graph, rng) && !shift(blocks, who === got.a ? got.b : got.a, graph, rng)) {
      break;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ZONES — dividing the ground between the rooms
// ---------------------------------------------------------------------------

const NEIGHBOURS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * One door, as the two cells it sits between: `from` is in room `a`, `to` is in
 * room `b`, and the wall segment between them is the way through.
 *
 * Exactly one per connector. Two rooms often run alongside each other for
 * several cells and any of those would serve, so one is picked at random — but
 * it is picked, and recorded, because the game master describes a door and the
 * player walks through it, and "somewhere along that wall" is not a place.
 */
export interface BlockDoor {
  a: number;
  b: number;
  from: Point;
  to: Point;
}

/**
 * The way out of the dungeon, as a door with nothing on the far side.
 *
 * It is not in `doors` and it is not on `graph.edges`, because it is not a way
 * between two rooms: `toBlueprint` emits room-to-room edges only, and the
 * surface connector is minted separately by the entities pass with
 * `endpointB: null`. So it has to be placed separately too, or the one exit
 * every dungeon has is the one exit the map cannot draw.
 *
 * `from` is a boundary cell of the entrance room; `to` is the rock outside it,
 * owned by nobody and never drawn as floor.
 */
export interface SurfaceDoor {
  /** graph index of the entrance room */
  room: number;
  from: Point;
  to: Point;
}

export interface BlockPlan extends BlockSeed {
  /** graph index -> every cell that room owns. Zones tile only where rooms reached. */
  zones: Point[][];
  /** graph index -> the room actually built inside its zone */
  rooms: Point[][];
  doors: BlockDoor[];
  /**
   * Null only when the entrance room has no wall facing open rock, which the
   * zone growth makes very unlikely and nothing guarantees. A dungeon whose way
   * out cannot be drawn is still playable; the map just does not show it.
   */
  surface: SurfaceDoor | null;
}

/**
 * Rooms take turns claiming ground until the connections between them are gone.
 *
 * A room may take empty rock, or a stretch of a corridor it is an end of — never
 * another room's ground, and never a corridor it has no part in. So the two ends
 * of a connection eat toward each other and meet somewhere along it, which is
 * what makes the two zones touch. That is the whole trick: adjacency stops being
 * something to search for and becomes a consequence of how the ground was
 * divided.
 *
 * It stops when every corridor cell has an owner. Rock beyond that is left as
 * rock, which is what keeps this from turning into a honeycomb.
 */
/**
 * How boxed in a room is: how many of the eight compass directions have another
 * room somewhere along them.
 *
 * A room in the middle of the dungeon has neighbours on all sides and only the
 * ground between them to claim; one on the rim has open rock behind it and can
 * expand into that forever. So the interior rooms are served first — they are
 * competing for the contested ground, and the outer ones lose nothing by
 * waiting, because what they are growing into is not contested at all.
 */
function surroundedness(blocks: Point[][]): number[] {
  return blocks.map((mine, i) => {
    const sectors = new Set<number>();
    blocks.forEach((other, j) => {
      if (i === j) return;
      const dx = other[0].x - mine[0].x;
      const dy = other[0].y - mine[0].y;
      sectors.add(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7);
    });
    return sectors.size;
  });
}

export function growZones(seed: BlockSeed, graph: Dungeon, isCorridor?: (i: number) => boolean): Point[][] {
  const owner = new Map<string, number>();
  const pathEnds = new Map<string, [number, number]>();

  seed.blocks.forEach((cells, i) => {
    for (const c of cells) owner.set(cellKey(c), i);
  });
  for (const p of seed.paths) {
    for (const c of p.cells) pathEnds.set(cellKey(c), [p.a, p.b]);
  }

  // Interior rooms claim before rim rooms, and corridors claim after everything
  // — a passage should come out of this with the least ground and the narrowest
  // footprint, which is what makes it read as a passage rather than a room.
  const boxed = surroundedness(seed.blocks);
  const turnOrder = seed.blocks
    .map((_c, i) => i)
    .sort((a, b) => {
      const ca = isCorridor?.(a) ? 1 : 0;
      const cb = isCorridor?.(b) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return boxed[b] - boxed[a];
    });

  const zones: Point[][] = seed.blocks.map((cells) => [...cells]);
  let frontier: Point[][] = seed.blocks.map((cells) => [...cells]);
  let unclaimed = pathEnds.size;

  const mayTake = (room: number, k: string) => {
    if (owner.has(k)) return false;
    const ends = pathEnds.get(k);
    return !ends || ends[0] === room || ends[1] === room;
  };

  for (let turn = 0; turn < 400 && unclaimed > 0; turn++) {
    const next: Point[][] = seed.blocks.map(() => []);
    let moved = false;

    for (const i of turnOrder) {
      for (const c of frontier[i]) {
        for (const [dx, dy] of NEIGHBOURS) {
          const n = { x: c.x + dx, y: c.y + dy };
          const k = cellKey(n);
          if (!mayTake(i, k)) continue;
          owner.set(k, i);
          if (pathEnds.has(k)) unclaimed--;
          zones[i].push(n);
          next[i].push(n);
          moved = true;
        }
      }
    }
    if (!moved) break;
    frontier = next;
  }
  return zones;
}

// ---------------------------------------------------------------------------
// ROOMS — what actually gets built inside a zone
// ---------------------------------------------------------------------------

/** Where two zones touch: a cell of each, side by side. */
function contacts(
  zones: Point[][],
  graph: Dungeon
): Map<number, Array<{ mine: Point; theirs: Point; with: number }>> {
  const own = new Map<string, number>();
  zones.forEach((cells, i) => {
    for (const c of cells) own.set(cellKey(c), i);
  });

  const out = new Map<number, Array<{ mine: Point; theirs: Point; with: number }>>();
  const push = (i: number, v: { mine: Point; theirs: Point; with: number }) => {
    const list = out.get(i) ?? [];
    list.push(v);
    out.set(i, list);
  };

  for (const e of graph.edges) {
    let found: { mine: Point; theirs: Point } | null = null;
    for (const c of zones[e.a]) {
      for (const [dx, dy] of NEIGHBOURS) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (own.get(cellKey(n)) === e.b) {
          found = { mine: c, theirs: n };
          break;
        }
      }
      if (found) break;
    }
    if (!found) continue;
    push(e.a, { mine: found.mine, theirs: found.theirs, with: e.b });
    push(e.b, { mine: found.theirs, theirs: found.mine, with: e.a });
  }
  return out;
}

/** Shortest run of cells inside `zone` from any of `from` to `to`. */
function walkInZone(zone: Set<string>, from: Set<string>, to: Point): Point[] | null {
  const prev = new Map<string, Point | null>();
  const queue: Point[] = [];
  for (const k of from) {
    const [x, y] = k.split(",").map(Number);
    prev.set(k, null);
    queue.push({ x, y });
  }
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    if (cur.x === to.x && cur.y === to.y) {
      const path: Point[] = [];
      let at: Point | undefined = cur;
      while (at) {
        path.push(at);
        at = prev.get(cellKey(at)) ?? undefined;
      }
      return path;
    }
    for (const [dx, dy] of NEIGHBOURS) {
      const n = { x: cur.x + dx, y: cur.y + dy };
      const k = cellKey(n);
      if (!zone.has(k) || prev.has(k)) continue;
      prev.set(k, cur);
      queue.push(n);
    }
  }
  return null;
}

/**
 * Build each room inside the ground it was given.
 *
 * The zones touching is not the same as the ROOMS touching — a room drawn in the
 * middle of its zone can sit nowhere near the boundary it shares with its
 * neighbour. So the contact cells are agreed between each pair first and both
 * rooms are required to contain their side of it. Contact then holds by
 * construction rather than by being checked afterwards, which is the mistake the
 * old packer made and spent all its time backtracking over.
 *
 * After that it is just growth: the room fills outward inside its own zone until
 * it has the floor it wants, and stops. What it does not take stays rock, which
 * is the gap between rooms.
 */
/**
 * Short side over long side, as a band the room is grown to sit inside.
 * `long` is a passage one or two cells wide; `square` is a chamber.
 */
const ASPECT_BAND: Record<Proportion, [number, number]> = {
  square: [0.75, 1],
  moderate: [0.3, 0.6],
  long: [0.08, 0.3],
};

const unkey = (k: string): Point => {
  const [x, y] = k.split(",").map(Number);
  return { x, y };
};

/** Short side over long side of the bounding box. 1 is square. */
function boxRatio(cells: Iterable<string>): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of cells) {
    const p = unkey(k);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  return Math.min(w, h) / Math.max(w, h);
}

export function buildRooms(
  seed: BlockSeed,
  zones: Point[][],
  graph: Dungeon,
  proportionOf: (room: number) => Proportion,
  targetArea: (room: number) => number,
  rng: Rng
): Point[][] | null {
  const touch = contacts(zones, graph);
  const out: Point[][] = [];

  for (let i = 0; i < zones.length; i++) {
    const zone = new Set(zones[i].map(cellKey));
    const taken = new Set(seed.blocks[i].map(cellKey));

    // Every agreed contact has to be in the room, and reachable from its block.
    // This is the skeleton: the doors, and the shortest ground joining them.
    for (const c of touch.get(i) ?? []) {
      if (taken.has(cellKey(c.mine))) continue;
      const run = walkInZone(zone, taken, c.mine);
      if (!run) return null;
      for (const p of run) taken.add(cellKey(p));
    }

    // Then grow it toward the floor it wants, one cell at a time, taking only
    // cells that keep the room the shape it rolled.
    //
    // Growing a cell at a time rather than a ring at a time is what lets the
    // proportion actually steer. A ring adds to every side at once, so a long
    // room could only ever get fatter and the roll had nothing to say beyond
    // "stop early". Cell by cell, a long room takes the cells at its ends —
    // those keep the ratio low — and refuses the ones along its flanks, so it
    // grows by getting LONGER. That is the difference between a proportion and a
    // stopping rule.
    const band = ASPECT_BAND[proportionOf(i)];
    const stray = (r: number) => (r < band[0] ? band[0] - r : r > band[1] ? r - band[1] : 0);
    const want = Math.min(targetArea(i), Math.floor(zones[i].length * 0.9));

    let guard = 0;
    while (taken.size < want && guard++ < 400) {
      const ring = new Set<string>();
      for (const k of taken) {
        const p = unkey(k);
        for (const [dx, dy] of NEIGHBOURS) {
          const n = cellKey({ x: p.x + dx, y: p.y + dy });
          if (zone.has(n) && !taken.has(n)) ring.add(n);
        }
      }
      if (!ring.size) break;

      const here = stray(boxRatio(taken));
      let best: string | null = null;
      let bestCost = Infinity;
      for (const k of ring) {
        taken.add(k);
        const cost = stray(boxRatio(taken));
        taken.delete(k);
        if (cost < bestCost) {
          bestCost = cost;
          best = k;
        }
      }
      // Stop rather than deform: if every remaining cell would push the room
      // further from its intended shape, it is the size it is going to be.
      if (best === null || bestCost > here + 1e-9) break;
      taken.add(best);
    }

    out.push([...taken].map(unkey));
  }
  return out;
}

/**
 * Put one door on each connector, anywhere along the wall its two rooms share.
 *
 * Runs after the rooms are built, on the wall they actually ended up sharing —
 * which exists by construction, because both rooms were required to contain
 * their side of a contact before either was drawn.
 */
export function chooseDoors(rooms: Point[][], graph: Dungeon, rng: Rng): BlockDoor[] {
  const doors: BlockDoor[] = [];
  for (const e of graph.edges) {
    const other = new Set(rooms[e.b].map(cellKey));
    const along: BlockDoor[] = [];
    for (const c of rooms[e.a]) {
      for (const [dx, dy] of NEIGHBOURS) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (other.has(cellKey(n))) along.push({ a: e.a, b: e.b, from: c, to: n });
      }
    }
    if (along.length) doors.push(rng.pick(along));
  }
  return doors;
}

/**
 * Put the way out on any wall of the entrance room that faces open rock.
 *
 * Uniformly at random among those, which is the whole rule. An earlier draft
 * pushed it toward the rim of the drawing by preferring the cell furthest from
 * the dungeon's centroid; the entrance room is already an outlying room — Phase
 * A picks entrances by distance from the centre — so that was work to buy
 * something the room's position had mostly bought already.
 *
 * "Facing open rock" is the one real condition: a cell nobody owns. A way out
 * that opens into another room's floor is not a way out.
 */
function surfaceDoor(
  rooms: Point[][],
  entrance: number,
  rng: Rng
): SurfaceDoor | null {
  const mine = rooms[entrance];
  if (!mine?.length) return null;

  const owned = new Set<string>();
  for (const cells of rooms) for (const c of cells) owned.add(cellKey(c));

  const options: SurfaceDoor[] = [];
  for (const c of mine) {
    for (const [dx, dy] of NEIGHBOURS) {
      const out = { x: c.x + dx, y: c.y + dy };
      if (!owned.has(cellKey(out))) options.push({ room: entrance, from: c, to: out });
    }
  }
  return options.length ? rng.pick(options) : null;
}

/**
 * The whole plan, from the graph and nothing else but which rooms are passages.
 *
 * That is the entire dependency, and it is what lets the layout run before any
 * of the fiction: identity, headlines, danger and rewards all come after, and
 * the identity roll can then be conditioned on the size each room turned out to
 * be. Chunk membership rides on the graph rooms already.
 */
export function blockPlan(
  graph: Dungeon,
  isCorridor: (room: number) => boolean,
  seed: number,
  proportionOf?: (room: number) => Proportion
): BlockPlan | null {
  const base = seedBlockPlan(graph, seed);
  if (!base) return null;
  const zones = growZones(base, graph, isCorridor);
  const rng = new Rng(seed + 1);
  // A corridor is a passage by definition and does not get to roll otherwise.
  const rolled = zones.map((_z, i) =>
    isCorridor(i)
      ? ("long" as Proportion)
      : rng.pick<Proportion>(["square", "square", "moderate", "moderate", "moderate", "long"])
  );
  const wanted = zones.map(() => rng.pick([6, 9, 14, 20, 28, 40, 56]));
  const rooms = buildRooms(base, zones, graph, proportionOf ?? ((i) => rolled[i]), (i) => wanted[i], rng);
  if (!rooms) return null;
  // The same entrance stocking uses — `stock.ts` takes entrances[0]
  // and drops the rest, so the map must not pick a different one.
  const entrance = graph.entrances.length ? graph.entrances[0] : 0;
  return {
    ...base,
    zones,
    rooms,
    doors: chooseDoors(rooms, graph, rng),
    surface: surfaceDoor(rooms, entrance, rng),
  };
}

/** Try layout seeds until one draws. */
export function blockPlanValid(
  graph: Dungeon,
  isCorridor: (room: number) => boolean,
  seed: number,
  attempts = 100
): BlockPlan | null {
  for (let i = 0; i < attempts; i++) {
    const got = blockPlan(graph, isCorridor, seed + i * 7919);
    if (got) return { ...got, attempts: i + 1 };
  }
  return null;
}

/**
 * What each room turned out to be, once it was built.
 *
 * The size class is READ OFF the finished room rather than asked for in advance.
 * That is the whole inversion: the ground a room could get is decided by where
 * its neighbours are and how much space they left it, which no roll can know, so
 * the roll is better spent on what the room *is* — and it can only sensibly be
 * spent once the size is a fact. See `sizeAllows`, which turns the archetype
 * pins from an instruction the packer could not honour into a condition on the
 * identity roll, which it always can.
 */
export function roomSizes(rooms: Point[][]): SizeClass[] {
  return rooms.map((cells) => classOf(cells.length));
}

