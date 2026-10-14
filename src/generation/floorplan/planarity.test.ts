import { describe, expect, it } from "vitest";
import { checkPlanarity, type Pair, type PlanarityResult } from "./planarity.ts";
import { generate as generateGraph, generateValid, type Dungeon } from "./graph.ts";

// ===========================================================================
// HARNESS
// ===========================================================================

interface G {
  n: number;
  edges: Pair[];
}

const complete = (k: number): G => {
  const edges: Pair[] = [];
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) edges.push([a, b]);
  return { n: k, edges };
};

const bipartite = (p: number, q: number): G => {
  const edges: Pair[] = [];
  for (let a = 0; a < p; a++) for (let b = 0; b < q; b++) edges.push([a, p + b]);
  return { n: p + q, edges };
};

const cycle = (k: number): G => ({
  n: k,
  edges: Array.from({ length: k }, (_, i) => [i, (i + 1) % k] as Pair),
});

const star = (k: number): G => ({
  n: k + 1,
  edges: Array.from({ length: k }, (_, i) => [0, i + 1] as Pair),
});

const without = (g: G, drop: number): G => ({
  n: g.n,
  edges: g.edges.filter((_, i) => i !== drop),
});

/** Put a new vertex in the middle of every edge. Cannot change planarity. */
const subdivideAll = (g: G): G => {
  const edges: Pair[] = [];
  let next = g.n;
  for (const [a, b] of g.edges) {
    edges.push([a, next], [next, b]);
    next++;
  }
  return { n: next, edges };
};

/** Two graphs sharing exactly one vertex — a cut vertex, hence two blocks. */
const glue = (g1: G, g2: G): G => ({
  n: g1.n + g2.n - 1,
  edges: [
    ...g1.edges,
    ...g2.edges.map(([a, b]) => [shift(a, g1.n), shift(b, g1.n)] as Pair),
  ],
});
const shift = (v: number, by: number) => (v === 0 ? 0 : v + by - 1);

const petersen: G = {
  n: 10,
  edges: [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 0],
    [0, 5], [1, 6], [2, 7], [3, 8], [4, 9],
    [5, 7], [7, 9], [9, 6], [6, 8], [8, 5],
  ],
};

const cube: G = {
  n: 8,
  edges: (() => {
    const edges: Pair[] = [];
    for (let a = 0; a < 8; a++) {
      for (let bit = 1; bit < 8; bit <<= 1) {
        const b = a ^ bit;
        if (b > a) edges.push([a, b]);
      }
    }
    return edges;
  })(),
};

/** K2,2,2 — the octahedron, K6 minus a perfect matching. */
const octahedron: G = {
  n: 6,
  edges: complete(6).edges.filter(([a, b]) => !(b === a + 1 && a % 2 === 0)),
};

/** A triangle with one of its edges doubled. */
const doubledTriangle: G = {
  n: 3,
  edges: [[0, 1], [1, 2], [2, 0], [0, 1]],
};

/**
 * Count the faces the returned rotation actually traces out.
 *
 * A rotation system is only an embedding if walking it closes up into faces,
 * so this is the check that matters: `planar: true` with a rotation that does
 * not trace is worse than a refusal, because the packer would follow it and
 * fail much later and much less legibly.
 *
 * Walk directed edges: arrive at v along e, leave along the edge after e in
 * v's cyclic order. Every directed edge belongs to exactly one face.
 */
function faceCount(g: G, rotation: number[][]): number {
  const posAt: Array<Map<number, number>> = rotation.map((order) => {
    const m = new Map<number, number>();
    order.forEach((e, i) => m.set(e, i));
    return m;
  });
  const other = (e: number, from: number) => (g.edges[e][0] === from ? g.edges[e][1] : g.edges[e][0]);

  const seen = new Set<string>();
  let faces = 0;
  for (let e = 0; e < g.edges.length; e++) {
    for (const from of [g.edges[e][0], g.edges[e][1]]) {
      if (seen.has(`${e}:${from}`)) continue;
      faces++;
      let ce = e;
      let cf = from;
      for (;;) {
        const k = `${ce}:${cf}`;
        if (seen.has(k)) break;
        seen.add(k);
        const v = other(ce, cf);
        const order = rotation[v];
        const i = posAt[v].get(ce);
        expect(i, `edge ${ce} missing from the rotation at ${v}`).toBeDefined();
        ce = order[(i! + 1) % order.length];
        cf = v;
      }
    }
  }
  return faces;
}

function components(g: G): number {
  const parent = Array.from({ length: g.n }, (_, i) => i);
  const find = (v: number): number => (parent[v] === v ? v : (parent[v] = find(parent[v])));
  for (const [a, b] of g.edges) parent[find(a)] = find(b);
  return new Set(Array.from({ length: g.n }, (_, i) => find(i))).size;
}

/** Euler: V - E + F = 1 + C for any embedding of a planar graph in the plane. */
function expectEuler(g: G, res: PlanarityResult) {
  expect(res.planar).toBe(true);
  const f = faceCount(g, res.rotation);
  expect(g.n - g.edges.length + f, "V - E + F should be 1 + components").toBe(1 + components(g));
}

// ===========================================================================
// THE KNOWN GRAPHS
// ===========================================================================

