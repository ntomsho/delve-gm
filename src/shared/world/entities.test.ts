import { describe, expect, it } from "vitest";
import {
  setState,
  setComposed,
  needsComposition,
  properName,
  maxHp,
  armorDefense,
  attackBonus,
  abilityBonus,
  abilityDefense,
  HALF_HIT_DIE_HP,
  type CreatureStats,
  type IEntity,
} from "./entities.ts";
import { Rng } from "../utils/rng.ts";
import { hitDiceFor } from "../../generation/content/entities-pass.ts";

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
