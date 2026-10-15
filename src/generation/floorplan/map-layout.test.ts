/**
 * The floorplan as a drawing.
 *
 * Two halves. The tracer is unit-tested on cell sets small enough to reason
 * about by hand, because an outline that is subtly wrong draws a room that
 * looks fine and encloses the wrong floor. The layout is then tested against a
 * real block plan, where the property that matters is that the drawing agrees
 * with the plan it came from — every door in a wall both its rooms own, the
 * way out opening into rock, nothing outside the bounds.
 */

import { describe, expect, it } from "vitest";
import { blockPlanValid, type BlockPlan } from "./blockplan.ts";
import { generateBlueprint, type Dungeon } from "./graph.ts";
import { generateBlueprintSeed, type Size } from "../content/blueprint.ts";
import { stockDungeon } from "../content/stock.ts";
import { type StockedDungeon } from "../content/types.ts";
import { floorplanLayout, traceOutline } from "./map-layout.ts";
import type { Point } from "../../shared/utils/grid.ts";

// ===========================================================================
// THE TRACER
// ===========================================================================

/** Twice the signed area, so a loop's enclosed floor can be checked. */
function area2(loop: Point[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Floor enclosed by the outline, holes taken back out. */
function enclosed(t: { outer: Point[]; holes: Point[][] }): number {
  return (area2(t.outer) + t.holes.reduce((s, h) => s + area2(h), 0)) / 2;
}

const cells = (...pairs: Array<[number, number]>): Point[] =>
  pairs.map(([x, y]) => ({ x, y }));

describe("traceOutline", () => {
  it("draws a rectangle as four corners", () => {
    const t = traceOutline(cells([0, 0], [1, 0], [0, 1], [1, 1]));
    expect(t.outer).toHaveLength(4);
    expect(t.holes).toHaveLength(0);
    expect(enclosed(t)).toBe(4);
  });

  it("keeps the notch in an L", () => {
    //  ##
    //  #
    const t = traceOutline(cells([0, 0], [1, 0], [0, 1]));
    expect(t.outer, "an L has six corners, not four").toHaveLength(6);
    expect(enclosed(t)).toBe(3);
  });

  it("finds the hole in a donut", () => {
    // A room grown frontier-by-frontier can close a U on itself. Filling that
    // in would draw floor where there is rock.
    const ring: Array<[number, number]> = [];
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) if (!(x === 1 && y === 1)) ring.push([x, y]);
    }
    const t = traceOutline(cells(...ring));
    expect(t.outer).toHaveLength(4);
    expect(t.holes).toHaveLength(1);
    expect(t.holes[0]).toHaveLength(4);
    expect(enclosed(t), "the hole comes back out of the area").toBe(8);
  });

  it("keeps a cross to one loop", () => {
    const plus = cells([1, 0], [0, 1], [1, 1], [2, 1], [1, 2]);
    const t = traceOutline(plus);
    expect(t.outer).toHaveLength(12);
    expect(t.holes).toHaveLength(0);
    expect(enclosed(t)).toBe(5);
  });

  it("does not stitch a diagonal pinch into a figure eight", () => {
    // Cells (1,0) and (2,1) meet only at the corner (2,1), where four boundary
    // edges converge and "what comes next" has two answers. The wrong answer
    // crosses to the other lobe and encloses the wrong floor.
    const stair = cells([0, 0], [1, 0], [1, 1], [2, 1]);
    const t = traceOutline(stair);
    expect(t.holes).toHaveLength(0);
    expect(enclosed(t)).toBe(4);
  });
});

// ===========================================================================
// AGAINST A REAL PLAN
// ===========================================================================

function build(seed: number, size: Size): { graph: Dungeon; sd: StockedDungeon } {
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  const bp = generateBlueprintSeed(size, seed, 1);
  return { graph: dungeon, sd: stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 }) };
}

interface Case {
  graph: Dungeon;
  plan: BlockPlan;
}

const CASES: Case[] = [];
for (const size of [1, 2, 3] as Size[]) {
  const { graph, sd } = build(4200, size);
  const corridors = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
  const plan = blockPlanValid(graph, (i) => corridors.has(i), 91, 60);
  if (plan) CASES.push({ graph, plan });
}

const CELL = 18;
const PAD = 24;

