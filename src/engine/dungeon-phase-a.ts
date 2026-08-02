/**
 * Phase A — dungeon node & connection generator.
 *
 * Spec:
 *   - Rooms come in chunks of 6.
 *   - Each chunk has exactly 6 interior connections (=> unicyclic: one cycle + tree spurs).
 *   - Inter-chunk connections L >= C, every chunk has inter-chunk degree >= 2.
 *   - Chunk-level graph must be 2-edge-connected (min-degree 2 is NOT sufficient).
 *   - Inter-chunk stubs attach to DISTINCT rooms on a chunk's interior cycle.
 *
 * Invariant: circuit rank  mu = E - V + 1 = L + 1.
 * Target degree split: 1/6 dead ends, 1/3 corridors, 1/2 junctions.
 */

// ---------------------------------------------------------------- entity types

import type { IEntity, IRoom, IRoomConnector } from "./dungeon-entities";

export type { IEntity, IRoom, IRoomConnector };

/** What Phase A hands to content generation. */
export interface DungeonBlueprint {
  rooms: Array<Partial<IRoom>>;
  roomConnectors: Array<Partial<IRoomConnector>>;
}

// ---------------------------------------------------------------- internal types

export type EdgeKind = "interior" | "inter-chunk";

export interface Room {
  id: number;
  /** stable entity id, carried through to the blueprint */
  entityId: string;
  chunk: number;
  /** true if this room sits on its chunk's interior cycle */
  onCycle: boolean;
  /** index around the interior cycle, or -1 for tree/spur rooms */
  cycleIndex: number;
  pos: Vec;
  degree: number;
}

export interface Edge {
  a: number;
  b: number;
  /** stable entity id, carried through to the blueprint */
  entityId: string;
  kind: EdgeKind;
  /**
   * What currently prevents the player from using this connection --
   * locked, blocked, concealed, too dangerous, etc. Absent means freely
   * usable. Cleared (deleted) once the player resolves the condition.
   * Phase A leaves this unset; gating is applied downstream.
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
  edgesPerRoom: number;
  circuitRank: number;
  interChunkEdges: number;
  degreeHistogram: Record<number, number>;
  deadEndShare: number;
  corridorShare: number;
  junctionShare: number;
  maxDegree: number;
  cycleLengths: number[];
}

export interface Dungeon {
  seed: string;
  chunkCount: number;
  rooms: Room[];
  edges: Edge[];
  entrances: number[];
  stats: Stats;
  valid: boolean;
  failures: string[];
}

export interface Params {
  /** number of 6-room chunks */
  chunks: number;
  /** total inter-chunk edges; defaults to C (ring) + a chord per 4 chunks */
  interChunkEdges?: number;
  /** relative weights for interior cycle length 3,4,5,6 */
  cycleLengthWeights?: [number, number, number, number];
  maxDegree?: number;
  /** probability a chunk-graph repair doubles an existing link instead of adding a chord */
  doubleChance?: number;
  /** cap on a chunk's inter-chunk degree (also caps its interior cycle length) */
  maxChunkDegree?: number;
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

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- graph utils

function adjacency(n: number, edges: Edge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => {
    adj[e.a].push(i);
    adj[e.b].push(i);
  });
  return adj;
}

const other = (e: Edge, v: number) => (e.a === v ? e.b : e.a);

/**
 * Tarjan, restricted to `allowed` vertices. Parent tracked by EDGE INDEX so
 * parallel edges are handled correctly (matters for the C=2 double link).
 */
