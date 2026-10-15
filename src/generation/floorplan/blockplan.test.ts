import { beforeAll, describe, expect, it } from "vitest";
import { AREA, ARCHETYPES, sizeAllows } from "./room-size.ts";
import {
  blockPlan,
  blockPlanValid,
  countCrossings,
  roomSizes,
  seedBlockPlan,
  type BlockPlan,
} from "./blockplan.ts";
import { generateBlueprint, type Dungeon } from "./graph.ts";
import { stockDungeon } from "../content/stock.ts";
import { type StockedDungeon } from "../content/types.ts";
import { generateBlueprintSeed, type Size } from "../content/blueprint.ts";

/**
 * COST DISCIPLINE, as in `floorplan.test.ts`. Drawing here is roughly a
 * millisecond, so the suite can afford real coverage at every size — but the
 * retry loop is what costs, and size 5 still fails about one dungeon in eight.
 * So the guarantees are asserted wherever a plan is produced rather than by
 * demanding one from every seed.
 */
function build(seed: number, size: Size): { graph: Dungeon; sd: StockedDungeon } {
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  const bp = generateBlueprintSeed(size, seed, 1);
  return { graph: dungeon, sd: stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 }) };
}

const corridorsOf = (sd: StockedDungeon) => {
  const set = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
  return (i: number) => set.has(i);
};

const K = (p: { x: number; y: number }) => `${p.x},${p.y}`;
const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Plans across a spread of sizes and seeds, built once. */
interface Case {
  size: Size;
  graph: Dungeon;
  sd: StockedDungeon;
  plan: BlockPlan;
}
let CASES: Case[] = [];

beforeAll(() => {
  for (const size of [1, 2, 3, 4, 5] as Size[]) {
    for (let i = 0; i < 4; i++) {
      const { graph, sd } = build(4200 + i, size);
      const plan = blockPlanValid(graph, corridorsOf(sd), 91 + i * 13, 60);
      if (plan) CASES.push({ size, graph, sd, plan });
    }
  }
}, 120_000);

// ===========================================================================
// THE GUARANTEES
// ===========================================================================

describe("block plan: what a returned plan promises", () => {
  it("produces plans across the size range", () => {
    // Not every seed draws — see the size-5 note in CODING-PLAN §6a.3 — so this
    // establishes that the assertions below are asserting against something.
    expect(CASES.length, "nothing drew, so the rest of this file proves nothing")
      .toBeGreaterThan(12);
    expect(new Set(CASES.map((c) => c.size)).size, "every size represented").toBe(5);
  });

  it("gives every room a footprint", () => {
    for (const { graph, plan } of CASES) {
      expect(plan.rooms).toHaveLength(graph.rooms.length);
      for (const cells of plan.rooms) expect(cells.length).toBeGreaterThan(0);
    }
  });

  it("never lets two rooms share a cell", () => {
    for (const { plan } of CASES) {
      const owner = new Map<string, number>();
      plan.rooms.forEach((cells, i) => {
        for (const c of cells) {
          expect(owner.get(K(c)), `cell ${K(c)}: rooms ${owner.get(K(c))} and ${i}`).toBeUndefined();
          owner.set(K(c), i);
        }
      });
    }
  });

  it("keeps every room in one piece", () => {
    for (const { plan } of CASES) {
      plan.rooms.forEach((cells, i) => {
        const set = new Set(cells.map(K));
        const seen = new Set([K(cells[0])]);
        const queue = [cells[0]];
        for (let h = 0; h < queue.length; h++) {
          for (const [dx, dy] of STEPS) {
            const n = { x: queue[h].x + dx, y: queue[h].y + dy };
            if (set.has(K(n)) && !seen.has(K(n))) {
              seen.add(K(n));
              queue.push(n);
            }
          }
        }
        expect(seen.size, `room ${i} is in pieces`).toBe(set.size);
      });
    }
  });

  /**
   * The load-bearing one, and the reason this approach exists. The old packer
   * searched for an arrangement in which connected rooms happened to touch and
   * usually failed to find one. Here both rooms are required to contain their
   * side of an agreed contact before either is drawn, so it holds by
   * construction and there is nothing to search for.
   */
  it("has every connected pair sharing a wall", () => {
    for (const { graph, plan } of CASES) {
      for (const e of graph.edges) {
        const a = new Set(plan.rooms[e.a].map(K));
        const touching = plan.rooms[e.b].some((c) =>
          STEPS.some(([dx, dy]) => a.has(K({ x: c.x + dx, y: c.y + dy })))
        );
        expect(touching, `rooms ${e.a} and ${e.b} are connected but do not touch`).toBe(true);
      }
    }
  });

  it("puts exactly one door on every connector, in a wall those two rooms share", () => {
    for (const { graph, plan } of CASES) {
      expect(plan.doors).toHaveLength(graph.edges.length);
      const seen = new Set<string>();
      for (const d of plan.doors) {
        const pair = [Math.min(d.a, d.b), Math.max(d.a, d.b)].join("-");
        expect(seen.has(pair), `two doors between ${pair}`).toBe(false);
        seen.add(pair);

        const gap = Math.abs(d.from.x - d.to.x) + Math.abs(d.from.y - d.to.y);
        expect(gap, "a door joins two cells side by side").toBe(1);
        expect(plan.rooms[d.a].some((c) => K(c) === K(d.from))).toBe(true);
        expect(plan.rooms[d.b].some((c) => K(c) === K(d.to))).toBe(true);
      }
    }
  });

  it("puts the way out on a wall of the entrance room that faces open rock", () => {
    // The one connector that is not a graph edge, so the one door `chooseDoors`
    // can never place. It is also the only door the player is guaranteed to
    // use, in both directions, which is why it is asserted rather than assumed.
    for (const { graph, plan } of CASES) {
      expect(plan.surface, "every dungeon has a way out to draw").not.toBeNull();
      const s = plan.surface!;

      const entrance = graph.entrances.length ? graph.entrances[0] : 0;
      expect(s.room, "the way out is on the room stocking calls the entrance").toBe(entrance);

      const gap = Math.abs(s.from.x - s.to.x) + Math.abs(s.from.y - s.to.y);
      expect(gap, "a door joins two cells side by side").toBe(1);
      expect(
        plan.rooms[entrance].some((c) => K(c) === K(s.from)),
        "the inner cell belongs to the entrance room"
      ).toBe(true);

      // The far side is the surface, so it must be nobody's floor. A way out
      // that opens into the next room along is not a way out.
      const owned = new Set(plan.rooms.flat().map(K));
      expect(owned.has(K(s.to)), "the way out opens into open rock").toBe(false);
    }
  });

  it("leaves rock between rooms rather than tiling the plane", () => {
    // A room takes the skeleton through its doors and grows toward a target
    // inside its zone; what it does not take stays rock. If rooms filled their
    // zones the map would be a honeycomb and stop reading as carved.
    for (const { plan } of CASES) {
      const roomCells = plan.rooms.reduce((s, c) => s + c.length, 0);
      const zoneCells = plan.zones.reduce((s, c) => s + c.length, 0);
      expect(roomCells).toBeLessThan(zoneCells);
    }
  });
});