describe("floorplanLayout", () => {
  it("has plans to draw", () => {
    expect(CASES.length).toBe(3);
  });

  it("encloses exactly the floor the plan gave each room", () => {
    // The drawing and the plan must agree about where the floor is, because
    // the game master is answering from the plan and the player is reading the
    // drawing. A room drawn one cell too generous is a room they will try to
    // walk into.
    for (const { graph, plan } of CASES) {
      const layout = floorplanLayout(plan, graph, { cell: CELL, padding: PAD });
      layout.rooms.forEach((room, i) => {
        expect(room.shape.kind).toBe("polygon");
        if (room.shape.kind !== "polygon") return;
        const floor =
          (area2(room.shape.points) +
            (room.shape.holes ?? []).reduce((s, h) => s + area2(h), 0)) /
          2;
        expect(floor / (CELL * CELL)).toBeCloseTo(plan.rooms[i].length, 6);
      });
    }
  });

  it("puts the player marker on ground the room actually owns", () => {
    for (const { graph, plan } of CASES) {
      const layout = floorplanLayout(plan, graph, { cell: CELL, padding: PAD });
      const minX = Math.min(...plan.rooms.flat().map((c) => c.x), plan.surface!.to.x);
      const minY = Math.min(...plan.rooms.flat().map((c) => c.y), plan.surface!.to.y);
      layout.rooms.forEach((room, i) => {
        // Back out of SVG units into the grid, and check it is a real cell.
        const gx = Math.floor((room.centre.x - PAD) / CELL) + minX;
        const gy = Math.floor((room.centre.y - PAD) / CELL) + minY;
        expect(
          plan.rooms[i].some((c) => c.x === gx && c.y === gy),
          "the marker sits in the rock"
        ).toBe(true);
      });
    }
  });

  it("cuts every door into the wall its two rooms share", () => {
    for (const { graph, plan } of CASES) {
      const layout = floorplanLayout(plan, graph, { cell: CELL, padding: PAD });
      expect(layout.connectors.length).toBe(graph.edges.length);
      for (const c of layout.connectors) {
        expect(c.door, "a floorplan connector is a door").toBeDefined();
        // The two cells it joins are side by side, so the opening is exactly
        // one cell wide and the far side is one cell away.
        const span =
          Math.abs(c.door!.through.x - c.door!.at.x) + Math.abs(c.door!.through.y - c.door!.at.y);
        expect(span).toBeCloseTo(CELL / 2, 6);

        // Three quarters of the wall, so the door stops short of the corners
        // at either end. Run it the full span and it meets the perpendicular
        // walls and reads as a missing wall rather than a way through.
        expect(c.door!.length).toBeCloseTo(CELL * 0.75, 6);
      }
    }
  });

  it("opens the way out into the rock, inside the bounds", () => {
    for (const { graph, plan } of CASES) {
      const layout = floorplanLayout(plan, graph, { cell: CELL, padding: PAD });
      expect(layout.surface, "every dungeon has a way out").toBeDefined();
      const s = layout.surface!;
      expect(s.roomId).toBe(graph.rooms[plan.surface!.room].entityId);
      // The stub reaches one cell beyond the entrance wall, and the bounds
      // were widened to cover it — otherwise the way out draws off the map.
      expect(s.door.through.x).toBeGreaterThanOrEqual(0);
      expect(s.door.through.y).toBeGreaterThanOrEqual(0);
      expect(s.door.through.x).toBeLessThanOrEqual(layout.bounds.w);
      expect(s.door.through.y).toBeLessThanOrEqual(layout.bounds.h);
    }
  });

  it("keeps every wall inside the bounds", () => {
    for (const { graph, plan } of CASES) {
      const layout = floorplanLayout(plan, graph, { cell: CELL, padding: PAD });
      for (const room of layout.rooms) {
        if (room.shape.kind !== "polygon") continue;
        for (const p of room.shape.points) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(layout.bounds.w);
          expect(p.y).toBeLessThanOrEqual(layout.bounds.h);
        }
      }
    }
  });

  it("marks corridors so a passage can be drawn as one", () => {
    const { graph, sd } = build(4200, 3);
    const corridors = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
    const plan = blockPlanValid(graph, (i) => corridors.has(i), 91, 60)!;
    const layout = floorplanLayout(plan, graph, { isCorridor: (i) => corridors.has(i) });
    const drawn = layout.rooms.filter((r) => r.corridor).length;
    expect(drawn).toBe(corridors.size);
    expect(drawn).toBeGreaterThan(0);
  });

  it("draws the same plan the same way twice", () => {
    const { graph, plan } = CASES[1];
    const a = floorplanLayout(plan, graph);
    const b = floorplanLayout(plan, graph);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