function findBridgesAndArticulations(
  n: number,
  edges: Edge[],
  allowed?: Set<number>,
): { bridges: number[]; articulations: number[] } {
  const ok = (v: number) => !allowed || allowed.has(v);
  const adj = adjacency(n, edges);
  const disc = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const bridges: number[] = [];
  const arts = new Set<number>();
  let timer = 0;

  const dfs = (u: number, parentEdge: number) => {
    disc[u] = low[u] = timer++;
    let children = 0;
    for (const ei of adj[u]) {
      if (ei === parentEdge) continue;
      const v = other(edges[ei], u);
      if (!ok(v)) continue;
      if (disc[v] !== -1) {
        low[u] = Math.min(low[u], disc[v]);
      } else {
        children++;
        dfs(v, ei);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] > disc[u]) bridges.push(ei);
        if (parentEdge !== -1 && low[v] >= disc[u]) arts.add(u);
      }
    }
    if (parentEdge === -1 && children > 1) arts.add(u);
  };

  for (let v = 0; v < n; v++) if (ok(v) && disc[v] === -1) dfs(v, -1);
  return { bridges, articulations: [...arts] };
}

/** Iteratively strip degree-1 vertices. What remains is the 2-core. */
function twoCore(n: number, edges: Edge[]): Set<number> {
  const deg = new Array<number>(n).fill(0);
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }
  const alive = new Set<number>(Array.from({ length: n }, (_, i) => i));
  const adj = adjacency(n, edges);
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of [...alive]) {
      if (deg[v] > 1) continue;
      alive.delete(v);
      changed = true;
      for (const ei of adj[v]) {
        const w = other(edges[ei], v);
        if (alive.has(w)) deg[w]--;
      }
    }
  }
  return alive;
}

