/**
 * ROOM PLATES — who stands where
 *
 * The author's arrangement rules, against hand-built rooms: a leader in front
 * of its pack, the named side by side with the nameless behind them, a pack on
 * its own, solos apart, and never more than four behind.
 */

import { describe, expect, it } from "vitest";
import type { ICreature } from "./dungeon-entities.ts";
import { drawableCreatures, figureRole, FIGURES_BEHIND_MAX, roomClusters, spriteKeyOf } from "./plate-figures.ts";

let n = 0;
function creature(over: Partial<ICreature> & { bp: string }): ICreature {
  const { bp, ...rest } = over;
  return {
    id: `c${++n}`,
    type: "Creature",
    name: rest.name ?? bp,
    roomId: "r1",
    stats: { hitDice: 1, hp: 4, modifiers: {} },
    narrative: { blueprintId: bp },
    ...rest,
  } as ICreature;
}

describe("figureRole and spriteKeyOf", () => {
  it("a leader, a named person, a pack and a solo", () => {
    expect(figureRole(creature({ bp: "abbot", affiliationGroupId: "monks" }))).toBe("leader");
    expect(figureRole(creature({ bp: "people", base: "A wiry woman." }))).toBe("named");
    expect(figureRole(creature({ bp: "monks", count: 4 }))).toBe("group");
    expect(figureRole(creature({ bp: "child" }))).toBe("solo");
  });

  it("the same named person written into two rooms is one sprite; a pack is its template", () => {
    const a = creature({ bp: "people", name: "Beatrix", base: "A scholar.", roomId: "r1" });
    const b = creature({ bp: "people", name: "Beatrix", base: "A scholar.", roomId: "r2" });
    expect(spriteKeyOf(a)).toBe(spriteKeyOf(b));
    expect(spriteKeyOf(creature({ bp: "monks", count: 4 }))).toBe("monks");
  });
});

describe("drawableCreatures", () => {
  it("leaves out the hidden, the counted out and the elsewhere", () => {
    const here = creature({ bp: "monks", count: 3 });
    const all = [
      here,
      creature({ bp: "ghost", isHidden: true }),
      creature({ bp: "rats", count: 0 }),
      creature({ bp: "bats", roomId: "r2" }),
    ];
    expect(drawableCreatures(all, "r1")).toEqual([here]);
  });
});

describe("roomClusters", () => {
  it("a leader stands in front of its own pack, at most four behind", () => {
    const leader = creature({ bp: "abbot", affiliationGroupId: "monks" });
    const pack = creature({ bp: "monks", count: 10 });
    expect(roomClusters([pack, leader])).toEqual([{ front: ["abbot"], behind: Array(FIGURES_BEHIND_MAX).fill("monks") }]);
  });

  it("a pack of three with no one to lead it: one in front, two behind", () => {
    expect(roomClusters([creature({ bp: "monks", count: 3 })])).toEqual([{ front: ["monks"], behind: ["monks", "monks"] }]);
  });

  it("the named stand side by side, with the nameless behind them as if they led them", () => {
    const a = creature({ bp: "people", name: "Stilton", base: "A man in furs." });
    const b = creature({ bp: "people", name: "Wendy", base: "A woman in braids." });
    const pack = creature({ bp: "guards", count: 2 });
    expect(roomClusters([a, b, pack])).toEqual([
      { front: ["people:Stilton", "people:Wendy"], behind: ["guards", "guards"] },
    ]);
  });

  it("a leader takes only its own pack; anything else stands apart", () => {
    const leader = creature({ bp: "abbot", affiliationGroupId: "monks" });
    const monks = creature({ bp: "monks", count: 2 });
    const rats = creature({ bp: "rats", count: 6 });
    const child = creature({ bp: "child" });
    expect(roomClusters([child, rats, leader, monks])).toEqual([
      { front: ["abbot"], behind: ["monks", "monks"] },
      { front: ["rats"], behind: ["rats", "rats", "rats", "rats"] },
      { front: ["child"], behind: [] },
    ]);
  });

  it("a leader whose pack is all dead stands alone", () => {
    expect(roomClusters([creature({ bp: "abbot", affiliationGroupId: "monks" })])).toEqual([{ front: ["abbot"], behind: [] }]);
  });
});

describe("figureHeight", () => {
  it("is size × FIGURE_SCALE through the camera, capped so the head stays in the frame", async () => {
    const { figureHeight, FIGURE_HEADROOM } = await import("./plate-figures.ts");
    const f = { sprite: "x", x: 0.5, y: 0.8, perFoot: 0.05, flop: false };
    expect(figureHeight(f, "medium")).toBeCloseTo(0.05 * 6 * 1.4, 10);
    expect(figureHeight(f, "huge")).toBeCloseTo(0.8 - FIGURE_HEADROOM, 10);
  });
});
