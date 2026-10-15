/**
 * GEOMETRY AND FIXTURES
 *
 * Two things are being guarded and they are different in kind.
 *
 * The geometry is a DERIVATION, so it is tested against hand-built cell sets
 * where the right answer is obvious by eye — an L, a 3x7, a room with a hole in
 * it — plus a sweep over real plans to prove nothing throws and every derived
 * fact is internally consistent.
 *
 * The placement is a CONTRACT with the content pass: never on a door cell,
 * never twice on one cell, never a count the model chose, never a coordinate
 * that reaches the model. Those are the ones that would go silently wrong.
 */

import { describe, expect, it } from "vitest";
import { blockPlanValid, roomSizes, type BlockPlan } from "./blockplan.ts";
import {
  boundingBox,
  CELL_FEET,
  describeGeometry,
  exitPhrase,
  roomDepths,
  roomGeometry,
  roomGround,
  siteRooms,
  wallCells,
} from "./geometry.ts";
import {
  FIXTURES,
  FIXTURE_KINDS,
  fixtureCap,
  fixtureMenu,
  isFixtureKind,
  isPositionWord,
  placeAt,
  placeFixture,
  POSITION_WORDS,
} from "./fixtures.ts";
import { generateBlueprint, type Dungeon } from "./graph.ts";
import { generateBlueprintSeed, type Size } from "../content/blueprint.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { stockDungeon, type StockedDungeon } from "../content/stock.ts";
import type { Point } from "../../shared/utils/grid.ts";

// ---------------------------------------------------------------------------
// A DRAWN DUNGEON, BUILT THE WAY THE GAME BUILDS ONE
// ---------------------------------------------------------------------------

interface Drawn {
  graph: Dungeon;
  sd: StockedDungeon;
  plan: BlockPlan;
}

/**
 * The layout runs INSIDE stocking, as it does in `generate.ts`. Building it any
 * other way would test a pipeline the game does not have.
 */
function draw(seed: number, size: Size): Drawn | null {
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  const bp = generateBlueprintSeed(size, seed, 1);
  let plan: BlockPlan | null = null;
  const sd = stockDungeon(dungeon, bp, {
    level: 1,
    seed: seed + 7919,
    layout: (rooms) => {
      const corridor = new Set(rooms.filter((r) => r.isCorridor).map((r) => r.index));
      plan = blockPlanValid(dungeon, (i) => corridor.has(i), seed + 31);
      return plan ? roomSizes(plan.rooms) : rooms.map(() => undefined);
    },
  });
  const drawn = plan as BlockPlan | null;
  return drawn ? { graph: dungeon, sd, plan: drawn } : null;
}

/** Sizes 1 and 2 only — they draw first time and cost milliseconds. */
let CORPUS: Drawn[] | null = null;
function corpus(): Drawn[] {
  if (CORPUS) return CORPUS;
  const out: Drawn[] = [];
  for (const size of [1, 2] as Size[]) {
    for (let i = 0; i < 6; i++) {
      const d = draw(7100 + i * 17 + size, size);
      if (d) out.push(d);
    }
  }
  CORPUS = out;
  return out;
}

const cells = (...xy: [number, number][]): Point[] => xy.map(([x, y]) => ({ x, y }));

