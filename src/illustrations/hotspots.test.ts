/**
 * ILLUSTRATION HOTSPOTS AND FEATURE PRESENCE
 *
 * Hotspots are tested on hand-built floors with a fixed camera (`viewFrom`),
 * so each outcome — shown, round a corner, off an edge — is forced rather than
 * hoped for. Presence is a lookup, tested on the entries that matter.
 */

import { describe, expect, it } from "vitest";
import { CELL_FEET } from "../generation/floorplan/geometry.ts";
import { featurePresence } from "./feature-presence.ts";
import { illustrationHotspots } from "./hotspots.ts";
import { viewFrom, type IllustrationViewInput } from "./view.ts";
import type { Point } from "../shared/utils/grid.ts";

function box(x: number, y: number, w: number, h: number): Point[] {
  const out: Point[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push({ x: x + i, y: y + j });
  return out;
}

const NORTH: Point = { x: 0, y: -1 };

describe("illustrationHotspots", () => {
  /** A 5x5 room entered from the south, looked at from just inside that door. */
  const square: IllustrationViewInput = {
    floor: box(0, 0, 5, 5),
    entry: { id: "in", inside: { x: 2, y: 4 }, outside: { x: 2, y: 5 } },
    exits: [
      { id: "north", inside: { x: 2, y: 0 }, outside: { x: 2, y: -1 } },
      { id: "beside", inside: { x: 0, y: 4 }, outside: { x: -1, y: 4 } },
    ],
    features: [{ id: "altar", cells: [{ x: 1, y: 1 }] }],
  };
  const eye = { x: 2.5 * CELL_FEET, y: 5 * CELL_FEET - 1 };
  const hs = Object.fromEntries(illustrationHotspots(square, viewFrom(square, eye, NORTH)).map((h) => [h.id, h]));

  it("puts a button on what is in the picture, inside the frame", () => {
    expect(hs.north.status).toBe("shown");
    expect(hs.altar.status).toBe("shown");
    for (const q of [...hs.north.points, ...hs.altar.points]) {
      expect(q.x).toBeGreaterThanOrEqual(0);
      expect(q.x).toBeLessThanOrEqual(1);
      expect(q.y).toBeGreaterThanOrEqual(0);
      expect(q.y).toBeLessThanOrEqual(1);
    }
    // The north door is straight ahead, so dead centre left to right; the altar is left of it.
    expect(hs.north.points[0].x).toBeCloseTo(0.5, 2);
    expect(hs.altar.points[0].x).toBeLessThan(0.5);
  });

  it("points off the edge at what is beside or behind the camera", () => {
    expect(hs.beside).toMatchObject({ status: "off-frame", edge: "left" });
    // The camera is standing in the way in: under it, not to one side.
    expect(hs.in).toMatchObject({ role: "entry", status: "off-frame", edge: "bottom" });
  });

  it("says where along its edge each arrow goes, from the bearing", () => {
    // Standing mid-room looking north: two doors in the west wall, one beside
    // and one a little behind, one in the south-west corner further behind
    // still, and the way in dead behind.
    const mid: IllustrationViewInput = {
      floor: box(0, 0, 5, 5),
      entry: { id: "in", inside: { x: 2, y: 4 }, outside: { x: 2, y: 5 } },
      exits: [
        { id: "west", inside: { x: 0, y: 2 }, outside: { x: -1, y: 2 } },
        { id: "west-back", inside: { x: 0, y: 3 }, outside: { x: -1, y: 3 } },
        { id: "sw", inside: { x: 0, y: 4 }, outside: { x: 0, y: 5 } },
      ],
      features: [],
    };
    const at = Object.fromEntries(
      illustrationHotspots(mid, viewFrom(mid, { x: 12.5, y: 12.5 }, NORTH)).map((h) => [h.id, h])
    );
    expect(at.west).toMatchObject({ status: "off-frame", edge: "left" });
    expect(at["west-back"]).toMatchObject({ status: "off-frame", edge: "left" });
    // Further behind, lower down the side.
    expect(at["west-back"].along!).toBeGreaterThan(at.west.along!);
    // Dead behind is the middle of the bottom; behind and to the left is left of it.
    expect(at.in).toMatchObject({ edge: "bottom" });
    expect(at.in.along).toBeCloseTo(0.5, 2);
    expect(at.sw).toMatchObject({ edge: "bottom" });
    expect(at.sw.along!).toBeLessThan(0.5);
  });

  it("finds the corner to go round, and which way it turns", () => {
    // A passage running north, then turning east into an arm. Looking up the
    // passage, the door at the end of the arm is round the corner to the right.
    //   ......
    //   ......
    //   ..
    //   ..
    //   ..      <- eye
    const L: IllustrationViewInput = {
      floor: [...box(0, 0, 6, 2), ...box(0, 2, 2, 3)],
      entry: { id: "in", inside: { x: 0, y: 4 }, outside: { x: 0, y: 5 } },
      exits: [{ id: "east", inside: { x: 5, y: 1 }, outside: { x: 6, y: 1 } }],
      features: [],
    };
    const v = viewFrom(L, { x: 5, y: 24 }, NORTH);
    const east = illustrationHotspots(L, v).find((h) => h.id === "east")!;
    expect(east.status).toBe("around");
    expect(east.around?.turn).toBe("right");
    expect(east.around!.x).toBeGreaterThan(0.5);
    // The arrow is the button: no dashed one as well.
    expect(east.points).toEqual([]);
  });
});

describe("featurePresence", () => {
  it("knows a sound, a stain and a thing", () => {
    expect(featurePresence({ "Room Detail": "Faint footsteps" }, "far end")).toBe("sense");
    expect(featurePresence({ "Room Detail": "Smoke stains" }, "throughout")).toBe("surface");
    expect(featurePresence({ Obstacle: "Smoke", "Cairn Feature": "Charges" }, "centre")).toBe("surface");
    expect(featurePresence({ Obstacle: "Treasure", "Cairn Feature": "Ages" }, "centre")).toBe("object");
  });

  it("always draws a fixture, and reads 'throughout' as a surface", () => {
    expect(featurePresence({ Fixture: "pool" }, "throughout")).toBe("object");
    expect(featurePresence({ "Room Detail": "Chains" }, "throughout")).toBe("surface");
    expect(featurePresence({ "Room Detail": "Chains" }, "centre")).toBe("object");
  });
});
