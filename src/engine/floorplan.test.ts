import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  AREA,
  BUILDING_ROOMS,
  DUNGEON_CORRIDORS,
  DUNGEON_ROOMS,
  LOWER_CLASS_BUILDINGS,
  UPPER_CLASS_BUILDINGS,
  floorplanSvg,
  generateBlueprint,
  generateBlueprintSeed,
  generateFloorplan,
  generateFloorplanValid,
  stockDungeon,
  traceOutline,
  validateFloorplan,
  type Dungeon,
  type Size,
  type StockedDungeon,
} from "./index.ts";

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
    const N = 120;
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
    expect(counts.get(size)! / N, "the middle case is half of them").toBeGreaterThan(0.4);
    expect(counts.get(size)! / N).toBeLessThan(0.6);
    expect(counts.get(size - 1)! / N).toBeGreaterThan(0.15);
    expect(counts.get(size + 1)! / N).toBeGreaterThan(0.15);
  });

  it("never picks a dead end, the goal room, or a room beside another corridor", () => {
    for (const size of sizes) {
      for (let i = 0; i < 15; i++) {
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
    for (let i = 0; i < 15; i++) {
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
    for (let i = 0; i < 20; i++) {
      for (const r of build(6000 + i, 3).sd.rooms) {
        if (!r.isCorridor) continue;
        expect(table.has(r.identity), `${r.identity} is not on the corridors table`).toBe(true);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(25);
  });
});

// ===========================================================================
// THE ARCHETYPE TABLE
// ===========================================================================

describe("chamber archetypes", () => {
  it("keys only nouns that can actually roll", () => {
    // An annotation keyed on a noun that never rolls is dead weight that looks
    // live — which is how `Silo`, `Tidal cave` and `Sinkhole` got cut. Cascades
    // resolve inline, so the reachable set is the four tables with the {braces}
    // entries stripped.
    const reachable = new Set(
      [...DUNGEON_ROOMS, ...BUILDING_ROOMS, ...LOWER_CLASS_BUILDINGS, ...UPPER_CLASS_BUILDINGS]
        .filter((e) => !e.startsWith("{"))
    );
    const unreachable = Object.keys(ARCHETYPES).filter((k) => !reachable.has(k));
    expect(unreachable).toEqual([]);
  });

  it("leaves most of the nouns to fall through to a roll", () => {
    // Monotony is the failure mode to design against, not inaccuracy: the
    // unannotated ~90 still roll among the size classes.
    expect(Object.keys(ARCHETYPES).length).toBeLessThan(50);
    expect(Object.keys(ARCHETYPES).length).toBeGreaterThan(30);
  });

  it("has bands that do not overlap and do not invert", () => {
    const bands = Object.values(AREA);
    for (const [lo, hi] of bands) expect(lo).toBeLessThan(hi);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i][0], "each band starts above the last one's top").toBeGreaterThan(
        bands[i - 1][1]
      );
    }
  });
});

// ===========================================================================
// THE PLAN
// ===========================================================================

