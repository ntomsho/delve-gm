/**
 * THE ROOM GRAPH — dungeon node & connection generator, the first stage of generation.
 *
 * One dungeon of 5-12 rooms, built in three steps and then checked:
 *
 *   1. A LOOP CORE. A cycle of 3+ rooms, then `loops - 1` ears: each ear is a
 *      path of 0-2 new rooms joining two different core rooms. An ear of no
 *      rooms is a SHORTCUT, a direct way between two rooms that already had a
 *      way round. Built by ears, the core has no bridge and no cut room.
 *   2. CHAINS. The rooms left over hang off the graph in chains of one or two.
 *      Each chain ends in a dead end; nothing else makes one. Dead ends are
 *      whatever this leaves, not a target.
 *   3. CHECKS. The shape's limits (dead ends, distinct routes to the goal, a
 *      bypass, balance), planarity and max degree. A failure advances the seed.
 *
 * Invariant: circuit rank  mu = E - V + 1 = loops.
 */

// ---------------------------------------------------------------- entity types

import type { IEntity, IRoom, IRoomConnector } from "../../shared/world/entities.ts";
import { checkPlanarity } from "./planarity.ts";

export type { IEntity, IRoom, IRoomConnector };

/** What the graph hands to content generation. */
export interface DungeonBlueprint {
  rooms: Array<Partial<IRoom>>;
  roomConnectors: Array<Partial<IRoomConnector>>;
}

// ---------------------------------------------------------------- internal types

export interface Room {
  id: number;
  /** stable entity id, carried through to the blueprint */
  entityId: string;
  pos: Vec;
  degree: number;
}

export interface Edge {
  a: number;
  b: number;
  /** stable entity id, carried through to the blueprint */
  entityId: string;
  /**
   * An ear with no rooms on it: a direct way between two rooms that already
   * had a way round. Where a secret passage belongs, because it bypasses
   * something (`gateConnectors` conceals these first).
   */
  shortcut: boolean;
  /**
   * What currently prevents the player from using this connection --
   * locked, blocked, concealed, too dangerous, etc. Absent means freely
   * usable. Cleared (deleted) once the player resolves the condition.
   * The graph leaves this unset; gating is applied downstream.
   */
  conditional?: string;
}

export interface Vec {
  x: number;
  y: number;
}

export interface Stats {
  rooms: number;
  edges: number;
  circuitRank: number;
  degreeHistogram: Record<number, number>;
  deadEnds: number;
  maxDegree: number;
  /** distinct routes from the entrance to the goal (see `routesOf`) */
  routes: number;
}

export interface Dungeon {
  seed: string;
  rooms: Room[];
  edges: Edge[];
  /** where the player comes in: the outermost room that is not a dead end */
  entrance: number;
  /** the deepest room from the entrance (`chooseGoal`) */
  goal: number;
  stats: Stats;
  valid: boolean;
  failures: string[];
  /**
   * The rotation system: each room's connectors in cyclic order around it, as
   * indices into `edges`. Present **iff** the graph is planar, which the
   * validator requires — the dungeon is drawn on one flat plane with nothing
   * overlapping, so a graph with no crossing-free drawing is thrown away and
   * the seed advanced.
   *
   * This is the placement plan: it says which side of a room each neighbour
   * belongs on, which is what keeps the floorplan packer from searching blind.
   */
  embedding?: number[][];
}

/**
 * The dungeon's shape, and how strict its checks are. Rolled once per dungeon
 * from its size (`shapeFor` in `src/generation/seeds.ts`), so a retried graph
 * keeps the room and loop counts. The graph knows nothing about sizes.
 */
export interface Params {
  rooms: number;
  loops: number;
  maxDeadEnds: number;
  /** distinct routes from the entrance to the goal, at least */
  minRoutes: number;
  /** some room on the shortest route can be skipped by a detour of at most 2 extra rooms */
  bypass: boolean;
  /** the two shortest distinct routes differ by at most 2 rooms */
  balance: boolean;
  maxDegree?: number;
  /** force-directed relaxation iterations; 0 disables */
  relaxIterations?: number;
}

