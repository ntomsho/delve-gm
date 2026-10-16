/**
 * STOCKING: which rooms are corridors.
 *
 * Corridors are designated in stocking, before identity, so the drawing can
 * treat them as the rooms that stretch. Checked here over the stocked dungeon
 * alone; nothing is drawn.
 */

import { describe, expect, it } from "vitest";
import { generateBlueprintSeed, type Size } from "../blueprint.ts";
import { DUNGEON_CORRIDORS } from "../../../rules/maze-rats/tables.ts";
import { generateBlueprint, type Dungeon } from "../../floorplan/graph.ts";
import { stockDungeon } from "./stock.ts";
import type { StockedDungeon } from "../types.ts";

function build(seed: number, size: Size): { graph: Dungeon; sd: StockedDungeon } {
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  const bp = generateBlueprintSeed(size, seed, 1);
  return { graph: dungeon, sd: stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 }) };
}

// ===========================================================================
// CORRIDORS  (designated in stocking, before identity)
// ===========================================================================

describe("corridor designation", () => {
  const sizes: Size[] = [1, 2, 3, 4, 5];

  it.each(sizes)("size %i draws N-1 / N / N+1 at roughly 25 / 50 / 25", (size) => {
    const counts = new Map<number, number>();
    // Enough to see a 25/50/25 split with the loose bounds below; this is a
    // distribution check, not an estimate of the distribution.
    const N = 48;
    for (let i = 0; i < N; i++) {
      const n = build(3000 + i, size).sd.rooms.filter((r) => r.isCorridor).length;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }

    if (size === 1) {
      // A coin flip between none and one.
      expect([...counts.keys()].sort()).toEqual([0, 1]);
      expect(counts.get(1)! / N).toBeGreaterThan(0.35);
      expect(counts.get(1)! / N).toBeLessThan(0.65);
      return;
    }

    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([size - 1, size, size + 1]);
    // Bounds are loose because the sample is small on purpose — see the cost
    // note at the top. This asks "is it roughly 25/50/25", not "what is it".
    expect(counts.get(size)! / N, "the middle case is about half").toBeGreaterThan(0.35);
    expect(counts.get(size)! / N).toBeLessThan(0.65);
    expect(counts.get(size - 1)! / N).toBeGreaterThan(0.1);
    expect(counts.get(size + 1)! / N).toBeGreaterThan(0.1);
  });

  it("never picks a dead end, the goal room, or a room beside another corridor", () => {
    for (const size of sizes) {
      for (let i = 0; i < 6; i++) {
        const { graph, sd } = build(4000 + i, size);
        const corridors = sd.rooms.filter((r) => r.isCorridor);
        for (const r of corridors) {
          expect(r.degree, "a corridor connects somewhere").toBeGreaterThanOrEqual(2);
          expect(r.role, "the goal is never a passage").not.toBe("goal");
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
    // rules out is every corridor in a size-5 dungeon sitting at one depth.
    const bands = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const { sd } = build(5000 + i, 5);
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
