import { describe, expect, it } from "vitest";
import { generateBlueprint } from "./floorplan/graph.ts";
import { generateBlueprintSeed, type Size } from "./content/blueprint.ts";
import { Rng } from "../shared/utils/rng.ts";
import { stockDungeon } from "./content/stock/stock.ts";
import { runEntitiesPass } from "./content/entities-pass.ts";

// ===========================================================================
// DETERMINISM  (same seed in, same dungeon out — ids stripped, per G5)
// ===========================================================================

/**
 * Entity ids are deliberately unseeded (`makeId` uses crypto.randomUUID, and
 * says so), so a same-seed comparison has to ignore them. Strip anything that
 * holds or references an id — `id`, anything ending `Id`/`Ids`, and the arrays
 * of ids that hang off stocking — and compare the content that remains.
 */
const ID_KEY = /^id$|Id$|Ids$/;
const ID_LIST = new Set(["occupants", "connectors"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !ID_KEY.test(k) && !ID_LIST.has(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

function stockFor(seed: number, size: Size) {
  const bp = generateBlueprintSeed(size, seed);
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  return { bp, sd: stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 }) };
}

describe("determinism", () => {
  it.each([1005, 4242, 77])("seed %i gives an identical blueprint twice", (seed) => {
    expect(canonical(generateBlueprintSeed(3, seed))).toEqual(canonical(generateBlueprintSeed(3, seed)));
  });

  it.each([1005, 4242])("seed %i gives identical stocking twice in one process", (seed) => {
    const a = stockFor(seed, 2);
    const b = stockFor(seed, 2);
    expect(canonical(a.sd)).toEqual(canonical(b.sd));
  });

  it("mobile ids repeat across two stockings of the same seed (D3)", () => {
    const a = stockFor(1005, 2).sd.mobiles.map((m) => m.id);
    const b = stockFor(1005, 2).sd.mobiles.map((m) => m.id);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("the entities pass is stable for a fixed seed", () => {
    const { bp, sd } = stockFor(1005, 2);
    const one = runEntitiesPass(sd, bp, new Rng(sd.seed));
    const two = runEntitiesPass(sd, bp, new Rng(sd.seed));
    expect(canonical(one.rooms)).toEqual(canonical(two.rooms));
    expect(canonical(one.creatures)).toEqual(canonical(two.creatures));
  });
});
