import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateBlueprint,
  generateBlueprintSeed,
  stockDungeon,
  runEntitiesPass,
  Rng,
  canEquip,
  equip,
  validateEquipment,
  setState,
  setComposed,
  needsComposition,
  properName,
  hitDiceFor,
  maxHp,
  armorDefense,
  attackBonus,
  abilityBonus,
  abilityDefense,
  HALF_HIT_DIE_HP,
  type CreatureStats,
  type PlayerCharacter,
  type AnyItem,
  type IEntity,
  type Size,
} from "./index.ts";

const ENGINE_DIR = join(process.cwd(), "src/engine");

// ===========================================================================
// PURITY  (CLAUDE.md: src/engine never imports React, must run under vitest)
// ===========================================================================

describe("engine purity", () => {
  const files = readdirSync(ENGINE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("has engine files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports no framework or browser-only global", (file) => {
    const src = readFileSync(join(ENGINE_DIR, file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code, "must not import react").not.toMatch(/from\s+["']react/);
    expect(code, "must not read import.meta.env").not.toMatch(/import\.meta\.env/);
    expect(code, "must not touch document").not.toMatch(/\bdocument\./);
    expect(code, "must not touch window").not.toMatch(/\bwindow\./);
    // `process` at module scope threw in a browser bundle; that block is gone.
    expect(code, "must not touch process").not.toMatch(/\bprocess\./);
  });
});

// ===========================================================================
// MODEL STRINGS  (CLAUDE.md: they live only in models.ts)
// ===========================================================================

describe("model strings", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  }

  it("appear nowhere outside src/runtime/llm/models.ts", () => {
    const offenders = walk(join(process.cwd(), "src"))
      .filter((p) => !p.replace(/\\/g, "/").endsWith("src/runtime/llm/models.ts"))
      .filter((p) => !p.endsWith(".test.ts"))
      // Text models by their family prefix; image models by their fal endpoint shape.
      .filter((p) =>
        /["'](claude-[a-z0-9.-]+|fal-ai\/[a-z0-9.\/-]+|openai\/gpt-image[a-z0-9.\/-]*)["']/.test(readFileSync(p, "utf8"))
      );

    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// THE SKILL  (every steps/ path SKILL.md names must resolve)
// ===========================================================================

describe("dungeon-loop skill", () => {
  const root = join(process.cwd(), "src/runtime/prompts/dungeon-loop");

  it("every steps/ file SKILL.md references exists", () => {
    const skill = readFileSync(join(root, "SKILL.md"), "utf8");
    const referenced = [...skill.matchAll(/`steps\/([\w-]+\.md)`/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);

    const present = new Set(readdirSync(join(root, "steps")));
    expect(referenced.filter((f) => !present.has(f))).toEqual([]);
  });

  it("has a step file for every stage that takes a model call", () => {
    const present = readdirSync(join(root, "steps"));
    for (const f of [
      "1-determine-target.md",
      "2-validate-and-classify.md",
      "3-handle-by-type.md",
      "3-information.md",
      "3-standard.md",
      "4-confirm-and-roll.md",
      "5-resolution.md",
      "room-entry.md",
    ]) {
      expect(present, `missing ${f}`).toContain(f);
    }
  });
});

// ===========================================================================
// GRAPH VALIDITY  (phase A's own validator, across a seed spread)
// ===========================================================================

describe("graph generation", () => {
  const chunkCounts = [1, 2, 3, 4, 5];
  const seeds = ["1001", "1002", "1003", "1004", "1005", "7919", "42"];

  it.each(chunkCounts)("produces a valid graph at %i chunk(s) across seeds", (chunks) => {
    for (const seed of seeds) {
      const { dungeon } = generateBlueprint(seed, { chunks }, true);
      expect(dungeon.valid, `seed ${seed} / ${chunks} chunks: ${dungeon.failures.join("; ")}`).toBe(true);
      expect(dungeon.rooms).toHaveLength(chunks * 6);
    }
  });
});

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

// ===========================================================================
// EQUIPMENT  (D1 — armorType now exists; guard the behaviour that depended on it)
// ===========================================================================

function item(id: string, over: Partial<AnyItem> = {}): AnyItem {
  return { id, name: id, type: "Item", parentId: "pc", slots: 1, value: 0, ...over } as AnyItem;
}

function pcWith(...items: AnyItem[]): PlayerCharacter {
  return {
    id: "pc",
    name: "Test",
    level: 1,
    hp: { current: 6, max: 6 },
    abilities: { str: 2, dex: 1, con: 2, int: 1, wis: 1, cha: 1 },
    traits: {
      physique: "Wiry", face: "Bony", skin: "Ashen", hair: "Cropped", clothing: "Patched",
      virtue: "Cautious", vice: "Greedy", speech: "Blunt", background: "Burglar",
      misfortunes: "Exiled", alignment: "Neutrality",
    },
    inventory: items,
    equipped: {},
    conditions: [],
  };
}

const gambeson = () => item("gambeson", { itemKind: "armor", armor: { armorType: "body", defense: 12 } });
const helmet = () => item("helmet", { itemKind: "armor", armor: { armorType: "helmet", defense: 1 } });
const shield = () => item("shield", { itemKind: "armor", armor: { armorType: "shield", defense: 1 } });
const sword = () => item("sword", { itemKind: "weapon", weapon: { damage: "1d8", hands: 1 } });
const halberd = () => item("halberd", { itemKind: "weapon", weapon: { damage: "1d10", hands: 2 }, slots: 3 });

describe("equipment", () => {
  it("each armor kind fits its own slot and no other", () => {
    const pc = pcWith(gambeson(), helmet(), shield(), sword());
    expect(equip(pc, "armor", "gambeson").ok).toBe(true);
    expect(equip(pc, "helmet", "helmet").ok).toBe(true);
    expect(equip(pc, "shield", "shield").ok).toBe(true);
    expect(equip(pc, "weapon", "sword").ok).toBe(true);
    expect(validateEquipment(pc)).toEqual([]);

    expect(canEquip(pc, "armor", "helmet").ok).toBe(false);
    expect(canEquip(pc, "helmet", "gambeson").ok).toBe(false);
    expect(canEquip(pc, "shield", "sword").ok).toBe(false);
    expect(canEquip(pc, "weapon", "gambeson").ok).toBe(false);
  });

  it("refuses a shield alongside a two-handed weapon, in both orders", () => {
    const a = pcWith(halberd(), shield());
    expect(equip(a, "weapon", "halberd").ok).toBe(true);
    expect(canEquip(a, "shield", "shield").ok).toBe(false);

    const b = pcWith(halberd(), shield());
    expect(equip(b, "shield", "shield").ok).toBe(true);
    expect(canEquip(b, "weapon", "halberd").ok).toBe(false);
  });

  it("refuses an item the character is not carrying", () => {
    expect(canEquip(pcWith(), "weapon", "sword").ok).toBe(false);
  });
});

// ===========================================================================
// COMPOSITION STALENESS  (S3 — needUpdate, not a cleared composed)
// ===========================================================================

describe("composition staleness", () => {
  const entity = (): IEntity => ({ id: "e1", name: "Desk", type: "RoomFeature" });

  it("never-encountered needs composition", () => {
    expect(needsComposition(entity())).toBe(true);
  });

  it("a state change marks it stale but keeps the old description", () => {
    const e = entity();
    setComposed(e, "A writing desk, lid closed.");
    expect(needsComposition(e)).toBe(false);

    setState(e, "overturned, its drawers spilled");
    expect(e.needUpdate).toBe(true);
    expect(e.composed, "the old description survives until it is rewritten").toBe(
      "A writing desk, lid closed."
    );
    expect(needsComposition(e)).toBe(true);
  });

  it("recomposing clears the flag", () => {
    const e = entity();
    setState(e, "overturned");
    setComposed(e, "The desk lies on its side.");
    expect(needsComposition(e)).toBe(false);
  });
});

// ===========================================================================
// NAMES  (8f: a player-visible name is a label, and a label is capitalised)
// ===========================================================================

describe("properName", () => {
  it("raises the first letter", () => {
    expect(properName("unmarked ledger")).toBe("Unmarked ledger");
  });

  it("leaves the rest of the name exactly as written", () => {
    // Not title case: which words belong to a proper name is not knowable here,
    // and guessing is wrong more often than the lower-case letter it set out to
    // fix.
    expect(properName("iron keyring of the Warden")).toBe("Iron keyring of the Warden");
    expect(properName("The Cutlass")).toBe("The Cutlass");
  });

  it("is a no-op on what is already right, and on what has no letter to raise", () => {
    expect(properName("Wendy Wilberforce")).toBe("Wendy Wilberforce");
    expect(properName("3 coins")).toBe("3 coins");
    expect(properName("")).toBe("");
  });

  it("trims, so a stray space cannot hide the first letter", () => {
    expect(properName("  brass key ")).toBe("Brass key");
  });
});

// ===========================================================================
// THE LEVEL 0 BAND
// ===========================================================================

/*
 * HD 0 IS A BAND, NOT A FLOOR THAT GOT HIT. A level 0 creature is what a level
 * 1 character is meant to be able to kill: +0 to everything, defense 10, half a
 * hit die. Every formula falls out of `hitDice === 0` on its own except HP,
 * which would multiply to nothing, and armour defense, which would be the
 * unarmoured 11 -- so those two are what these tests are actually guarding.
 */
describe("level 0 creatures", () => {
  const fodder: CreatureStats = { hitDice: 0, hp: HALF_HIT_DIE_HP, modifiers: {} };

  it("is +0 to every bonus and 10 to every defense", () => {
    expect(attackBonus(fodder)).toBe(0);
    expect(abilityBonus(fodder, "str")).toBe(0);
    expect(abilityDefense(fodder, "dex")).toBe(10);
    expect(armorDefense(fodder)).toBe(10);
  });

  it("has half a hit die rather than no hit points", () => {
    // 2 is what 1d4 and 1d8/2 both average to, taken the way full HD are taken
    // as 4. Multiplying would give a creature that is absent, not weak.
    expect(maxHp(fodder)).toBe(HALF_HIT_DIE_HP);
    expect(maxHp(fodder)).toBe(2);
    expect(maxHp({ ...fodder, hitDice: 1 })).toBe(4);
  });

  it("keeps armour it is actually wearing", () => {
    // The 10 is a default for a bare creature, not a cap on the band.
    expect(armorDefense({ ...fodder, armorDefense: 14 })).toBe(14);
  });

  it("is what a level 0 dungeon stocks", () => {
    const rng = new Rng(4242);
    const drawn = new Set<number>();
    for (let i = 0; i < 200; i++) drawn.add(hitDiceFor("simple", 0, rng));
    // `simple` is level-1..level+0, so a level 0 dungeon's simple creatures are
    // the band itself and nothing below it.
    expect(drawn.has(0)).toBe(true);
    expect(Math.min(...drawn)).toBe(0);
  });

  it("still floors at 0 for anything that would go lower", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 200; i++) {
      expect(hitDiceFor("simple", 0, rng)).toBeGreaterThanOrEqual(0);
    }
  });
});