// ---------------------------------------------------------------- rng

export type Rng = () => number;

/**
 * Entity id. Deliberately NOT drawn from the seeded rng — ids are identity,
 * not content, so they're fresh on every run and consume no seed draws.
 */
export function makeEntityId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // fallback for older runtimes
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function makeRng(seed: string): Rng {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, xs: T[]): T => xs[Math.floor(rng() * xs.length)];

function weightedPick<T>(rng: Rng, xs: T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < xs.length; i++) {
    r -= weights[i];
    if (r <= 0) return xs[i];
  }
  return xs[xs.length - 1];
}

// ---------------------------------------------------------------- graph utils

function neighbours(n: number, edges: Array<{ a: number; b: number }>): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  return adj;
}

function bfsDistances(adj: number[][], src: number, without = -1): number[] {
  const dist = new Array<number>(adj.length).fill(Infinity);
  dist[src] = 0;
  const q = [src];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    for (const v of adj[u]) {
      if (v === without || dist[v] !== Infinity) continue;
      dist[v] = dist[u] + 1;
      q.push(v);
    }
  }
  return dist;
}

// ---------------------------------------------------------------- construction

interface Plan {
  cycle: number;
  ears: number[];
  chains: number[];
}

/**
 * How the rooms divide between the first cycle, the ears and the chains.
 * Ears favour carrying rooms, because a dungeon of shortcuts is a dungeon of
 * corridors; chains are rolled up to the dead-end cap, which is a cap.
 */
function planRooms(p: Params, rng: Rng): Plan | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ears = Array.from({ length: p.loops - 1 }, () => weightedPick(rng, [0, 1, 2], [1, 2, 2]));
    const chainCount = weightedPick(
      rng,
      Array.from({ length: p.maxDeadEnds + 1 }, (_, i) => i),
      Array.from({ length: p.maxDeadEnds + 1 }, (_, i) => (i === 0 ? 1 : 2)),
    );
    const chains = Array.from({ length: chainCount }, () => weightedPick(rng, [1, 2], [2, 1]));
    const cycle = p.rooms - ears.reduce((s, k) => s + k, 0) - chains.reduce((s, k) => s + k, 0);
    if (cycle >= 3 && cycle <= 8) return { cycle, ears, chains };
  }
  return null;
}

function build(p: Params, rng: Rng): { rooms: Room[]; edges: Edge[] } | null {
  const maxDegree = p.maxDegree ?? 4;
  const plan = planRooms(p, rng);
  if (!plan) return null;

  const rooms: Room[] = [];
  const edges: Edge[] = [];
  const addRoom = () => {
    rooms.push({ id: rooms.length, entityId: makeEntityId(), pos: { x: 0, y: 0 }, degree: 0 });
    return rooms.length - 1;
  };
  const link = (a: number, b: number, shortcut = false) => {
    edges.push({ a, b, entityId: makeEntityId(), shortcut });
    rooms[a].degree++;
    rooms[b].degree++;
  };
  const linked = (a: number, b: number) =>
    edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));

  // 1. the first cycle
  for (let i = 0; i < plan.cycle; i++) addRoom();
  for (let i = 0; i < plan.cycle; i++) link(i, (i + 1) % plan.cycle);
  const core = rooms.map((r) => r.id);

  // 1b. ears, between two different core rooms with doors to spare
  for (const carried of plan.ears) {
    const open = core.filter((r) => rooms[r].degree < maxDegree);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        // a shortcut between neighbours would be a second door to the same room
        if (carried === 0 && linked(open[i], open[j])) continue;
        pairs.push([open[i], open[j]]);
      }
    }
    if (!pairs.length) return null;
    const [u, v] = pick(rng, pairs);
    let at = u;
    for (let k = 0; k < carried; k++) {
      const r = addRoom();
      link(at, r);
      core.push(r);
      at = r;
    }
    link(at, v, carried === 0);
  }

  // 2. chains, hung off any room with a door to spare
  for (const length of plan.chains) {
    const open = rooms.filter((r) => r.degree < maxDegree).map((r) => r.id);
    if (!open.length) return null;
    let at = pick(rng, open);
    for (let k = 0; k < length; k++) {
      const r = addRoom();
      link(at, r);
      at = r;
    }
  }

  return { rooms, edges };
}

