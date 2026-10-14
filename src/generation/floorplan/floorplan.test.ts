/**
 * THE 6a PACKER'S SUITE — MOSTLY PARKED.
 *
 * `blockplan.ts` draws the dungeon now (§6a.3). The packer in
 * `floorplan.ts` — `generateFloorplan`, `generateFloorplanValid`,
 * `validateFloorplan`, `floorplanSvg`, the family/relief carving and its own
 * `traceOutline` — has no caller left anywhere in the generation path.
 *
 * It is kept, at the author's direction, as the record of a design that lost;
 * its rationale is in CODING-PLAN §6a.2, and the size vocabulary that outlived
 * it was already lifted into `room-size.ts`. What is NOT kept is the
 * cost: four of the suites below are `describe.skip` because drawing a hundred
 * rooms on every `npm test` to check code nothing calls is time spent on the
 * past. The module still typechecks, so it cannot silently rot.
 *
 * TWO SUITES ARE STILL LIVE and must stay that way — they cover code the game
 * runs: `corridor designation` (stocking, `stock.ts`) and
 * `chamber archetypes` (the vocabulary in `room-size.ts`, which the
 * identity roll reads through `sizeAllows`). Neither touches the packer.
 *
 * The live `traceOutline` is `generation/floorplan/map-layout.ts`'s and is covered by
 * `map-layout.test.ts`; the one skipped here is the engine's dead copy.
 */

import { describe, expect, it } from "vitest";
import { ARCHETYPES, AREA } from "./room-size.ts";
import {
  BOX_CAP,
  ROUND_MAX_DEGREE,
  floorplanSvg,
  generateFloorplan,
  generateFloorplanValid,
  traceOutline,
  validateFloorplan,
  type FloorplanRoom,
} from "./floorplan.ts";
import {
  BUILDING_ROOMS,
  DUNGEON_CORRIDORS,
  DUNGEON_ROOMS,
  LOWER_CLASS_BUILDINGS,
  UPPER_CLASS_BUILDINGS,
  generateBlueprintSeed,
  type Size,
} from "../content/blueprint.ts";
import { generateBlueprint, type Dungeon } from "./graph.ts";
import { stockDungeon, type StockedDungeon } from "../content/stock.ts";

function build(seed: number, size: Size): { graph: Dungeon; sd: StockedDungeon } {
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  const bp = generateBlueprintSeed(size, seed, 1);
  return { graph: dungeon, sd: stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 }) };
}

/**
 * COST DISCIPLINE. Drawing is by far the most expensive thing in this file and
 * it gets worse with size: a size-1 attempt is milliseconds, a size-5 attempt is
 * seconds, and the retry loop multiplies whatever that is by up to 24. So the
 * suite draws at sizes 1 and 2 and nowhere else, and everything that wants a
 * pile of drawn rooms reads the same corpus rather than building its own.
 *
 * The real draw-rate numbers are a MEASUREMENT, not a test. They belong in a
 * profiling script that can take minutes; asserting them here would mean paying
 * for them on every run to learn something that changes only when the packer
 * does. What stays here is the cheap, load-bearing question — that a plan handed
 * back is sound — which needs one drawn plan, not a hundred.
 */
interface Drawn {
  room: FloorplanRoom;
  stock: StockedDungeon["rooms"][number];
}
let CORPUS: Drawn[] | null = null;

function corpus(): Drawn[] {
  if (CORPUS) return CORPUS;
  const out: Drawn[] = [];
  // Size 1 only, which draws on the first attempt and costs milliseconds. The
  // packer is no longer on the generation path — `blockplan.ts` draws
  // the dungeon now — so this suite exists to keep the shape work honest, not to
  // exercise placement, and it has no business costing minutes to do that.
  // Twenty size-1 dungeons still yield ~100 chambers, which is what the
  // distribution assertions need.
  for (const [size, n] of [[1, 20]] as Array<[Size, number]>) {
    for (let i = 0; i < n; i++) {
      const { graph, sd } = build(2100 + i, size);
      const fp = generateFloorplanValid(graph, sd, { seed: 61 + i * 13, attempts: 12 });
      if (!fp) continue;
      const byId = new Map(sd.rooms.map((r) => [r.roomId, r]));
      for (const room of fp.rooms) out.push({ room, stock: byId.get(room.roomId)! });
    }
  }
  CORPUS = out;
  return out;
}

const chambers = () => corpus().filter((d) => !d.room.isCorridor);

