/**
 * STOCKING: which rooms are corridors, and which ways are gated.
 *
 * Corridors are designated in stocking, before identity, so the drawing can
 * treat them as the rooms that stretch. Checked here over the stocked dungeon
 * alone; nothing is drawn.
 */

import { describe, expect, it } from "vitest";
import { shapeFor } from "../../seeds.ts";
import { generateBlueprintSeed, type Size } from "../blueprint.ts";
import { DUNGEON_CORRIDORS } from "../../../rules/maze-rats/tables.ts";
import { generateBlueprint, routesOf, type Dungeon } from "../../floorplan/graph.ts";
import { stockDungeon } from "./stock.ts";
import type { StockedDungeon } from "../types.ts";

function build(seed: number, size: Size): { graph: Dungeon; sd: StockedDungeon } {
  const { dungeon } = generateBlueprint(String(seed), shapeFor(size, String(seed)), true);
  const bp = generateBlueprintSeed(size, seed, 1);
  return { graph: dungeon, sd: stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 }) };
}

// ===========================================================================
// CORRIDORS  (designated in stocking, before identity)
// ===========================================================================

describe("corridor designation", () => {
  const sizes: Size[] = [1, 2, 3];

  it.each(sizes)("size %i draws N-1 / N / N+1 at roughly 25 / 50 / 25, N a sixth of the rooms", (size) => {
    // Keyed by the offset from N, because N moves with each dungeon's room count.
    const counts = new Map<number, number>();
    // Enough to see a 25/50/25 split with the loose bounds below; this is a
    // distribution check, not an estimate of the distribution.
    const N = 48;
    for (let i = 0; i < N; i++) {
      const { sd } = build(3000 + i, size);
      const n = sd.rooms.filter((r) => r.isCorridor).length;
      const key = sd.rooms.length <= 6 ? n : n - Math.round(sd.rooms.length / 6);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    if (size === 1) {
      // A coin flip between none and one.
      expect([...counts.keys()].sort()).toEqual([0, 1]);
      expect(counts.get(1)! / N).toBeGreaterThan(0.35);
      expect(counts.get(1)! / N).toBeLessThan(0.65);
      return;
    }

    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([-1, 0, 1]);
    // Bounds are loose because the sample is small on purpose — see the cost
    // note at the top. This asks "is it roughly 25/50/25", not "what is it".
    expect(counts.get(0)! / N, "the middle case is about half").toBeGreaterThan(0.35);
    expect(counts.get(0)! / N).toBeLessThan(0.65);
    expect(counts.get(-1)! / N).toBeGreaterThan(0.1);
    expect(counts.get(1)! / N).toBeGreaterThan(0.1);
  });

  it("never picks a dead end, the entrance, the goal room, or a room beside another corridor", () => {
    for (const size of sizes) {
      for (let i = 0; i < 6; i++) {
        const { graph, sd } = build(4000 + i, size);
        const corridors = sd.rooms.filter((r) => r.isCorridor);
        for (const r of corridors) {
          expect(r.degree, "a corridor connects somewhere").toBeGreaterThanOrEqual(2);
          expect(r.role, "the way in and the objective are places, not passages").toBe("normal");
        }
        const ids = new Set(corridors.map((r) => r.index));
        for (const e of graph.edges) {
          expect(
            ids.has(e.a) && ids.has(e.b),
            "two corridors in a row is one hallway with a pointless door in it"
          ).toBe(false);
        }
      }
    }
  });

  it("spreads them along the way in rather than clumping at one depth", () => {
    // Weak by design: the rule is a distribution, not a placement. What it
    // rules out is every corridor in a large dungeon sitting at one depth.
    const bands = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const { sd } = build(5000 + i, 3);
      const maxDepth = sd.maxDepth || 1;
      for (const r of sd.rooms) {
        if (r.isCorridor) bands.add(Math.min(2, Math.floor((r.depth / maxDepth) * 3)));
      }
    }
    expect(bands.size, "all three depth bands are used").toBe(3);
  });

  it("rolls its identity on the corridors table, not the rooms table", () => {
    const table = new Set(DUNGEON_CORRIDORS);
    let seen = 0;
    for (let i = 0; i < 8; i++) {
      for (const r of build(6000 + i, 3).sd.rooms) {
        if (!r.isCorridor) continue;
        expect(table.has(r.identity), `${r.identity} is not on the corridors table`).toBe(true);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(10);
  });
});

// ===========================================================================
// GATES AND ROUTES  (gateConnectors, after the graph's route checks)
// ===========================================================================

describe("gates and routes", () => {
  const CASES = ([1, 2, 3] as Size[]).flatMap((size) =>
    Array.from({ length: 12 }, (_, i) => ({ size, seed: 6100 + i, ...build(6100 + i, size) })),
  );

  const reachable = (graph: Dungeon, open: (i: number) => boolean, from: number, to: number) => {
    const seen = new Set([from]);
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      graph.edges.forEach((e, i) => {
        if (!open(i)) return;
        const next = e.a === q[h] ? e.b : e.b === q[h] ? e.a : -1;
        if (next !== -1 && !seen.has(next)) { seen.add(next); q.push(next); }
      });
    }
    return seen.has(to);
  };

  it("never makes the goal reachable only through a hidden way", () => {
    for (const { size, seed, graph, sd } of CASES) {
      const open = (i: number) => !sd.connectors[i].hidden;
      expect(reachable(graph, open, graph.entrance, graph.goal), `size ${size} seed ${seed}`).toBe(true);
    }
  });

  it("leaves a route open, or gates the two shortest routes differently", () => {
    for (const { size, seed, graph, sd } of CASES) {
      const routes = routesOf(graph.rooms.length, graph.edges, graph.entrance, graph.goal);
      const kinds = routes.map((route) => {
        const on = new Set<string>();
        graph.edges.forEach((e, i) => {
          if (!route.has(e.a) || !route.has(e.b)) return;
          const c = sd.connectors[i];
          if (c.hidden) on.add(c.gated ? "hidden and blocked" : "hidden");
          else if (c.gated) on.add("blocked");
        });
        return [...on].sort().join(",");
      });
      const ok = kinds.some((k) => k === "") || kinds[0] !== kinds[1];
      expect(ok, `size ${size} seed ${seed}: ${JSON.stringify(kinds)}`).toBe(true);
    }
  });

  it("conceals shortcuts far more often than other ways", () => {
    let shortcuts = 0, hiddenShortcuts = 0, others = 0, hiddenOthers = 0;
    for (const { graph, sd } of CASES) {
      graph.edges.forEach((e, i) => {
        if (e.shortcut) { shortcuts++; if (sd.connectors[i].hidden) hiddenShortcuts++; }
        else { others++; if (sd.connectors[i].hidden) hiddenOthers++; }
      });
    }
    expect(shortcuts, "the sample has shortcuts to conceal").toBeGreaterThan(5);
    expect(hiddenShortcuts / shortcuts).toBeGreaterThan(3 * (hiddenOthers / others));
  });
});