function bfsDistances(n: number, edges: Edge[], src: number): number[] {
  const adj = adjacency(n, edges);
  const dist = new Array<number>(n).fill(Infinity);
  dist[src] = 0;
  const q = [src];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    for (const ei of adj[u]) {
      const v = other(edges[ei], u);
      if (dist[v] === Infinity) {
        dist[v] = dist[u] + 1;
        q.push(v);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------- chunk interior

interface ChunkInfo {
  index: number;
  roomIds: number[];
  cycleIds: number[];
  cycleLen: number;
  center: Vec;
}

/**
 * 6 rooms, exactly 6 edges: a cycle of length 3-6 plus tree spurs off it.
 * cycleLen edges + (6 - cycleLen) spur edges = 6, always.
 */
function buildChunkInterior(
  index: number,
  baseId: number,
  rng: Rng,
  rooms: Room[],
  edges: Edge[],
  weights: [number, number, number, number],
  minCycleLen = 3,
): ChunkInfo {
  // every stub needs its own cycle room, so the cycle can't be shorter than
  // this chunk's inter-chunk degree
  const floorLen = Math.min(6, Math.max(3, minCycleLen));
  const options = [3, 4, 5, 6].filter((n) => n >= floorLen);
  const optionWeights = options.map((n) => weights[n - 3]);
  const cycleLen = optionWeights.some((w) => w > 0)
    ? weightedPick(rng, options, optionWeights)
    : options[0];
  const ids = Array.from({ length: 6 }, (_, i) => baseId + i);

  for (let i = 0; i < 6; i++) {
    rooms.push({
      id: ids[i],
      entityId: makeEntityId(),
      chunk: index,
      onCycle: i < cycleLen,
      cycleIndex: i < cycleLen ? i : -1,
      pos: { x: 0, y: 0 },
      degree: 0,
    });
  }

  for (let i = 0; i < cycleLen; i++) {
    edges.push({
      a: ids[i],
      b: ids[(i + 1) % cycleLen],
      entityId: makeEntityId(),
      kind: "interior",
    });
  }

  // spurs; hosts can be cycle rooms or previously attached spur rooms (chains)
  const hosts = ids.slice(0, cycleLen);
  for (let i = cycleLen; i < 6; i++) {
    const host = pick(rng, hosts);
    edges.push({
      a: host,
      b: ids[i],
      entityId: makeEntityId(),
      kind: "interior",
    });
    hosts.push(ids[i]);
  }

  return {
    index,
    roomIds: ids,
    cycleIds: ids.slice(0, cycleLen),
    cycleLen,
    center: { x: 0, y: 0 },
  };
}

// ---------------------------------------------------------------- chunk-level graph

/** Chunks reachable from `src` when edge `skip` is removed. */
function chunkComponent(
  C: number,
  pairs: Array<[number, number]>,
  src: number,
  skip = -1,
): Set<number> {
  const adj: number[][] = Array.from({ length: C }, () => []);
  pairs.forEach(([a, b], i) => {
    if (i === skip) return;
    adj[a].push(b);
    adj[b].push(a);
  });
  const seen = new Set([src]);
  const stack = [src];
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  }
  return seen;
}

/**
 * Indices of chunk edges whose removal disconnects the chunk graph.
 * Brute force (C is tiny) because it handles parallel edges correctly,
 * which vertex-parent Tarjan does not.
 */
function chunkBridgeIndices(C: number, pairs: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (chunkComponent(C, pairs, 0, i).size < C) out.push(i);
  }
  return out;
}

function chunkDegrees(C: number, pairs: Array<[number, number]>): number[] {
  const deg = new Array(C).fill(0);
  for (const [a, b] of pairs) { deg[a]++; deg[b]++; }
  return deg;
}

/**
 * Chunk-level multigraph. Repeated pairs are allowed: a chunk may reach the
 * same neighbour twice. Guarantees:
 *   - connected (every chunk reachable from every other, hence from any entrance)
 *   - every chunk has inter-chunk degree >= 2
 *   - no single chunk edge is a bridge (a doubled pair counts as two routes)
 *
 * Built as a random spanning tree, then each bridge is repaired by either
 * doubling it (a lobe you enter and leave through the same neighbour) or
 * adding a chord across it (weaving it into a longer cycle).
 */
function buildChunkMultigraph(
  C: number,
  targetL: number,
  doubleChance: number,
  maxChunkDegree: number,
  rng: Rng,
): Array<[number, number]> {
  if (C <= 1) return [];
  if (C === 2) return [[0, 1], [0, 1]];

  const pairs: Array<[number, number]> = [];
  const attached = [0];
  for (const v of shuffle(rng, Array.from({ length: C - 1 }, (_, i) => i + 1))) {
    const deg = chunkDegrees(C, pairs);
    const hosts = attached.filter((h) => deg[h] < maxChunkDegree - 1);
    const host = pick(rng, hosts.length ? hosts : attached);
    pairs.push([host, v]);
    attached.push(v);
  }

  const roomy = (deg: number[], xs: number[]) => {
    const free = xs.filter((x) => deg[x] < maxChunkDegree);
    return free.length ? free : xs;
  };

  for (let guard = 0; guard < 500; guard++) {
    const bridges = chunkBridgeIndices(C, pairs);
    if (!bridges.length) break;
    const idx = pick(rng, bridges);
    const [a, b] = pairs[idx];
    const deg = chunkDegrees(C, pairs);

    const canChord = deg[a] < maxChunkDegree || deg[b] < maxChunkDegree;
    if (rng() < doubleChance || !canChord) {
      pairs.push([a, b]);
      continue;
    }
    const sideA = [...chunkComponent(C, pairs, a, idx)];
    const sideB = [...Array(C).keys()].filter((x) => !sideA.includes(x));
    if (!sideB.length) { pairs.push([a, b]); continue; }
    const x = pick(rng, roomy(deg, sideA));
    const y = pick(rng, roomy(deg, sideB));
    pairs.push(x === y ? [a, b] : [x, y]);
  }

  // top up to the requested edge count
  let guard = 0;
  while (pairs.length < targetL && guard++ < 500) {
    const deg = chunkDegrees(C, pairs);
    const open = [...Array(C).keys()].filter((x) => deg[x] < maxChunkDegree);
    if (open.length < 2) break;
    if (rng() < doubleChance) {
      const existing = pairs.filter(([a, b]) => deg[a] < maxChunkDegree && deg[b] < maxChunkDegree);
      if (existing.length) { pairs.push(pick(rng, existing)); continue; }
    }
    const a = pick(rng, open);
    const b = pick(rng, open.filter((x) => x !== a));
    if (b === undefined) break;
    pairs.push([a, b]);
  }

  return pairs;
}

/**
 * Choose which room in a chunk carries a stub. Must be on the interior cycle,
 * must be distinct from this chunk's other stub rooms, and spread around the
 * cycle so the two disjoint arcs are both meaningful.
 */
function pickStubRoom(
  chunk: ChunkInfo,
  used: Map<number, number[]>,
  roomById: Map<number, Room>,
  maxDegree: number,
  rng: Rng,
): number {
  const usedIdx = used.get(chunk.index) ?? [];
  const free = chunk.cycleIds.filter((id) => {
    const r = roomById.get(id)!;
    return !usedIdx.includes(r.cycleIndex) && r.degree < maxDegree;
  });
  const pool = free.length ? free : chunk.cycleIds.filter((id) => roomById.get(id)!.degree < maxDegree);
  if (!pool.length) return pick(rng, chunk.cycleIds);

  let best = pool[0];
  let bestScore = -1;
  for (const id of shuffle(rng, pool)) {
    const idx = roomById.get(id)!.cycleIndex;
    let score = chunk.cycleLen;
    for (const u of usedIdx) {
      const d = Math.abs(idx - u);
      score = Math.min(score, Math.min(d, chunk.cycleLen - d));
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------- layout

function initialPositions(chunks: ChunkInfo[], rooms: Room[], rng: Rng) {
  const C = chunks.length;
  const ringRadius = C === 1 ? 0 : 130 + 42 * C;
  const chunkRadius = 95;

  chunks.forEach((c, i) => {
    const theta = (2 * Math.PI * i) / Math.max(C, 1) + rng() * 0.25;
    c.center = {
      x: Math.cos(theta) * ringRadius,
      y: Math.sin(theta) * ringRadius,
    };
    // dart-throwing scatter with a minimum separation
    const placed: Vec[] = [];
    for (const id of c.roomIds) {
      let best: Vec | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const r = chunkRadius * Math.sqrt(rng());
        const t = rng() * 2 * Math.PI;
        const p = { x: c.center.x + Math.cos(t) * r, y: c.center.y + Math.sin(t) * r };
        const okDist = placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 46);
        if (okDist) { best = p; break; }
        if (!best) best = p;
      }
      placed.push(best!);
      rooms.find((rm) => rm.id === id)!.pos = best!;
    }
  });
}

function relax(rooms: Room[], edges: Edge[], iterations: number) {
  if (iterations <= 0) return;
  const idx = new Map(rooms.map((r, i) => [r.id, i]));
  const restInterior = 72;
  const restInter = 140;
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
      const i = idx.get(e.a)!, j = idx.get(e.b)!;
      const dx = rooms[j].pos.x - rooms[i].pos.x;
      const dy = rooms[j].pos.y - rooms[i].pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = e.kind === "interior" ? restInterior : restInter;
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

// ---------------------------------------------------------------- entrances

function chooseEntrances(rooms: Room[], edges: Edge[], C: number, rng: Rng): number[] {
  const n = rooms.length;
  const cx = rooms.reduce((s, r) => s + r.pos.x, 0) / n;
  const cy = rooms.reduce((s, r) => s + r.pos.y, 0) / n;
  const count = C === 1 ? 1 : Math.min(C, rng() < 0.4 ? 3 : 2);

  const candidates = rooms
    .slice()
    .sort(
      (a, b) =>
        Math.hypot(b.pos.x - cx, b.pos.y - cy) - Math.hypot(a.pos.x - cx, a.pos.y - cy),
    )
    .slice(0, Math.max(6, Math.floor(n / 2)));

  const chosen: number[] = [candidates[0].id];
  while (chosen.length < count) {
    const dists = chosen.map((s) => bfsDistances(n, edges, s));
    let best = -1, bestScore = -1;
    for (const c of candidates) {
      if (chosen.includes(c.id)) continue;
      const sameChunk = chosen.some(
        (s) => rooms.find((r) => r.id === s)!.chunk === c.chunk,
      );
      const score = Math.min(...dists.map((d) => d[c.id])) - (sameChunk ? 3 : 0);
      if (score > bestScore) { bestScore = score; best = c.id; }
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen;
}

// ---------------------------------------------------------------- validate

function validate(d: Dungeon, chunks: ChunkInfo[], maxDegree: number): string[] {
  const fails: string[] = [];
  const n = d.rooms.length;
  const C = d.chunkCount;

  for (const c of chunks) {
    const interior = d.edges.filter(
      (e) => e.kind === "interior" && d.rooms[e.a].chunk === c.index,
    ).length;
    if (interior !== 6) fails.push(`chunk ${c.index}: ${interior} interior edges, expected 6`);
  }

  if (C > 1) {
    const interDeg = new Array(C).fill(0);
    const cPairs: Array<[number, number]> = [];
    for (const e of d.edges) {
      if (e.kind !== "inter-chunk") continue;
      const ca = d.rooms[e.a].chunk, cb = d.rooms[e.b].chunk;
      interDeg[ca]++; interDeg[cb]++;
      cPairs.push([ca, cb]);
    }
    interDeg.forEach((deg, i) => {
      if (deg < 2) fails.push(`chunk ${i}: inter-chunk degree ${deg} < 2`);
    });
    if (chunkComponent(C, cPairs, 0).size < C) fails.push("chunk graph is disconnected");
    const cbr = chunkBridgeIndices(C, cPairs);
    if (cbr.length) fails.push(`chunk graph has ${cbr.length} bridge(s)`);

    // stub rooms must be distinct within a chunk
    const perChunk = new Map<number, Set<number>>();
    for (const e of d.edges) {
      if (e.kind !== "inter-chunk") continue;
      for (const v of [e.a, e.b]) {
        const ch = d.rooms[v].chunk;
        if (!perChunk.has(ch)) perChunk.set(ch, new Set());
        const s = perChunk.get(ch)!;
        if (s.has(v)) fails.push(`chunk ${ch}: room ${v} carries two stubs (cut vertex)`);
        s.add(v);
      }
    }
    for (const e of d.edges) {
      if (e.kind !== "inter-chunk") continue;
      for (const v of [e.a, e.b]) {
        if (!d.rooms[v].onCycle) fails.push(`room ${v}: stub on a non-cycle room`);
      }
    }
  }

  const core = twoCore(n, d.edges);
  const { bridges, articulations } = findBridgesAndArticulations(n, d.edges, core);
  const coreBridges = bridges.filter(
    (i) => core.has(d.edges[i].a) && core.has(d.edges[i].b),
  );
  if (coreBridges.length) fails.push(`2-core has ${coreBridges.length} bridge(s)`);
  if (articulations.length) fails.push(`2-core has ${articulations.length} articulation point(s)`);

  const reach = bfsDistances(n, d.edges, 0);
  if (reach.some((x) => x === Infinity)) fails.push("graph is disconnected");

  // every chunk must be reachable from every entrance
  for (const e of d.entrances) {
    const dist = bfsDistances(n, d.edges, e);
    const missed = new Set<number>();
    d.rooms.forEach((r, i) => { if (dist[i] === Infinity) missed.add(r.chunk); });
    if (missed.size) {
      fails.push(`entrance ${e}: cannot reach chunk(s) ${[...missed].join(", ")}`);
    }
  }

  if (d.stats.maxDegree > maxDegree) {
    fails.push(`max degree ${d.stats.maxDegree} > ${maxDegree}`);
  }
  if (d.stats.circuitRank !== d.stats.interChunkEdges + 1) {
    fails.push("circuit rank != L + 1");
  }
  return fails;
}

// ---------------------------------------------------------------- generate

export function generate(seed: string, params: Params): Dungeon {
  const C = Math.max(1, params.chunks);
  const maxDegree = params.maxDegree ?? 4;
  const weights = params.cycleLengthWeights ?? [1, 2, 4, 3];
  const L = params.interChunkEdges ?? (C <= 1 ? 0 : C + Math.floor(C / 4));
  const doubleChance = params.doubleChance ?? 0.3;
  const maxChunkDegree = Math.min(6, params.maxChunkDegree ?? 4);
  const rng = makeRng(seed);

  const rooms: Room[] = [];
  const edges: Edge[] = [];
  const chunks: ChunkInfo[] = [];

  // chunk graph first: a chunk's stub count sets the floor on its cycle length
  const pairs = buildChunkMultigraph(C, L, doubleChance, maxChunkDegree, rng);
  const stubCount = chunkDegrees(C, pairs);

  for (let i = 0; i < C; i++) {
    chunks.push(buildChunkInterior(i, i * 6, rng, rooms, edges, weights, stubCount[i]));
  }

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const bump = (id: number) => { roomById.get(id)!.degree++; };
  for (const e of edges) { bump(e.a); bump(e.b); }

  const usedCycleIdx = new Map<number, number[]>();
  for (const [ca, cbIdx] of pairs) {
    const A = chunks[ca], B = chunks[cbIdx];
    const ra = pickStubRoom(A, usedCycleIdx, roomById, maxDegree, rng);
    const rb = pickStubRoom(B, usedCycleIdx, roomById, maxDegree, rng);
    usedCycleIdx.set(ca, [...(usedCycleIdx.get(ca) ?? []), roomById.get(ra)!.cycleIndex]);
    usedCycleIdx.set(cbIdx, [...(usedCycleIdx.get(cbIdx) ?? []), roomById.get(rb)!.cycleIndex]);
    edges.push({
      a: ra,
      b: rb,
      entityId: makeEntityId(),
      kind: "inter-chunk",
    });
    bump(ra); bump(rb);
  }

  initialPositions(chunks, rooms, rng);
  relax(rooms, edges, params.relaxIterations ?? 400);

  const hist: Record<number, number> = {};
  for (const r of rooms) hist[r.degree] = (hist[r.degree] ?? 0) + 1;
  const n = rooms.length;
  const stats: Stats = {
    rooms: n,
    edges: edges.length,
    edgesPerRoom: edges.length / n,
    circuitRank: edges.length - n + 1,
    interChunkEdges: edges.filter((e) => e.kind === "inter-chunk").length,
    degreeHistogram: hist,
    deadEndShare: (hist[1] ?? 0) / n,
    corridorShare: (hist[2] ?? 0) / n,
    junctionShare: rooms.filter((r) => r.degree >= 3).length / n,
    maxDegree: Math.max(...rooms.map((r) => r.degree)),
    cycleLengths: chunks.map((c) => c.cycleLen),
  };

  const dungeon: Dungeon = {
    seed,
    chunkCount: C,
    rooms,
    edges,
    entrances: [],
    stats,
    valid: false,
    failures: [],
  };
  dungeon.entrances = chooseEntrances(rooms, edges, C, rng);
  dungeon.failures = validate(dungeon, chunks, maxDegree);
  dungeon.valid = dungeon.failures.length === 0;
  return dungeon;
}

// ---------------------------------------------------------------- blueprint

/**
 * Project the internal graph onto the entity model that content generation
 * consumes. Phase A only knows structure, so name/base/state/composed are
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

/** Generate, advancing the seed until a dungeon passes validation. */
export function generateValid(
  seed: string,
  params: Params,
  maxAttempts = 50,
): { dungeon: Dungeon; attempts: number } {
  for (let i = 0; i < maxAttempts; i++) {
    const d = generate(i === 0 ? seed : `${seed}#${i}`, params);
    if (d.valid) return { dungeon: d, attempts: i + 1 };
  }
  return { dungeon: generate(seed, params), attempts: maxAttempts };
}

// ---------------------------------------------------------------- reporting

export function summarize(d: Dungeon): string {
  const s = d.stats;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const degrees = Object.keys(s.degreeHistogram)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => `  deg ${k}: ${s.degreeHistogram[k]}`)
    .join("\n");
  return [
    `seed="${d.seed}"  chunks=${d.chunkCount}  valid=${d.valid}`,
    `rooms=${s.rooms}  edges=${s.edges}  E/V=${s.edgesPerRoom.toFixed(3)}  mu=${s.circuitRank}  L=${s.interChunkEdges}`,
    `interior cycle lengths: [${s.cycleLengths.join(", ")}]`,
    `dead ends ${pct(s.deadEndShare)} | corridors ${pct(s.corridorShare)} | junctions ${pct(s.junctionShare)}`,
    degrees,
    `entrances: ${d.entrances.join(", ")}`,
    d.failures.length ? `FAILURES:\n  ${d.failures.join("\n  ")}` : `no validation failures`,
  ].join("\n");
}

export function toSvg(d: Dungeon, size = 760): string {
  const pad = 40;
  const xs = d.rooms.map((r) => r.pos.x), ys = d.rooms.map((r) => r.pos.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(
    (size - 2 * pad) / Math.max(maxX - minX, 1),
    (size - 2 * pad) / Math.max(maxY - minY, 1),
  );
  const px = (r: Room) => pad + (r.pos.x - minX) * scale;
  const py = (r: Room) => pad + (r.pos.y - minY) * scale;
  const byId = new Map(d.rooms.map((r) => [r.id, r]));

  const lines = d.edges
    .map((e) => {
      const a = byId.get(e.a)!, b = byId.get(e.b)!;
      const style =
        e.kind === "inter-chunk"
          ? 'stroke="#d85a30" stroke-width="2.4"'
          : 'stroke="#5f5e5a" stroke-width="1.4"';
      return `<line x1="${px(a).toFixed(1)}" y1="${py(a).toFixed(1)}" x2="${px(b).toFixed(1)}" y2="${py(b).toFixed(1)}" ${style}/>`;
    })
    .join("\n");

  const palette = ["#378ADD", "#1D9E75", "#7F77DD", "#BA7517", "#D4537E", "#639922", "#888780", "#E24B4A"];
  const nodes = d.rooms
    .map((r) => {
      const isEnt = d.entrances.includes(r.id);
      const fill = palette[r.chunk % palette.length];
      return `<circle cx="${px(r).toFixed(1)}" cy="${py(r).toFixed(1)}" r="${isEnt ? 13 : 10}" fill="${fill}" stroke="${isEnt ? "#111" : "#fff"}" stroke-width="${isEnt ? 3 : 1.5}"/>` +
        `<text x="${px(r).toFixed(1)}" y="${(py(r) + 3.5).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#fff">${r.id}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#faf9f5"/>\n${lines}\n${nodes}\n</svg>`;
}

// ---------------------------------------------------------------- demo

function batch(chunks: number, trials: number) {
  let valid = 0, totalAttempts = 0;
  const agg = { dead: 0, corr: 0, junc: 0, mu: 0, ev: 0, maxDeg: 0 };
  for (let i = 0; i < trials; i++) {
    const { dungeon, attempts } = generateValid(`batch-${chunks}-${i}`, { chunks });
    totalAttempts += attempts;
    if (dungeon.valid) valid++;
    agg.dead += dungeon.stats.deadEndShare;
    agg.corr += dungeon.stats.corridorShare;
    agg.junc += dungeon.stats.junctionShare;
    agg.mu += dungeon.stats.circuitRank;
    agg.ev += dungeon.stats.edgesPerRoom;
    agg.maxDeg = Math.max(agg.maxDeg, dungeon.stats.maxDegree);
  }
  const p = (x: number) => `${((x / trials) * 100).toFixed(1)}%`;
  console.log(
    `C=${chunks} V=${chunks * 6} | valid ${valid}/${trials} | avg attempts ${(totalAttempts / trials).toFixed(2)} | ` +
    `E/V ${(agg.ev / trials).toFixed(3)} | mu ${(agg.mu / trials).toFixed(1)} | ` +
    `dead ${p(agg.dead)} corr ${p(agg.corr)} junc ${p(agg.junc)} | maxdeg ${agg.maxDeg}`,
  );
}

if (process.argv[1] && process.argv[1].includes("dungeon-phase-a")) {
  const { dungeon } = generateValid("fractured-temple", { chunks: 4 });
  console.log(summarize(dungeon));
  console.log("\n--- distributions over 200 seeds per size ---");
  for (const c of [1, 2, 3, 4, 5, 6, 8]) batch(c, 200);
}