// ---------------------------------------------------------------- positions

function initialPositions(rooms: Room[], rng: Rng) {
  const radius = 95 * Math.sqrt(rooms.length / 6);
  // dart-throwing scatter with a minimum separation
  const placed: Vec[] = [];
  for (const room of rooms) {
    let best: Vec | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const r = radius * Math.sqrt(rng());
      const t = rng() * 2 * Math.PI;
      const p = { x: Math.cos(t) * r, y: Math.sin(t) * r };
      const okDist = placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 46);
      if (okDist) { best = p; break; }
      if (!best) best = p;
    }
    placed.push(best!);
    room.pos = best!;
  }
}

function relax(rooms: Room[], edges: Edge[], iterations: number) {
  if (iterations <= 0) return;
  const rest = 72;
  const repel = 9000;

  for (let step = 0; step < iterations; step++) {
    const cool = 1 - step / iterations;
    const fx = new Array(rooms.length).fill(0);
    const fy = new Array(rooms.length).fill(0);

    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        let dx = rooms[i].pos.x - rooms[j].pos.x;
        let dy = rooms[i].pos.y - rooms[j].pos.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = rooms[i].id - rooms[j].id || 1; dy = 1; }
        const d = Math.sqrt(d2);
        const f = repel / d2;
        fx[i] += (dx / d) * f; fy[i] += (dy / d) * f;
        fx[j] -= (dx / d) * f; fy[j] -= (dy / d) * f;
      }
    }

    for (const e of edges) {
      const i = e.a, j = e.b;
      const dx = rooms[j].pos.x - rooms[i].pos.x;
      const dy = rooms[j].pos.y - rooms[i].pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - rest) * 0.055;
      fx[i] += (dx / d) * f; fy[i] += (dy / d) * f;
      fx[j] -= (dx / d) * f; fy[j] -= (dy / d) * f;
    }

    for (let i = 0; i < rooms.length; i++) {
      const step2 = 6 * cool;
      const m = Math.hypot(fx[i], fy[i]) || 1;
      const s = Math.min(step2, m) / m;
      rooms[i].pos.x += fx[i] * s;
      rooms[i].pos.y += fy[i] * s;
    }
  }
}

// ---------------------------------------------------------------- entrance and goal

/**
 * The room furthest from the drawing's centre that is not a dead end, so the
 * player starts on the edge of the map with a choice of ways on.
 */
function chooseEntrance(rooms: Room[]): number {
  const n = rooms.length;
  const cx = rooms.reduce((s, r) => s + r.pos.x, 0) / n;
  const cy = rooms.reduce((s, r) => s + r.pos.y, 0) / n;
  const far = (r: Room) => Math.hypot(r.pos.x - cx, r.pos.y - cy);
  const candidates = rooms.filter((r) => r.degree >= 2);
  return (candidates.length ? candidates : rooms).reduce((a, b) => (far(b) > far(a) ? b : a)).id;
}

/**
 * Eccentricity from the entrance -- the honest "opposite side of the map".
 * Ties break toward the better-connected room so the climax has routes.
 *
 * Exported because stocking places the goal entity here and the route checks
 * below are about this room: both read the same answer.
 */
export function chooseGoal(n: number, edges: Array<{ a: number; b: number }>, entrance: number): number {
  const adj = neighbours(n, edges);
  const depth = bfsDistances(adj, entrance);
  let goal = entrance;
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (i === entrance) continue;
    const score = depth[i] * 10 + adj[i].length;
    if (score > best) {
      best = score;
      goal = i;
    }
  }
  return goal;
}

// ---------------------------------------------------------------- routes

/**
 * Every route from `from` to `to` that never visits a room twice, as the set
 * of rooms on it, reduced to the DISTINCT ones.
 *
 * Two routes are distinct when each has a room the other lacks. A route whose
 * rooms include all of another's is that route plus a detour -- a bypass, not
 * a second way -- so only the minimal room sets are kept, and those are
 * distinct from each other by construction. Shortest first.
 *
 * Exhaustive, which is fine at twelve rooms and a few loops.
 */