/** A solid w x h block with its top-left corner at (x, y). */
function block(x: number, y: number, w: number, h: number): Point[] {
  const out: Point[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push({ x: x + dx, y: y + dy });
  return out;
}

// ===========================================================================
// THE DERIVATION, AGAINST SHAPES WHOSE ANSWER IS OBVIOUS
// ===========================================================================

describe("boundingBox", () => {
  it("covers the cells and nothing more", () => {
    expect(boundingBox(block(3, 5, 4, 2))).toEqual({ x: 3, y: 5, w: 4, h: 2 });
  });

  it("is the box, not the floor — an L reports its full extent", () => {
    // The two are deliberately different numbers: area bands the room, the box
    // caps it, and on anything but a rectangle they come apart.
    const L = [...block(0, 0, 2, 4), ...block(2, 2, 2, 2)];
    expect(boundingBox(L)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(L.length).toBe(12);
  });
});

describe("wallCells", () => {
  it("names a side by what is NOT behind the cell", () => {
    const room = block(0, 0, 3, 3);
    const w = wallCells(room);
    // y grows downward, so north is the top row.
    expect(w.north.map((c) => c.y)).toEqual([0, 0, 0]);
    expect(w.south.map((c) => c.y)).toEqual([2, 2, 2]);
    expect(w.west.map((c) => c.x)).toEqual([0, 0, 0]);
    expect(w.east.map((c) => c.x)).toEqual([2, 2, 2]);
    // The middle cell backs onto floor on all four sides and is on no wall.
    expect(w.north).not.toContainEqual({ x: 1, y: 1 });
  });

  it("gives an L north-facing floor at two heights", () => {
    // This is the case a bounding-box reading gets wrong: the inside of the
    // elbow is genuinely the north wall of the part of the room it is in.
    const L = [...block(0, 0, 2, 4), ...block(2, 2, 2, 2)];
    const north = wallCells(L).north;
    expect(new Set(north.map((c) => c.y))).toEqual(new Set([0, 2]));
  });
});

describe("roomDepths", () => {
  it("counts rooms from the way in", () => {
    const { graph } = corpus()[0];
    const depth = roomDepths(graph);
    for (const e of graph.entrances) expect(depth[e]).toBe(0);
    // Every room is reachable, so nothing is left at Infinity.
    expect(depth.every((d) => Number.isFinite(d))).toBe(true);
    // Adjacent rooms are never more than one band apart — the BFS invariant.
    for (const e of graph.edges) expect(Math.abs(depth[e.a] - depth[e.b])).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// AGAINST REAL PLANS
// ===========================================================================

describe("roomGeometry", () => {
  it("derives one reading per room, all of them self-consistent", () => {
    for (const { plan, graph } of corpus()) {
      const geoms = roomGeometry(plan, graph);
      expect(geoms.length).toBe(plan.rooms.length);

      for (const [i, g] of geoms.entries()) {
        expect(g.area, "area is the cell count").toBe(plan.rooms[i].length);
        expect(g.area, "floor cannot exceed its own box").toBeLessThanOrEqual(g.box.w * g.box.h);
        expect(g.feet.w).toBe(g.box.w * CELL_FEET);
        expect(g.feet.h).toBe(g.box.h * CELL_FEET);

        // The long axis and the proportion have to agree: a room with no long
        // side is square, and a room with one runs the way its box is longer.
        if (g.proportion === "square") expect(g.longAxis).toBeNull();
        else expect(g.longAxis).toBe(g.box.h > g.box.w ? "north-south" : "east-west");

        // A wall run cannot be longer than the box side it lies along.
        expect(g.walls.north).toBeLessThanOrEqual(g.box.w);
        expect(g.walls.south).toBeLessThanOrEqual(g.box.w);
        expect(g.walls.east).toBeLessThanOrEqual(g.box.h);
        expect(g.walls.west).toBeLessThanOrEqual(g.box.h);
      }
    }
  });

  it("gives every room exactly as many exits as it has ways out", () => {
    // This is the assertion that catches a door indexed from one side only —
    // the class of bug that leaves a room describing itself as having fewer
    // ways out than it has, which is when the writing pass starts inventing.
    for (const { plan, graph } of corpus()) {
      const geoms = roomGeometry(plan, graph);
      const expected = plan.rooms.map(() => 0);
      for (const d of plan.doors) {
        expected[d.a]++;
        expected[d.b]++;
      }
      if (plan.surface) expected[plan.surface.room]++;
      for (const [i, g] of geoms.entries()) expect(g.exits.length, `room ${i}`).toBe(expected[i]);
    }
  });

  it("names a real connector for every exit but the way out", () => {
    for (const { plan, graph } of corpus()) {
      const ids = new Set(graph.edges.map((e) => e.entityId));
      for (const g of roomGeometry(plan, graph)) {
        for (const x of g.exits) {
          if (x.to === null) expect(x.connectorId, "the surface is not a graph edge").toBeNull();
          else expect(ids.has(x.connectorId!)).toBe(true);
        }
      }
    }
  });

  it("sees the same door from both sides, through opposite walls", () => {
    const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" } as const;
    for (const { plan, graph } of corpus()) {
      const geoms = roomGeometry(plan, graph);
      for (const d of plan.doors) {
        const here = geoms[d.a].exits.find((x) => x.to === d.b)!;
        const there = geoms[d.b].exits.find((x) => x.to === d.a)!;
        expect(here.wall).toBe(OPPOSITE[there.wall]);
      }
    }
  });

  it("puts the arrival on the way out when there is one, else the shallowest neighbour", () => {
    for (const { plan, graph } of corpus()) {
      const geoms = roomGeometry(plan, graph);
      const depth = roomDepths(graph);
      for (const g of geoms) {
        if (!g.arrival) {
          expect(g.exits.length, "only a room with no exits has no arrival").toBe(0);
          continue;
        }
        if (g.exits.some((x) => x.to === null)) {
          expect(g.arrival.to, "the way out beats every door").toBeNull();
          continue;
        }
        const shallowest = Math.min(...g.exits.map((x) => depth[x.to!]));
        expect(depth[g.arrival.to!]).toBe(shallowest);
      }
    }
  });
});

describe("roomGround", () => {
  it("gives every room its own door cells, and each is floor of that room", () => {
    for (const { plan, graph } of corpus()) {
      const geoms = roomGeometry(plan, graph);
      for (const [i, ground] of roomGround(plan, geoms).entries()) {
        const mine = new Set(plan.rooms[i].map((c) => `${c.x},${c.y}`));
        for (const d of ground.doorCells) {
          expect(mine.has(`${d.x},${d.y}`), "a door cell is this room's floor").toBe(true);
        }
        if (ground.arrivalCell) {
          expect(mine.has(`${ground.arrivalCell.x},${ground.arrivalCell.y}`)).toBe(true);
        }
      }
    }
  });

  it("has an arrival cell wherever the geometry named an arrival", () => {
    // The two are matched by the far room's index; a mismatch would leave "near
    // the entrance" silently measuring from nothing.
    for (const { plan, graph } of corpus()) {
      const geoms = roomGeometry(plan, graph);
      const ground = roomGround(plan, geoms);
      for (const [i, g] of geoms.entries()) {
        expect(ground[i].arrivalCell !== undefined, `room ${i}`).toBe(g.arrival !== undefined);
      }
    }
  });
});

// ===========================================================================
// THE WORDS
// ===========================================================================

describe("describeGeometry", () => {
  it("says feet, never cells, and never a coordinate", () => {
    for (const { plan, graph } of corpus()) {
      for (const g of roomGeometry(plan, graph)) {
        const line = describeGeometry(g);
        expect(line).toContain("feet");
        // Every number in the line has to be a multiple of the cell size, which
        // is what makes "no raw grid coordinate got out" checkable.
        for (const n of line.match(/\d+/g) ?? []) {
          expect(Number(n) % CELL_FEET, `${n} in "${line}"`).toBe(0);
        }
      }
    }
  });

  it("calls a passage a passage and gives it no size class", () => {
    const corridors = new Set(["tiny", "small", "medium", "large"]);
    for (const { plan, graph, sd } of corpus()) {
      const isCorridor = new Set(sd.rooms.filter((r) => r.isCorridor).map((r) => r.index));
      for (const g of roomGeometry(plan, graph, { isCorridor: (i) => isCorridor.has(i) })) {
        const line = describeGeometry(g);
        if (!g.corridor) continue;
        expect(line.startsWith("a passage")).toBe(true);
        for (const c of corridors) expect(line).not.toContain(`a ${c} chamber`);
      }
    }
  });

  // 8f. The sentence COUNTS the ways out, and a count is the one thing a reader
  // cannot half-believe: a concealed way inside it is a concealed way described.
  // The runtime hands in the concealed ids; the content pass hands in nothing,
  // because it is the pass that writes what the concealed way physically is.
  it("leaves out the ways it is asked to leave out", () => {
    let checked = 0;
    for (const { plan, graph } of corpus()) {
      for (const g of roomGeometry(plan, graph)) {
        const doors = g.exits.filter((x) => x.connectorId !== null);
        if (doors.length === 0) continue;
        checked++;

        const all = describeGeometry(g);
        const one = describeGeometry(g, { omit: new Set([doors[0].connectorId!]) });
        const none = describeGeometry(g, { omit: new Set(doors.map((x) => x.connectorId!)) });

        // The room is the same room; only the count moves. Sliced at the clause
        // rather than at the word, because a room with one door loses the whole
        // clause and there is then no word to slice at.
        const head = (s: string) => (s.includes(". Ways out:") ? s.slice(0, s.indexOf(". Ways out:")) : s);
        expect(head(one)).toBe(head(all));
        expect(one).not.toBe(all);

        // Omitting every door leaves the clause off entirely — unless the way
        // out of the dungeon is in this room, which has a null id and is never
        // omittable: it is the one door the player has certainly been through.
        const surface = g.exits.some((x) => x.connectorId === null);
        expect(none.includes("Ways out:")).toBe(surface);

        // An id that is not this room's changes nothing.
        expect(describeGeometry(g, { omit: new Set(["not-a-connector-here"]) })).toBe(all);
      }
    }
    expect(checked, "no room in the corpus had a door").toBeGreaterThan(0);
  });

  it("never uses a relative direction", () => {
    // The compass is map-absolute and the party's facing is unknown. A relative
    // word here would be a lie the moment they walk back through.
    for (const { plan, graph } of corpus()) {
      for (const g of roomGeometry(plan, graph)) {
        expect(describeGeometry(g)).not.toMatch(/\b(left|right|ahead|behind|forward)\b/i);
      }
    }
  });
});

describe("exitPhrase", () => {
  it("names the wall and where along it", () => {
    expect(exitPhrase({ connectorId: "x", to: 1, wall: "north", along: "west" })).toBe(
      "the north wall, toward the west end"
    );
    expect(exitPhrase({ connectorId: "x", to: 1, wall: "east", along: null })).toBe(
      "the east wall, at the middle"
    );
  });
});

// ===========================================================================
// THE MENU
// ===========================================================================

describe("the fixture menu", () => {
  it("validates exactly what it lists", () => {
    for (const k of FIXTURE_KINDS) expect(isFixtureKind(k)).toBe(true);
    for (const p of POSITION_WORDS) expect(isPositionWord(p)).toBe(true);
    expect(isFixtureKind("apparatus")).toBe(false);
    expect(isPositionWord("over by the thing")).toBe(false);
  });

  it("renders every kind once, starring the ones a passage can hold", () => {
    const menu = fixtureMenu();
    for (const k of FIXTURE_KINDS) {
      expect(menu).toContain(`${k}${FIXTURES[k].corridor ? "*" : ""} (`);
    }
    const starred = FIXTURE_KINDS.filter((k) => FIXTURES[k].corridor).length;
    expect(menu.split("*").length - 1).toBe(starred);
    expect(starred, "a passage can hold something").toBeGreaterThan(0);
    expect(starred, "but not everything").toBeLessThan(FIXTURE_KINDS.length);
  });

  it("caps a passage at one and a tiny room at one", () => {
    const g = (sizeClass: string, corridor: boolean) =>
      fixtureCap({ sizeClass, corridor } as never);
    expect(g("tiny", false)).toBe(1);
    expect(g("large", true), "a passage is a passage whatever its area").toBe(1);
    expect(g("large", false)).toBeGreaterThan(1);
  });
});

// ===========================================================================
// PLACEMENT — the contract with the content pass
// ===========================================================================

describe("placement", () => {
  /** One real room, with its doors, to place things in. */
  function aRoom(): { ground: ReturnType<typeof roomGround>[number]; geom: ReturnType<typeof roomGeometry>[number] } {
    for (const { plan, graph } of corpus()) {
      const site = siteRooms(plan, graph);
      for (const [i, g] of site.geometry.entries()) {
        // Big enough that "the middle third" and "a corner" are distinguishable.
        if (g.area >= 12 && site.ground[i].doorCells.length >= 2) {
          return { ground: site.ground[i], geom: g };
        }
      }
    }
    throw new Error("no room big enough to place in — the corpus is wrong");
  }

  /**
   * A room with an inside — cells with floor on all four sides.
   *
   * `aRoom` picks the first room of any size with two doors, and that one turns
   * out to be all edge, which is why its "centre" pool is empty too. About a
   * fifth of block-plan rooms are like that: grown cell by cell out of a
   * skeleton, they are often a cell or two thick. Rules about the interior need
   * a room that has one, and they must not silently skip when they cannot find
   * one — hence the throw.
   */
  function aFatRoom(): ReturnType<typeof aRoom> {
    for (const { plan, graph } of corpus()) {
      const site = siteRooms(plan, graph);
      for (const [i, g] of site.geometry.entries()) {
        const floor = new Set(site.ground[i].cells.map((c) => `${c.x},${c.y}`));
        const inside = site.ground[i].cells.filter(
          (c) =>
            floor.has(`${c.x + 1},${c.y}`) &&
            floor.has(`${c.x - 1},${c.y}`) &&
            floor.has(`${c.x},${c.y + 1}`) &&
            floor.has(`${c.x},${c.y - 1}`)
        );
        if (inside.length >= 3 && site.ground[i].doorCells.length >= 2) {
          return { ground: site.ground[i], geom: g };
        }
      }
    }
    throw new Error("no room with an interior — the corpus is wrong");
  }

  it("never stands anything in a doorway", () => {
    const { ground, geom } = aRoom();
    const doors = new Set(ground.doorCells.map((c) => `${c.x},${c.y}`));
    const rng = new Rng(11);
    const taken = new Set<string>();
    for (const kind of FIXTURE_KINDS) {
      for (const position of POSITION_WORDS) {
        const p = placeFixture({ kind, position }, ground, geom, rng, { taken: new Set() });
        for (const c of p?.cells ?? []) expect(doors.has(`${c.x},${c.y}`)).toBe(false);
      }
    }
    // And with a shared `taken`, nothing lands on anything else either.
    const seen = new Set<string>();
    for (const kind of FIXTURE_KINDS) {
      const p = placeFixture({ kind, position: "throughout" }, ground, geom, rng, { taken });
      for (const c of p?.cells ?? []) {
        const k = `${c.x},${c.y}`;
        expect(seen.has(k), "two fixtures in one cell").toBe(false);
        seen.add(k);
      }
    }
  });

  it("keeps everything inside the room", () => {
    const { ground, geom } = aRoom();
    const floor = new Set(ground.cells.map((c) => `${c.x},${c.y}`));
    const rng = new Rng(12);
    for (const kind of FIXTURE_KINDS) {
      for (const position of POSITION_WORDS) {
        const p = placeFixture({ kind, position }, ground, geom, rng, { taken: new Set() });
        for (const c of p?.cells ?? []) expect(floor.has(`${c.x},${c.y}`)).toBe(true);
      }
    }
  });

  it("rolls the count in code, inside the kind's own range", () => {
    // THE CLAUDE.MD RULE, as an assertion: the model names a kind and the code
    // decides how many there are. A count that ever came from the response
    // would show up here as a number outside the spec's range.
    const { ground, geom } = aRoom();
    const rng = new Rng(13);
    for (const kind of FIXTURE_KINDS) {
      const hi = FIXTURES[kind].count[1];
      for (let i = 0; i < 20; i++) {
        const p = placeFixture({ kind, position: "throughout" }, ground, geom, rng, {
          taken: new Set(),
        });
        expect(p, kind).toBeDefined();
        // Fewer than `lo` only when the room genuinely ran out of floor.
        expect(p!.cells.length).toBeLessThanOrEqual(hi);
        expect(p!.cells.length).toBeGreaterThan(0);
      }
    }
  });

  it("puts a wall-hugging thing against a wall even when told otherwise", () => {
    const { ground, geom } = aRoom();
    const walls = wallCells(ground.cells);
    const onAWall = new Set(
      [...walls.north, ...walls.south, ...walls.east, ...walls.west].map((c) => `${c.x},${c.y}`)
    );
    const rng = new Rng(14);
    for (const kind of FIXTURE_KINDS) {
      if (!FIXTURES[kind].hugsWall) continue;
      const p = placeFixture({ kind, position: "centre" }, ground, geom, rng, { taken: new Set() });
      expect(p!.position.endsWith("wall"), `${kind} asked for the centre`).toBe(true);
      for (const c of p!.cells) expect(onAWall.has(`${c.x},${c.y}`)).toBe(true);
    }
  });

  it("honours a wall it was actually given", () => {
    const { ground, geom } = aRoom();
    const rng = new Rng(15);
    for (const wall of ["north wall", "south wall", "east wall", "west wall"] as const) {
      const facing = new Set(
        wallCells(ground.cells)
          [wall.split(" ")[0] as "north"].map((c) => `${c.x},${c.y}`)
      );
      const p = placeFixture({ kind: "shelves", position: wall }, ground, geom, rng, {
        taken: new Set(),
      });
      expect(p!.position).toBe(wall);
      for (const c of p!.cells) expect(facing.has(`${c.x},${c.y}`)).toBe(true);
    }
  });

  it("puts 'far end' further from the way in than 'near the entrance'", () => {
    const { ground, geom } = aRoom();
    expect(ground.arrivalCell).toBeDefined();
    const from = ground.arrivalCell!;
    const d = (c: Point) => Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
    const rng = new Rng(16);
    // `placeAt`, not `placeFixture`, so no wall-hugging rule intervenes.
    let near = 0;
    let far = 0;
    for (let i = 0; i < 30; i++) {
      near += d(placeAt("near the entrance", ground, geom, rng, { taken: new Set() })!.cells[0]);
      far += d(placeAt("far end", ground, geom, rng, { taken: new Set() })!.cells[0]);
    }
    expect(far).toBeGreaterThan(near);
  });

  it("places a stocked thing on exactly one cell", () => {
    const { ground, geom } = aRoom();
    const rng = new Rng(17);
    for (const position of POSITION_WORDS) {
      const p = placeAt(position, ground, geom, rng, { taken: new Set() });
      expect(p!.cells.length, position).toBe(1);
      expect(p!.fixture, "a stocked thing came from no menu").toBeUndefined();
      // The word it was asked for, or `throughout` where that word had no floor
      // left to give — never a third thing, and never a wall it is not on.
      expect([position, "throughout"], position).toContain(p!.position);
    }
  });

  // 8a A6, the half that made the prose disagree with the drawing: the pool a
  // word admits can be empty, placement falls back through the whole room, and
  // the request used to be stored anyway — so the room block and the map hover
  // both said "along the north wall" about a marker in the middle of the floor.
  it("does not keep a position word it could not honour", () => {
    const { ground, geom } = aRoom();
    const north = wallCells(ground.cells).north;
    expect(north.length).toBeGreaterThan(0);
    const blocked = new Set(north.map((c) => `${c.x},${c.y}`));

    for (const p of [
      placeAt("north wall", ground, geom, new Rng(23), { taken: new Set(blocked) })!,
      placeFixture({ kind: "pillars", position: "north wall" }, ground, geom, new Rng(23), {
        taken: new Set(blocked),
      })!,
    ]) {
      expect(p.position).toBe("throughout");
      for (const c of p.cells) expect(blocked.has(`${c.x},${c.y}`)).toBe(false);
    }
  });

  // The reported symptom: debris "scattered across the floor" drawn as marks in
  // opposite corners, because `spread` is farthest-point sampling and the two
  // points furthest apart in any room are two of its corners.
  it("keeps `throughout` off the walls, where the room has an inside", () => {
    const { ground, geom } = aFatRoom();
    const floor = new Set(ground.cells.map((c) => `${c.x},${c.y}`));
    // Stated as the property rather than as the implementation: a cell is
    // interior when there is floor on all four sides of it.
    const surrounded = (c: Point) =>
      floor.has(`${c.x + 1},${c.y}`) &&
      floor.has(`${c.x - 1},${c.y}`) &&
      floor.has(`${c.x},${c.y + 1}`) &&
      floor.has(`${c.x},${c.y - 1}`);
    expect(ground.cells.some(surrounded), "this room has no inside to test").toBe(true);

    const rng = new Rng(24);
    for (const kind of FIXTURE_KINDS) {
      const p = placeFixture({ kind, position: "throughout" }, ground, geom, rng, {
        taken: new Set(),
      });
      // Wall-hugging kinds are moved to a wall on purpose and are not this
      // rule's business — what the object is outranks the word.
      if (!p || p.position !== "throughout") continue;
      for (const c of p.cells) expect(surrounded(c), `${kind} at ${c.x},${c.y}`).toBe(true);
    }
  });

  it("is deterministic for a seed, and different for a different one", () => {
    const { ground, geom } = aRoom();
    const run = (seed: number) => {
      const rng = new Rng(seed);
      return FIXTURE_KINDS.map((kind) =>
        placeFixture({ kind, position: "throughout" }, ground, geom, rng, { taken: new Set() })
      );
    };
    expect(run(21)).toEqual(run(21));
    expect(run(21)).not.toEqual(run(22));
  });

  it("gives up rather than overflowing a room with no floor left", () => {
    // A one-cell room whose only cell is a doorway: there is nowhere legal, and
    // the answer is to place nothing rather than to place it in the rock.
    const ground = { room: 0, cells: cells([0, 0]), doorCells: cells([0, 0]) };
    const geom = roomGeometry(
      { rooms: [cells([0, 0])], doors: [], surface: null } as never,
      { rooms: [{ entityId: "r", chunk: 0 }], edges: [], entrances: [0] } as never
    )[0];
    expect(placeFixture({ kind: "altar", position: "centre" }, ground, geom, new Rng(1))).toBeUndefined();
    expect(placeAt("centre", ground, geom, new Rng(1))).toBeUndefined();
  });
});