// ===========================================================================
// DETERMINISM
// ===========================================================================

describe("block plan: determinism", () => {
  it("draws the same plan twice for one layout seed", () => {
    const { graph, sd } = build(4300, 3);
    const a = blockPlan(graph, corridorsOf(sd), 55);
    const b = blockPlan(graph, corridorsOf(sd), 55);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("draws a different plan for a different layout seed", () => {
    // Retrying has to actually retry. The spacing pass is a convergent
    // relaxation, and when the seed only reached its tie-breaks every attempt
    // came out identical — so a dungeon that would not route never started
    // routing however many seeds were spent on it.
    const { graph, sd } = build(4300, 3);
    const a = blockPlan(graph, corridorsOf(sd), 55);
    const b = blockPlan(graph, corridorsOf(sd), 55 + 7919);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });
});

// ===========================================================================
// SPACING AND CROSSINGS
// ===========================================================================

describe("block plan: the layout the drawing rests on", () => {
  it("unties the connections before drawing", () => {
    // Phase A validates that the GRAPH is planar — that a crossing-free drawing
    // exists — but `relax()` has no notion of a crossing and its positions
    // routinely contain them. Two rooms sharing a wall cannot cross, so this is
    // a precondition of the whole approach rather than a nicety.
    let clean = 0;
    for (const { graph, plan } of CASES) {
      if (countCrossings(plan.centres, graph.edges) === 0) clean++;
    }
    expect(clean / CASES.length, "most drawn plans come from an untangled layout")
      .toBeGreaterThan(0.7);
  });

  it("counts crossings on a shape it cannot mistake", () => {
    // Two connections that plainly cross, and two that plainly do not.
    const square = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(countCrossings(square, [{ a: 0, b: 2 }, { a: 1, b: 3 }])).toBe(1);
    expect(countCrossings(square, [{ a: 0, b: 1 }, { a: 2, b: 3 }])).toBe(0);
  });

  it("spaces most connected rooms within reach of a one-turn corridor", () => {
    // 5 to 9 cells round a corner. Too close and there is nowhere to put a
    // corridor; too far and the corridor becomes a long barrier across the map,
    // which measured worse.
    //
    // MOST, not all, and deliberately. Untangling swaps rooms to clear a
    // crossing and does not care what that does to spacing, and it gets the last
    // word — a layout a cell out of range still routes, and one with a crossing
    // in it cannot. So this asserts the spacing pass is working, not that it is
    // obeyed absolutely. Measured around 83%.
    let inRange = 0;
    let total = 0;
    for (const { graph, plan } of CASES) {
      for (const e of graph.edges) {
        const d =
          Math.abs(plan.centres[e.a].x - plan.centres[e.b].x) +
          Math.abs(plan.centres[e.a].y - plan.centres[e.b].y);
        total++;
        if (d >= 5 && d <= 9) inRange++;
      }
    }
    expect(inRange / total).toBeGreaterThan(0.7);
  });

  it("lays a one-turn path down for every connection, sharing no cells", () => {
    const { graph, sd } = build(4400, 2);
    const seed = seedBlockPlan(graph, 77);
    if (!seed) return; // this seed did not route; the guarantee is about ones that do
    void sd;
    expect(seed.paths).toHaveLength(graph.edges.length);

    const used = new Set<string>();
    for (const p of seed.paths) {
      for (const c of p.cells) {
        expect(used.has(K(c)), `two corridors share ${K(c)}`).toBe(false);
        used.add(K(c));
      }
      // One turn means the run changes direction at most once.
      let turns = 0;
      for (let i = 2; i < p.cells.length; i++) {
        const d1 = { x: p.cells[i - 1].x - p.cells[i - 2].x, y: p.cells[i - 1].y - p.cells[i - 2].y };
        const d2 = { x: p.cells[i].x - p.cells[i - 1].x, y: p.cells[i].y - p.cells[i - 1].y };
        if (d1.x !== d2.x || d1.y !== d2.y) turns++;
      }
      expect(turns, "a path turns at most once").toBeLessThanOrEqual(1);
    }
  });
});

// ===========================================================================
// SIZE, AND WHAT IT CONSTRAINS
// ===========================================================================

describe("room size", () => {
  it("reads the class off the room that was actually drawn", () => {
    for (const { plan } of CASES) {
      const sizes = roomSizes(plan.rooms);
      sizes.forEach((cls, i) => {
        const [lo, hi] = AREA[cls];
        expect(plan.rooms[i].length, `room ${i} is ${cls}`).toBeGreaterThanOrEqual(lo);
        expect(plan.rooms[i].length).toBeLessThanOrEqual(hi);
      });
    }
  });

  it("permits an unannotated noun at any size", () => {
    // Three quarters of the table carries no size constraint at all.
    expect(sizeAllows("Guardroom", "tiny")).toBe(true);
    expect(sizeAllows("Guardroom", "large")).toBe(true);
  });

  it("refuses a noun the room is the wrong size for", () => {
    expect(sizeAllows("Privy", "tiny")).toBe(true);
    expect(sizeAllows("Privy", "large")).toBe(false);
    expect(sizeAllows("Courtyard", "large")).toBe(true);
    expect(sizeAllows("Courtyard", "tiny")).toBe(false);
    expect(sizeAllows("Well", "tiny")).toBe(true);
    expect(sizeAllows("Well", "medium")).toBe(false);
  });

  it("conditions the identity roll on the size the layout produced", () => {
    // The whole point of the inversion: geometry settles first, and the roll
    // bends to it. An archetype pin used to be an instruction the packer could
    // not honour; it is now a condition that is always satisfiable.
    const { graph } = build(4500, 3);
    const bp = generateBlueprintSeed(3, 4500, 1);
    const plan = blockPlanValid(graph, () => false, 31, 60);
    if (!plan) return;

    const sizes = roomSizes(plan.rooms);
    const sd = stockDungeon(graph, bp, {
      level: 1,
      seed: 4500 + 7919,
      layout: () => sizes,
    });

    for (const r of sd.rooms) {
      expect(r.sizeClass, "the layout's size reached the stocked room").toBeDefined();
      if (!ARCHETYPES[r.identity]) continue;
      expect(
        sizeAllows(r.identity, r.sizeClass!),
        `${r.identity} is not a ${r.sizeClass} room`
      ).toBe(true);
    }
  });

  it("rolls unconstrained when no layout ran", () => {
    const { graph } = build(4600, 2);
    const bp = generateBlueprintSeed(2, 4600, 1);
    const sd = stockDungeon(graph, bp, { level: 1, seed: 4600 + 7919 });
    for (const r of sd.rooms) expect(r.sizeClass).toBeUndefined();
    expect(sd.rooms.every((r) => r.identity.length > 0)).toBe(true);
  });
});