export function routesOf(
  n: number,
  edges: Array<{ a: number; b: number }>,
  from: number,
  to: number,
): Array<Set<number>> {
  const adj = neighbours(n, edges);
  const all: Array<Set<number>> = [];
  const onPath = new Set<number>([from]);
  const walk = (u: number) => {
    if (u === to) { all.push(new Set(onPath)); return; }
    for (const v of adj[u]) {
      if (onPath.has(v)) continue;
      onPath.add(v);
      walk(v);
      onPath.delete(v);
    }
  };
  walk(from);

  const within = (a: Set<number>, b: Set<number>) => a.size <= b.size && [...a].every((x) => b.has(x));
  const minimal = all.filter((r, i) => !all.some((o, j) => j !== i && o.size < r.size && within(o, r)));
  // identical room sets walked in a different order are one route
  const seen = new Set<string>();
  const distinct = minimal.filter((r) => {
    const key = [...r].sort((a, b) => a - b).join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return distinct.sort((a, b) => a.size - b.size);
}

/**
 * Some room on the shortest route can be skipped: the rooms either side of it
 * have a way between them that avoids it and passes at most 3 rooms -- going
 * round instead of through costs at most 2 extra rooms.
 */
function hasBypass(n: number, edges: Edge[], entrance: number, goal: number): boolean {
  const adj = neighbours(n, edges);
  const fromEntrance = bfsDistances(adj, entrance);
  if (fromEntrance[goal] === Infinity) return false;
  // a shortest route, walked back from the goal
  const route = [goal];
  while (route[route.length - 1] !== entrance) {
    const at = route[route.length - 1];
    route.push(adj[at].find((v) => fromEntrance[v] === fromEntrance[at] - 1)!);
  }
  route.reverse();
  for (let i = 1; i < route.length - 1; i++) {
    const before = route[i - 1], skipped = route[i], after = route[i + 1];
    if (bfsDistances(adj, before, skipped)[after] <= 4) return true;
  }
  return false;
}

// ---------------------------------------------------------------- validate

function validate(d: Dungeon, p: Params, routes: Array<Set<number>>): string[] {
  const fails: string[] = [];
  const n = d.rooms.length;
  const maxDegree = p.maxDegree ?? 4;

  if (n !== p.rooms) fails.push(`${n} rooms, expected ${p.rooms}`);
  if (d.stats.circuitRank !== p.loops) fails.push(`${d.stats.circuitRank} loops, expected ${p.loops}`);

  const reach = bfsDistances(neighbours(n, d.edges), 0);
  if (reach.some((x) => x === Infinity)) fails.push("graph is disconnected");

  // The floorplan is a flat plane with no overlaps, so the graph has to be
  // drawable without crossings. `embedding` is set iff it is.
  if (!d.embedding) fails.push("graph has no crossing-free drawing (non-planar)");
  if (d.stats.maxDegree > maxDegree) fails.push(`max degree ${d.stats.maxDegree} > ${maxDegree}`);
  if (d.stats.deadEnds > p.maxDeadEnds) fails.push(`${d.stats.deadEnds} dead ends > ${p.maxDeadEnds}`);

  if (routes.length < p.minRoutes) {
    fails.push(`${routes.length} distinct route(s) to the goal, need ${p.minRoutes}`);
  }
  if (p.bypass && !hasBypass(n, d.edges, d.entrance, d.goal)) {
    fails.push("no room on the shortest route can be bypassed");
  }
  if (p.balance && routes.length >= 2 && routes[1].size - routes[0].size > 2) {
    fails.push(`the two shortest routes differ by ${routes[1].size - routes[0].size} rooms`);
  }
  return fails;
}

// ---------------------------------------------------------------- generate

/** An empty dungeon that fails: what a seed whose rooms could not be divided returns. */
function failed(seed: string, why: string): Dungeon {
  return {
    seed,
    rooms: [],
    edges: [],
    entrance: 0,
    goal: 0,
    stats: { rooms: 0, edges: 0, circuitRank: 0, degreeHistogram: {}, deadEnds: 0, maxDegree: 0, routes: 0 },
    valid: false,
    failures: [why],
  };
}

export function generate(seed: string, params: Params): Dungeon {
  const rng = makeRng(seed);
  const built = build(params, rng);
  if (!built) return failed(seed, "rooms could not be divided into the shape");
  const { rooms, edges } = built;

  initialPositions(rooms, rng);
  relax(rooms, edges, params.relaxIterations ?? 400);

  const n = rooms.length;
  const entrance = chooseEntrance(rooms);
  const goal = chooseGoal(n, edges, entrance);
  const routes = routesOf(n, edges, entrance, goal);

  const hist: Record<number, number> = {};
  for (const r of rooms) hist[r.degree] = (hist[r.degree] ?? 0) + 1;
  const stats: Stats = {
    rooms: n,
    edges: edges.length,
    circuitRank: edges.length - n + 1,
    degreeHistogram: hist,
    deadEnds: rooms.filter((r) => r.degree <= 1 && r.id !== entrance).length,
    maxDegree: Math.max(...rooms.map((r) => r.degree)),
    routes: routes.length,
  };

  const planarity = checkPlanarity(n, edges.map((e) => [e.a, e.b] as const));

  const dungeon: Dungeon = {
    seed,
    rooms,
    edges,
    entrance,
    goal,
    stats,
    valid: false,
    failures: [],
    ...(planarity.planar ? { embedding: planarity.rotation } : {}),
  };
  dungeon.failures = validate(dungeon, params, routes);
  dungeon.valid = dungeon.failures.length === 0;
  return dungeon;
}

// ---------------------------------------------------------------- blueprint

/**
 * Project the internal graph onto the entity model that content generation
 * consumes. The graph only knows structure, so name/base/state/composed are
 * emitted blank and everything else is left for later passes to fill.
 */
export function toBlueprint(d: Dungeon): DungeonBlueprint {
  // base/state/composed are deliberately NOT emitted. `state === undefined`
  // means "not yet encountered", so writing "" here would mark the whole
  // dungeon as already seen. Later passes fill them in.
  return {
    rooms: d.rooms.map((r) => ({
      name: "",
      id: r.entityId,
      type: "Room" as const,
    })),
    roomConnectors: d.edges.map((e) => ({
      name: "",
      id: e.entityId,
      type: "RoomConnector" as const,
      endpointA: d.rooms[e.a].entityId,
      endpointB: d.rooms[e.b].entityId,
      ...(e.conditional !== undefined ? { conditional: e.conditional } : {}),
    })),
  };
}

/**
 * Primary entry point. Generates, retries until the graph validates, and
 * returns the blueprint. Pass `withDungeon` if you also want the internal
 * graph for rendering or inspection.
 */
export function generateBlueprint(seed: string, params: Params): DungeonBlueprint;
export function generateBlueprint(
  seed: string,
  params: Params,
  withDungeon: true,
): { blueprint: DungeonBlueprint; dungeon: Dungeon; attempts: number };
export function generateBlueprint(seed: string, params: Params, withDungeon = false) {
  const { dungeon, attempts } = generateValid(seed, params);
  const blueprint = toBlueprint(dungeon);
  return withDungeon ? { blueprint, dungeon, attempts } : blueprint;
}

/**
 * Generate, advancing the seed until a dungeon passes validation. Rejection is
 * how the shape's checks are met, so the budget is generous; a graph is a
 * fraction of a millisecond.
 */
export function generateValid(
  seed: string,
  params: Params,
  maxAttempts = 500,
): { dungeon: Dungeon; attempts: number } {
  for (let i = 0; i < maxAttempts; i++) {
    const d = generate(i === 0 ? seed : `${seed}#${i}`, params);
    if (d.valid) return { dungeon: d, attempts: i + 1 };
  }
  throw new Error(`no valid graph for seed ${seed} in ${maxAttempts} attempts`);
}

// NOTHING RUNS AT IMPORT. This module also loads in a browser.
