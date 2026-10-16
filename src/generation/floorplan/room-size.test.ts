/**
 * THE SIZE VOCABULARY: the bands, and the archetypes the identity roll is
 * conditioned on through `sizeAllows`.
 */

import { describe, expect, it } from "vitest";
import { ARCHETYPES, AREA } from "./room-size.ts";
import {
  BUILDING_ROOMS,
  DUNGEON_ROOMS,
  LOWER_CLASS_BUILDINGS,
  UPPER_CLASS_BUILDINGS,
} from "../../rules/maze-rats/tables.ts";

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
    // unannotated nouns still roll among the size classes.
    expect(Object.keys(ARCHETYPES).length).toBeLessThan(30);
  });

  it("has bands that are contiguous and do not invert", () => {
    // A gap between bands — an earlier draft had 9 to 12 and 36 to 42 — was a
    // direct cause of the size-4/5 packing failure: a room pinned between two
    // fixed neighbours has its width dictated, and if the only areas it can
    // reach land in a hole there is no legal room at all.
    const bands = Object.values(AREA);
    for (const [lo, hi] of bands) expect(lo).toBeLessThan(hi);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i][0], "each band starts where the last one stopped").toBe(bands[i - 1][1] + 1);
    }
  });

  it("pins a size or raises the floor, and nothing else", () => {
    expect(ARCHETYPES.Well).toEqual({ sizeClass: "tiny" });
    expect(ARCHETYPES.Courtyard).toEqual({ minClass: "large" });
    for (const [noun, a] of Object.entries(ARCHETYPES)) {
      expect(a.sizeClass ?? a.minClass, `${noun} constrains nothing`).toBeDefined();
    }
  });
});