// The corpus used to be built in a top-level `beforeAll`, so it was charged
// here rather than to whichever test happened to touch it first. With the
// packer's suites parked (below) nothing asks for it, and a `beforeAll` would
// build a hundred drawn rooms for four skipped describes. `corpus()` is
// memoised and lazy, so removing it costs nothing if a suite is ever unskipped —
// the first test through pays instead, and can take a timeout of its own.

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

  it("has bands that are contiguous and do not invert", () => {
    // 6a left gaps between the bands — 9 to 12, 36 to 42 — and they were a
    // direct cause of the size-4/5 packing failure: a room pinned between two
    // fixed neighbours has its width dictated, and if the only areas it can
    // reach land in a hole there is no legal room at all.
    const bands = Object.values(AREA);
    for (const [lo, hi] of bands) expect(lo).toBeLessThan(hi);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i][0], "each band starts where the last one stopped").toBe(bands[i - 1][1] + 1);
    }
  });

  it("constrains only the axes each group means", () => {
    // The variety comes from what is left free. A pin on every axis would make
    // every Well the same room.
    expect(ARCHETYPES["Banquet hall"]).toEqual({ proportion: "long" });
    expect(ARCHETYPES.Cavern).toEqual({ relief: 2 });
    expect(ARCHETYPES.Well.family).toEqual(["round"]);
    expect(ARCHETYPES.Well.proportion, "a well may be a circle or an oval").toBeUndefined();
  });
});

// ===========================================================================
// THE SHAPE AXES  (§6a.2)
// ===========================================================================

describe.skip("room shape", () => {
  it("gives every chamber a shape and every corridor none", () => {
    for (const { room } of corpus()) {
      if (room.isCorridor) expect(room.shape, `${room.roomId}`).toBeUndefined();
      else expect(room.shape, `${room.roomId}`).toBeDefined();
    }
  });

  /**
   * The number this session exists to move. 6a drew 86% of chambers as plain
   * rectangles, measured over 728 of them, because `round` was rendered as a
   * square, L/T/cross were never built for chambers at all, and the carve was
   * guarded so tightly it usually did nothing.
   */
  it("does not fall back to plain rectangles", () => {
    const all = chambers();
    expect(all.length, "nothing drew, so this asserted nothing").toBeGreaterThan(80);
    const rects = all.filter((d) => d.room.shape!.family === "rect").length;
    expect(rects / all.length, `${rects} of ${all.length} are plain rects`).toBeLessThan(0.4);
  });

  it("draws every family, round included", () => {
    const seen = new Set(chambers().map((d) => d.room.shape!.family));
    expect([...seen].sort()).toEqual(["L", "T", "cross", "rect", "round"]);
  });

  it("draws round as an ellipse rather than a box", () => {
    // The specific 6a bug: `round — square` meant square *proportions*, and no
    // circular outline existed in the code at all.
    const round = chambers().filter((d) => d.room.shape!.family === "round");
    expect(round.length, "no round rooms drew").toBeGreaterThan(3);
    for (const { room } of round) {
      // Below about 4x4 an inscribed ellipse rasterises to the whole rectangle,
      // and correctly so — there is no curve to draw in a 2x3 box. The claim is
      // about rooms with room to be round.
      if (room.bounds.w < 4 || room.bounds.h < 4) continue;
      const box = room.bounds.w * room.bounds.h;
      expect(room.cells.length, `${room.roomId} fills its box`).toBeLessThan(box);
      // A rectangle traces to four corners; an ellipse to a great many more.
      expect(room.outline.length, `${room.roomId} outline`).toBeGreaterThan(4);
    }
  });

  it("never overloads a round room with doors", () => {
    // An ellipse meets its orthogonal neighbours along four short flat runs and
    // a door needs one each. `class >= degree - 1` does not cover this: that
    // floor buys area, and a vast ellipse has no more flat runs than a small one.
    for (const { room, stock } of chambers()) {
      if (room.shape!.family === "round") {
        expect(stock.degree, `${room.roomId}`).toBeLessThanOrEqual(ROUND_MAX_DEGREE);
      }
    }
  });

  it("still draws a room whose archetype pins round but whose degree will not take it", () => {
    // The fallback is the half that can fail silently: refusing `round` must
    // hand the room to another family, not refuse the room.
    const pinned = new Set(
      Object.entries(ARCHETYPES)
        .filter(([, a]) => a.family?.includes("round"))
        .map(([k]) => k)
    );
    const overloaded = chambers().filter(
      (d) => pinned.has(d.stock.identity) && d.stock.degree > ROUND_MAX_DEGREE
    );
    for (const { room } of overloaded) {
      expect(room.shape!.family, `${room.roomId} fell back`).not.toBe("round");
      expect(room.cells.length).toBeGreaterThan(0);
    }
  });

  it("keeps floor area inside the band the class names", () => {
    // Banded on FLOOR AREA, not the bounding box: a cross fills perhaps 40% of
    // its box and only one of those two numbers is what the fiction means.
    for (const { room } of chambers()) {
      const [lo, hi] = AREA[room.shape!.sizeClass];
      expect(room.cells.length, `${room.roomId} ${room.shape!.sizeClass}`).toBeGreaterThanOrEqual(lo);
      expect(room.cells.length).toBeLessThanOrEqual(hi);
    }
  });

  it("caps the bounding box, except where relief 2 bulges past it", () => {
    for (const { room } of chambers()) {
      if (room.shape!.relief === 2) continue;
      expect(room.bounds.w, `${room.roomId}`).toBeLessThanOrEqual(BOX_CAP);
      expect(room.bounds.h, `${room.roomId}`).toBeLessThanOrEqual(BOX_CAP);
    }
  });
});

