import { describe, expect, it } from "vitest";
import { chooseGoal, generateBlueprint, routesOf, type Dungeon } from "./graph.ts";
import { shapeFor } from "../seeds.ts";
import type { Size } from "../content/blueprint.ts";

// ===========================================================================
// ROUTES  (the definition every check below leans on)
// ===========================================================================

const ring = (n: number) => Array.from({ length: n }, (_, i) => ({ a: i, b: (i + 1) % n }));

describe("routesOf", () => {
  it("finds both ways round a loop", () => {
    expect(routesOf(4, ring(4), 0, 2)).toHaveLength(2);
  });

  it("counts a detour onto a route as a bypass, not a second route", () => {
    // 0-1-2 with 0-3-1 alongside: 0,3,1,2 holds every room of 0,1,2
    const edges = [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 0, b: 3 }, { a: 3, b: 1 }];
    const routes = routesOf(4, edges, 0, 2);
    expect(routes.map((r) => [...r].sort())).toEqual([[0, 1, 2]]);
  });

  it("lets distinct routes share a choke point", () => {
    // a loop 0-1-2-3, then a corridor 2-4 to the goal: every route passes 2
    const edges = [...ring(4), { a: 2, b: 4 }];
    const routes = routesOf(5, edges, 0, 4);
    expect(routes).toHaveLength(2);
    for (const r of routes) expect(r.has(2)).toBe(true);
  });

  it("lists the shortest first", () => {
    const routes = routesOf(5, ring(5), 0, 2);
    expect(routes.map((r) => r.size)).toEqual([3, 4]);
  });
});

describe("chooseGoal", () => {
  it("is the room furthest from the entrance", () => {
    expect(chooseGoal(6, ring(6), 0)).toBe(3);
  });
});

// ===========================================================================
// THE CHECKS  (asserted from the graph itself, not read off `valid`)
// ===========================================================================

const ROOMS: Record<Size, [number, number]> = { 1: [5, 6], 2: [7, 9], 3: [10, 12] };
const SEEDS = ["1001", "1002", "1003", "1004", "1005", "7919", "42"];

function bypassable(d: Dungeon): boolean {
  const adj: number[][] = d.rooms.map(() => []);
  for (const e of d.edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }
  const dist = (from: number, without = -1) => {
    const out = d.rooms.map(() => Infinity);
    out[from] = 0;
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      for (const v of adj[q[h]]) {
        if (v === without || out[v] !== Infinity) continue;
        out[v] = out[q[h]] + 1;
        q.push(v);
      }
    }
    return out;
  };
  // rooms on SOME shortest route, each checked for a way round of at most two extra rooms
  const fromEntrance = dist(d.entrance), toGoal = dist(d.goal);
  const length = fromEntrance[d.goal];
  return d.rooms.some((_r, x) => {
    if (x === d.entrance || x === d.goal || fromEntrance[x] + toGoal[x] !== length) return false;
    return adj[x].some((p) =>
      adj[x].some((s) =>
        fromEntrance[p] === fromEntrance[x] - 1 && toGoal[s] === toGoal[x] - 1 && dist(p, x)[s] <= 4,
      ),
    );
  });
}

describe.each([1, 2, 3] as Size[])("graph generation at size %i", (size) => {
  const built = SEEDS.map((seed) => {
    const shape = shapeFor(size, seed);
    return { seed, shape, dungeon: generateBlueprint(seed, shape, true).dungeon };
  });

  it("validates on every seed", () => {
    for (const { seed, dungeon } of built) {
      expect(dungeon.valid, `seed ${seed}: ${dungeon.failures.join("; ")}`).toBe(true);
    }
  });

  it("has the size's room count and the shape's loop count", () => {
    const [lo, hi] = ROOMS[size];
    for (const { seed, shape, dungeon } of built) {
      expect(dungeon.rooms.length, `seed ${seed}`).toBeGreaterThanOrEqual(lo);
      expect(dungeon.rooms.length, `seed ${seed}`).toBeLessThanOrEqual(hi);
      expect(dungeon.rooms.length, `seed ${seed}`).toBe(shape.rooms);
      expect(dungeon.edges.length - dungeon.rooms.length + 1, `seed ${seed}`).toBe(shape.loops);
    }
  });

  it("is planar, with no room of more than four ways", () => {
    for (const { seed, dungeon } of built) {
      expect(dungeon.embedding, `seed ${seed}`).toBeDefined();
      for (const r of dungeon.rooms) expect(r.degree, `seed ${seed} room ${r.id}`).toBeLessThanOrEqual(4);
    }
  });

  it("keeps under the dead-end cap", () => {
    const cap = size === 3 ? 2 : 1;
    for (const { seed, dungeon } of built) {
      const dead = dungeon.rooms.filter((r) => r.degree === 1 && r.id !== dungeon.entrance).length;
      expect(dead, `seed ${seed}`).toBeLessThanOrEqual(cap);
    }
  });

  it("has enough distinct routes to the goal", () => {
    const need = size === 1 ? 2 : 3;
    for (const { seed, dungeon } of built) {
      const routes = routesOf(dungeon.rooms.length, dungeon.edges, dungeon.entrance, dungeon.goal);
      expect(routes.length, `seed ${seed}`).toBeGreaterThanOrEqual(need);
    }
  });

  it.runIf(size > 1)("has a bypass and balanced routes", () => {
    for (const { seed, dungeon } of built) {
      expect(bypassable(dungeon), `seed ${seed}: no bypass`).toBe(true);
      const [first, second] = routesOf(dungeon.rooms.length, dungeon.edges, dungeon.entrance, dungeon.goal);
      expect(second.size - first.size, `seed ${seed}`).toBeLessThanOrEqual(2);
    }
  });

  it("starts the player in a room with a choice of ways", () => {
    for (const { seed, dungeon } of built) {
      expect(dungeon.rooms[dungeon.entrance].degree, `seed ${seed}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("marks as shortcuts only ways whose rooms had another way round", () => {
    for (const { seed, dungeon } of built) {
      dungeon.edges.forEach((e, i) => {
        if (!e.shortcut) return;
        const rest = dungeon.edges.filter((_x, j) => j !== i);
        expect(routesOf(dungeon.rooms.length, rest, e.a, e.b).length, `seed ${seed}`).toBeGreaterThan(0);
      });
    }
  });

  it("rolls the same shape from the same seed, so a retry keeps it", () => {
    for (const { seed, shape } of built) {
      expect(shapeFor(size, seed)).toEqual(shape);
    }
  });
});
