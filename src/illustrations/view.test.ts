/**
 * ILLUSTRATION VIEW
 *
 * Two halves. `viewFrom` is a derivation — one camera, where everything lands —
 * tested on hand-built floors where the answer is obvious by eye. `illustrationView`
 * is a search, tested on what it must achieve: every feature in the picture
 * wherever that is possible, the room's corners and doorways used to get it.
 */

import { describe, expect, it } from "vitest";
import { CELL_FEET } from "../generation/floorplan/geometry.ts";
import {
  featureWhere,
  ILLUSTRATION_MIN_AHEAD_FT,
  ILLUSTRATION_SCORE,
  illustrationView,
  unseenReason,
  viewFrom,
  type IllustrationViewInput,
} from "./view.ts";
import type { Point } from "../shared/utils/grid.ts";

/** Every cell in a w x h box with its top-left at (x, y). */
function box(x: number, y: number, w: number, h: number): Point[] {
  const out: Point[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push({ x: x + i, y: y + j });
  return out;
}

/** A floor drawn as text: "." is floor, "#" rock. Row 0 is north. */
function plan(rows: string[]): Point[] {
  return rows.flatMap((r, y) => [...r].flatMap((ch, x) => (ch === "." ? [{ x, y }] : [])));
}

/** A 5x5 room, entered from the middle of its south wall. North is up. */
const square = (extra: Partial<IllustrationViewInput> = {}): IllustrationViewInput => ({
  floor: box(0, 0, 5, 5),
  entry: { id: "in", inside: { x: 2, y: 4 }, outside: { x: 2, y: 5 } },
  exits: [],
  features: [],
  ...extra,
});

/** Standing just inside the south door of `square`, looking north. */
const SOUTH_DOOR: Point = { x: 2.5 * CELL_FEET, y: 5 * CELL_FEET - 1 };
const NORTH: Point = { x: 0, y: -1 };

describe("viewFrom", () => {
  it("measures the room from the eye", () => {
    const v = viewFrom(square(), SOUTH_DOOR, NORTH);
    expect(v.facing).toBe("north");
    expect(Math.round(v.deep)).toBe(24);
    expect(Math.round(v.wide)).toBe(25);
  });

  it("puts each door in the wall the viewer would point at", () => {
    const v = viewFrom(
      square({
        exits: [
          { id: "north", inside: { x: 2, y: 0 }, outside: { x: 2, y: -1 } },
          { id: "west", inside: { x: 0, y: 1 }, outside: { x: -1, y: 1 } },
          { id: "east", inside: { x: 4, y: 1 }, outside: { x: 5, y: 1 } },
        ],
      }),
      SOUTH_DOOR,
      NORTH
    );
    const by = Object.fromEntries(v.exits.map((s) => [s.id, s]));
    expect(by.north).toMatchObject({ wall: "far", side: "centre", depth: "far", visible: true });
    expect(by.west).toMatchObject({ wall: "left", side: "left", visible: true });
    expect(by.east).toMatchObject({ wall: "right", side: "right", visible: true });
    // The door the eye is standing at is behind it.
    expect(v.entry.wall).toBe("behind");
  });

  it("places features by depth and side", () => {
    const v = viewFrom(
      square({
        features: [
          { id: "back-right", cells: [{ x: 4, y: 0 }] },
          { id: "ahead", cells: [{ x: 2, y: 1 }] },
        ],
      }),
      SOUTH_DOOR,
      NORTH
    );
    const by = Object.fromEntries(v.features.map((s) => [s.id, s]));
    expect(by["back-right"]).toMatchObject({ depth: "far", side: "right" });
    expect(by.ahead).toMatchObject({ side: "centre" });
  });

  it("says a feature in separate places piece by piece, not by its empty middle", () => {
    const v = viewFrom(
      square({ features: [{ id: "niches", cells: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }] }),
      SOUTH_DOOR,
      NORTH
    );
    const where = featureWhere(v.features[0]);
    expect(where).toMatch(/^in 2 places: /);
    expect(where).toContain("on the left");
    expect(where).toContain("on the right");
  });

  it("does not count what is at the viewer's feet: the frame's bottom edge cuts it off", () => {
    const v = viewFrom(square({ features: [{ id: "feet", cells: [{ x: 2, y: 4 }] }] }), SOUTH_DOOR, NORTH);
    expect(v.features[0].ahead).toBeLessThan(ILLUSTRATION_MIN_AHEAD_FT);
    expect(unseenReason(v.features[0])).toBe("outside the frame");
  });

  it("does not see past the tip of a rock corner", () => {
    // Seed 4201's Stone Dormitory, which a sampled sight line got wrong: the
    // line from the doorway to the east door clips the corner of (3,5).
    const floor = plan(["#..###", "#...##", "#....#", "#....#", "#...##", "#..###"]);
    const v = viewFrom(
      {
        floor,
        entry: { id: "in", inside: { x: 2, y: 5 }, outside: { x: 2, y: 6 } },
        exits: [{ id: "east", inside: { x: 4, y: 2 }, outside: { x: 5, y: 2 } }],
        features: [],
      },
      { x: 2.5 * CELL_FEET, y: 6 * CELL_FEET - 1 },
      { x: 0.02, y: -1 }
    );
    expect(v.exits[0].inSight).toBe(false);
  });
});

describe("illustrationView", () => {
  it("weighs a feature above any floor, a way out above a little floor, and the way in below other ways out", () => {
    expect(ILLUSTRATION_SCORE.feature).toBeGreaterThan(ILLUSTRATION_SCORE.exit);
    expect(ILLUSTRATION_SCORE.exit).toBeGreaterThan(ILLUSTRATION_SCORE.entry);
    expect(ILLUSTRATION_SCORE.entry).toBeGreaterThan(ILLUSTRATION_SCORE.tile);
  });

  it("frames every feature in an open room", () => {
    const v = illustrationView(
      square({
        features: [
          { id: "nw", cells: [{ x: 0, y: 0 }] },
          { id: "ne", cells: [{ x: 4, y: 0 }] },
          { id: "mid", cells: [{ x: 2, y: 2 }] },
          { id: "sw", cells: [{ x: 0, y: 4 }] },
        ],
      })
    );
    expect(v.features.filter((s) => !s.visible).map((s) => s.id)).toEqual([]);
  });

  it("steps round the corner of an L to see what the doorway cannot", () => {
    // A 2-wide passage running north, opening east at its top into an arm.
    //   ......
    //   ......
    //   ..
    //   ..
    //   ..      <- entered from the south
    const v = illustrationView({
      floor: [...box(0, 0, 6, 2), ...box(0, 2, 2, 3)],
      entry: { id: "in", inside: { x: 0, y: 4 }, outside: { x: 0, y: 5 } },
      exits: [{ id: "far-east", inside: { x: 5, y: 1 }, outside: { x: 6, y: 1 } }],
      features: [
        { id: "round-the-corner", cells: [{ x: 5, y: 0 }] },
        { id: "in-the-passage", cells: [{ x: 1, y: 2 }] },
      ],
    });
    expect(v.features.every((s) => s.visible)).toBe(true);
    expect(v.exits[0].visible).toBe(true);
  });

  it("never stands in a doorway, even when the room is too small to frame from inside", () => {
    // 10 ft square, both features against the north wall. Nowhere on the floor
    // is far enough back for the frame's bottom edge to clear them both, and
    // the doorway behind is off limits: the camera stays on the room's floor.
    const input: IllustrationViewInput = {
      floor: box(0, 0, 2, 2),
      entry: { id: "in", inside: { x: 0, y: 1 }, outside: { x: 0, y: 2 } },
      exits: [],
      features: [
        { id: "a", cells: [{ x: 0, y: 0 }] },
        { id: "b", cells: [{ x: 1, y: 0 }] },
      ],
    };
    const v = illustrationView(input);
    const cell = { x: Math.floor(v.eye.x / CELL_FEET), y: Math.floor(v.eye.y / CELL_FEET) };
    expect(input.floor).toContainEqual(cell);
  });

  it("is the same view every time", () => {
    const input = square({ features: [{ id: "x", cells: [{ x: 1, y: 1 }] }] });
    expect(illustrationView(input)).toEqual(illustrationView(input));
  });

  it("keeps an unplaced feature in the list, in view", () => {
    const v = illustrationView(square({ features: [{ id: "loose", cells: [] }] }));
    expect(v.features[0]).toMatchObject({ placed: false, visible: true });
  });
});