describe.skip("relief", () => {
  it("never rolls relief 2 — only an archetype produces it", () => {
    const demands = new Set(
      Object.entries(ARCHETYPES)
        .filter(([, a]) => a.relief === 2)
        .map(([k]) => k)
    );
    for (const { room, stock } of chambers()) {
      if (room.shape!.relief === 2) {
        expect(demands.has(stock.identity), `${stock.identity} rolled relief 2`).toBe(true);
      }
    }
  });

  it("leaves tiny rooms perfect", () => {
    // 20 distinct silhouettes in 583 draws: tiny cannot carry relief at all, so
    // a room that came out tiny is left alone whatever it rolled.
    for (const { room } of chambers()) {
      if (room.shape!.sizeClass !== "tiny") continue;
      const box = room.bounds.w * room.bounds.h;
      const family = room.shape!.family;
      if (family === "rect") expect(room.cells.length, `${room.roomId}`).toBe(box);
    }
  });

  it("rolls relief at all, on about a quarter of the rooms", () => {
    const flat = chambers().filter((d) => d.room.shape!.relief === 0).length;
    const share = flat / chambers().length;
    expect(share, "relief 0 rolls 25%, plus the archetypes that pin it").toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.6);
  });
});

// ===========================================================================
// THE PLAN
// ===========================================================================

describe.skip("floorplan", () => {
  // Sizes 1 and 2 are the ones the packer reliably draws. Whether it draws at
  // all is measured at the bottom of this file rather than asserted away here.
  const cases: Array<[Size, number]> = [
    [1, 7001], [1, 7002],
    [2, 7004], [2, 7005],
  ];

  it.each(cases)("size %i seed %i draws a sound plan", (size, seed) => {
    const { graph, sd } = build(seed, size);
    const fp = generateFloorplanValid(graph, sd, { seed, attempts: 12 });
    expect(fp, "no plan drawn").not.toBeNull();
    expect(validateFloorplan(fp!, graph, sd)).toEqual([]);
  });

  /**
   * The guarantee the packer actually makes. It does not promise to draw every
   * graph — that rate is measured elsewhere — but a plan it hands back is sound:
   * nothing overlaps, every footprint is one piece, every connector has exactly
   * one door and that door is in a wall its two rooms really share.
   *
   * Sizes 4 and 5 are deliberately not here. An attempt at those sizes runs into
   * seconds and draws perhaps one time in a hundred, so including them costs a
   * minute to assert almost nothing. Soundness is a property of the code paths,
   * not of the room count, and every path is exercised at sizes 1 to 3.
   */
  it("never returns an unsound plan", () => {
    let drawn = 0;
    for (const size of [1, 2, 3] as Size[]) {
      for (let i = 0; i < 3; i++) {
        const { graph, sd } = build(9100 + i, size);
        const fp = generateFloorplan(graph, sd, { seed: 41 + i });
        if (!fp) continue;
        drawn++;
        expect(validateFloorplan(fp, graph, sd), `size ${size} seed ${9100 + i}`).toEqual([]);
      }
    }
    expect(drawn, "nothing drew at all, so this asserted nothing").toBeGreaterThan(2);
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
    const rank = { tiny: 1, small: 2, medium: 3, large: 4 };
    for (const room of fp.rooms) {
      if (room.isCorridor) continue;
      const stock = sd.rooms.find((r) => r.roomId === room.roomId)!;
      expect(
        rank[room.shape!.sizeClass],
        `${room.roomId} deg ${stock.degree}`
      ).toBeGreaterThanOrEqual(stock.degree - 1);
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

describe.skip("traceOutline", () => {
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

describe.skip("floorplan: how often it draws", () => {
  /**
   * A smoke check, not the measurement.
   *
   * Placement is the high-risk half of 6a and the per-attempt draw rate is the
   * number that says so — but establishing it to any useful precision needs
   * hundreds of attempts at sizes that cost seconds each, which is minutes of
   * suite time to learn something that only moves when the packer is changed.
   * That belongs in a profiling run. What is worth having on every run is a
   * floor: if the small sizes stop drawing, something is broken rather than
   * merely worse.
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

  it("still draws the small sizes", () => {
    expect(rate(1, 4, 2), "size 1").toBeGreaterThan(0.8);
    expect(rate(2, 4, 2), "size 2").toBeGreaterThan(0.1);
  }, 30_000);
});