describe("planarity: graphs with a known answer", () => {
  const nonPlanar: Array<[string, G]> = [
    ["K5", complete(5)],
    ["K3,3", bipartite(3, 3)],
    ["Petersen", petersen],
    ["a subdivided K5", subdivideAll(complete(5))],
    ["a subdivided K3,3", subdivideAll(bipartite(3, 3))],
    ["two K5s at a cut vertex", glue(complete(5), complete(5))],
    ["a K5 with a tree hanging off it", glue(complete(5), star(3))],
  ];

  const planar: Array<[string, G]> = [
    ["K4", complete(4)],
    ["K5 minus an edge", without(complete(5), 0)],
    ["K3,3 minus an edge", without(bipartite(3, 3), 4)],
    ["the cube", cube],
    ["the octahedron", octahedron],
    ["two K4s at a cut vertex", glue(complete(4), complete(4))],
    ["a star", star(6)],
    ["a hexagon", cycle(6)],
    ["a triangle with a doubled edge", doubledTriangle],
    ["a triangle with a tail", glue(cycle(3), star(2))],
    ["nothing at all", { n: 0, edges: [] }],
  ];

  it.each(nonPlanar)("refuses %s", (_name, g) => {
    const res = checkPlanarity(g.n, g.edges);
    expect(res.planar).toBe(false);
    expect(res.rotation).toEqual([]);
  });

  it.each(planar)("embeds %s, and the rotation traces to Euler", (_name, g) => {
    const res = checkPlanarity(g.n, g.edges);
    expect(res.planar).toBe(true);
    if (g.n > 0) expectEuler(g, res);
  });

  it("puts every edge in the rotation of both its endpoints", () => {
    const g = cube;
    const { rotation } = checkPlanarity(g.n, g.edges);
    g.edges.forEach(([a, b], i) => {
      expect(rotation[a], `edge ${i} at ${a}`).toContain(i);
      expect(rotation[b], `edge ${i} at ${b}`).toContain(i);
    });
    expect(rotation.flat()).toHaveLength(g.edges.length * 2);
  });

  it("keeps parallel edges next to each other", () => {
    const { rotation } = checkPlanarity(doubledTriangle.n, doubledTriangle.edges);
    // edges 0 and 3 both join 0-1; they must be adjacent in both rotations
    for (const v of [0, 1]) {
      const i = rotation[v].indexOf(0);
      const j = rotation[v].indexOf(3);
      const gap = Math.abs(i - j);
      expect(gap === 1 || gap === rotation[v].length - 1, `at vertex ${v}`).toBe(true);
    }
  });
});

// ===========================================================================
// THE DUNGEON GRAPH
// ===========================================================================

const asGraph = (d: Dungeon): G => ({
  n: d.rooms.length,
  edges: d.edges.map((e) => [e.a, e.b] as Pair),
});

describe("planarity: generated dungeons", () => {
  const sizes = [1, 2, 3, 4, 5];
  const seeds = ["1001", "1002", "1003", "1004", "1005", "7919", "42"];

  it.each(sizes)("every valid dungeon at size %i carries a traceable embedding", (chunks) => {
    for (const seed of seeds) {
      const { dungeon } = generateValid(seed, { chunks });
      expect(dungeon.valid, `seed ${seed}: ${dungeon.failures.join("; ")}`).toBe(true);
      expect(dungeon.embedding, `seed ${seed} has no embedding`).toBeDefined();
      expectEuler(asGraph(dungeon), { planar: true, rotation: dungeon.embedding! });
    }
  });

  it("a room's embedding lists exactly its own connectors", () => {
    const { dungeon } = generateValid("1005", { chunks: 4 });
    dungeon.rooms.forEach((r, v) => {
      const incident = dungeon.edges.flatMap((e, i) => (e.a === v || e.b === v ? [i] : []));
      expect([...dungeon.embedding![v]].sort()).toEqual([...incident].sort());
      expect(dungeon.embedding![v]).toHaveLength(r.degree);
    });
  });
});

// ===========================================================================
// THE COST OF REJECTING  (§6a: measured, not assumed)
// ===========================================================================

describe("planarity: rejection rate", () => {
  const TRIALS = 200;

  const rate = (chunks: number) => {
    let nonPlanar = 0;
    for (let i = 0; i < TRIALS; i++) {
      if (!generateGraph(`rate-${i}`, { chunks }).embedding) nonPlanar++;
    }
    return nonPlanar / TRIALS;
  };

  it("is zero at sizes 1-3, where the graph is too sparse to tangle", () => {
    for (const chunks of [1, 2, 3]) expect(rate(chunks), `size ${chunks}`).toBe(0);
  });

  it("stays in single figures at sizes 4-5", () => {
    // 3.5% and 10.0% measured over 1000 seeds per size with this checker. Seeds
    // are deterministic, so these are fixed numbers rather than samples; the
    // band exists so a change to graph generation surfaces as a rate move
    // rather than silently.
    expect(rate(4), "size 4").toBeLessThan(0.08);
    expect(rate(5), "size 5").toBeLessThan(0.16);
  });

  it("costs about a fifth of a generation to retry past", () => {
    let total = 0;
    let worst = 0;
    for (let i = 0; i < TRIALS; i++) {
      const { attempts } = generateValid(`attempts-${i}`, { chunks: 5 });
      total += attempts;
      worst = Math.max(worst, attempts);
    }
    expect(total / TRIALS, "mean attempts at size 5").toBeLessThan(1.5);
    expect(worst, "worst attempts at size 5").toBeLessThan(6);
  });
});