describe("floorplan", () => {
  // Sizes 1 and 2 are the ones the packer reliably draws. Whether it draws at
  // all is measured at the bottom of this file rather than asserted away here.
  const cases: Array<[Size, number]> = [
    [1, 7001], [1, 7002], [1, 7003],
    [2, 7004], [2, 7005], [2, 7006],
  ];

  it.each(cases)("size %i seed %i draws a sound plan", (size, seed) => {
    const { graph, sd } = build(seed, size);
    const fp = generateFloorplanValid(graph, sd, { seed, attempts: 24 });
    expect(fp, "no plan drawn").not.toBeNull();
    expect(validateFloorplan(fp!, graph, sd)).toEqual([]);
  });

  /**
   * The guarantee the packer actually makes. It does not promise to draw every
   * graph — see the rates below — but a plan it hands back is sound: nothing
   * overlaps, every footprint is one piece, every connector has exactly one
   * door and that door is in a wall its two rooms really share.
   */
  it("never returns an unsound plan, at any size", () => {
    let drawn = 0;
    for (const size of [1, 2, 3, 4, 5] as Size[]) {
      for (let i = 0; i < 4; i++) {
        const { graph, sd } = build(9100 + i, size);
        const fp = generateFloorplan(graph, sd, { seed: 41 + i });
        if (!fp) continue;
        drawn++;
        expect(validateFloorplan(fp, graph, sd), `size ${size} seed ${9100 + i}`).toEqual([]);
      }
    }
    expect(drawn, "nothing drew at all, so this asserted nothing").toBeGreaterThan(4);
  }, 30_000);

  it("gives every room a footprint and every connector one door", () => {
    const { graph, sd } = build(7004, 2);
    const fp = generateFloorplanValid(graph, sd, { seed: 7004, attempts: 40 })!;
    expect(fp.rooms.map((r) => r.roomId).sort()).toEqual(sd.rooms.map((r) => r.roomId).sort());
    expect(fp.doors.map((d) => d.connectorId).sort()).toEqual(
      sd.connectors.map((c) => c.id).sort()
    );
  });

  it("keeps every chamber at or above its degree's floor", () => {
    const { graph, sd } = build(7005, 2);
    const fp = generateFloorplanValid(graph, sd, { seed: 7005, attempts: 40 })!;
    const rank = { tiny: 1, small: 2, medium: 3, large: 4, vast: 5 };
    for (const room of fp.rooms) {
      if (room.isCorridor) continue;
      const stock = sd.rooms.find((r) => r.roomId === room.roomId)!;
      expect(rank[room.sizeClass!], `${room.roomId} deg ${stock.degree}`).toBeGreaterThanOrEqual(
        stock.degree - 1
      );
    }
  });

  it("is deterministic for a layout seed", () => {
    const { graph, sd } = build(7004, 2);
    const a = generateFloorplan(graph, sd, { seed: 99 });
    const b = generateFloorplan(graph, sd, { seed: 99 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("draws to SVG, one outline per room", () => {
    const { graph, sd } = build(7001, 1);
    const fp = generateFloorplanValid(graph, sd, { seed: 7001, attempts: 40 })!;
    const svg = floorplanSvg(fp);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.match(/<polygon/g)).toHaveLength(fp.rooms.length);
    expect(svg).not.toContain("NaN");
  });
});

// ===========================================================================
// OUTLINES
// ===========================================================================

describe("traceOutline", () => {
  const rect = (w: number, h: number) => {
    const out = [];
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) out.push({ x, y });
    return out;
  };

  it("reduces a rectangle to its four corners", () => {
    expect(traceOutline(rect(4, 3))).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ]);
  });

  it("turns a corner for an L", () => {
    const cells = [...rect(4, 1), { x: 0, y: 1 }, { x: 0, y: 2 }];
    const out = traceOutline(cells);
    expect(out).toHaveLength(6);
    // Axis-aligned throughout: consecutive points share an x or a y.
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it("says nothing about nothing", () => {
    expect(traceOutline([])).toEqual([]);
  });
});

// ===========================================================================
// WHAT THE PACKER COSTS  (§6a: measured, not assumed)
// ===========================================================================

describe("floorplan: how often it draws", () => {
  /**
   * Placement is the high-risk half of 6a and this is the number that says so.
   * A plan is attempted from one layout seed; `generateFloorplanValid` advances
   * the seed, so the per-attempt rate compounds. It falls off a cliff between
   * size 3 and size 4, which is why `GeneratedDungeon.floorplan` is nullable
   * and why the map is an enhancement rather than a dependency.
   */
  const rate = (size: Size, dungeons: number, attempts: number) => {
    let hits = 0;
    for (let i = 0; i < dungeons; i++) {
      const { graph, sd } = build(8000 + i, size);
      for (let a = 0; a < attempts; a++) {
        if (generateFloorplan(graph, sd, { seed: 500 + i * 31 + a * 7919 })) hits++;
      }
    }
    return hits / (dungeons * attempts);
  };

  it("draws sizes 1 and 2 readily", () => {
    expect(rate(1, 6, 3), "size 1").toBeGreaterThan(0.8);
    expect(rate(2, 6, 3), "size 2").toBeGreaterThan(0.25);
  }, 30_000);

  it("still draws size 3 often enough for the retry loop to close it", () => {
    // ~12% per attempt measured over 15 dungeons x 8 attempts, so the default
    // 24 attempts closes it about 95% of the time.
    expect(rate(3, 5, 4), "size 3").toBeGreaterThan(0.02);
  }, 30_000);
});
