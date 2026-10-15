/**
 * LEVELLING, as arithmetic.
 *
 * Three rules and nothing else: when a level is owed, what the d8s do to a hit
 * point maximum, and what three raises do to a sheet. The screen refuses the
 * moves that break them — these tests are what says the rules exist somewhere
 * the screen is not.
 *
 * Headless, per the extension rule in `vite.config.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  ABILITY_MAX,
  applyLevelUp,
  canLevelUp,
  hpFromRoll,
  levelUpRoll,
  levelUpSeed,
  nextLevel,
  pendingLevels,
  raisableAbilities,
  RAISES_PER_LEVEL,
  requiredRaises,
  rollLevelUpHp,
  XP_PER_LEVEL,
} from "./level-up.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { type PlayerCharacter } from "./character.ts";

const SEED = 20260820;

/** Enough of a sheet for the rules under test. Nothing here reads the rest. */
const sheet = (over: Partial<PlayerCharacter> = {}): PlayerCharacter =>
  ({
    id: "pc",
    name: "Wendy Relish",
    level: 1,
    hp: { current: 12, max: 12 },
    abilities: { str: 3, dex: 2, con: 4, int: 1, wis: 2, cha: 1 },
    traits: {},
    inventory: [],
    equipped: {},
    conditions: [],
    ...over,
  }) as PlayerCharacter;

describe("what is owed", () => {
  it("owes nothing under a thousand", () => {
    expect(pendingLevels(sheet({ xp: 999 }))).toBe(0);
    expect(canLevelUp(sheet({ xp: 999 }))).toBe(false);
  });

  it("owes a level at exactly the track", () => {
    expect(pendingLevels(sheet({ xp: XP_PER_LEVEL }))).toBe(1);
    expect(canLevelUp(sheet({ xp: XP_PER_LEVEL }))).toBe(true);
  });

  it("owes one per thousand, cumulative — a size 5 dungeon pays for three", () => {
    expect(pendingLevels(sheet({ xp: 3000 }))).toBe(3);
  });

  it("counts what has been claimed, not what has been earned", () => {
    expect(pendingLevels(sheet({ xp: 3000, level: 3 }))).toBe(1);
    expect(pendingLevels(sheet({ xp: 3000, level: 4 }))).toBe(0);
  });

  it("treats a character from before the tally as unpaid rather than broken", () => {
    expect(pendingLevels(sheet())).toBe(0);
  });
});

describe("the new maximum", () => {
  it("takes the dice when they beat what was there", () => {
    expect(hpFromRoll(19, 12)).toBe(19);
  });

  it("gives a point when the dice come in under", () => {
    expect(hpFromRoll(7, 12)).toBe(13);
  });

  it("gives a point on a tie too, so a better roll is never worth less", () => {
    // Knave says "less than"; the tie is the one result that would pay nothing.
    expect(hpFromRoll(12, 12)).toBe(13);
    expect(hpFromRoll(11, 12)).toBe(13);
  });

  it("rolls one d8 per level of the level being taken", () => {
    const pc = sheet({ level: 3 });
    const roll = rollLevelUpHp(new Rng(SEED), pc);
    expect(roll.dice).toHaveLength(nextLevel(pc));
    expect(roll.dice.every((d) => d >= 1 && d <= 8)).toBe(true);
    expect(roll.total).toBe(roll.dice.reduce((a, b) => a + b, 0));
  });

  it("says when the rule did the work rather than the dice", () => {
    const thin = rollLevelUpHp(new Rng(SEED), sheet({ hp: { current: 40, max: 40 } }));
    expect(thin.floored).toBe(true);
    expect(thin.hpMax).toBe(41);

    const fat = rollLevelUpHp(new Rng(SEED), sheet({ hp: { current: 2, max: 2 } }));
    expect(fat.floored).toBe(false);
    expect(fat.hpMax).toBe(fat.total);
  });

  it("is the same roll from the same seed", () => {
    const pc = sheet();
    expect(rollLevelUpHp(new Rng(SEED), pc)).toEqual(rollLevelUpHp(new Rng(SEED), pc));
  });
});

describe("the dice are decided before the button", () => {
  it("gives one character's next level the same roll every time it is asked", () => {
    const pc = sheet({ id: "a-particular-person" });
    expect(levelUpRoll(pc)).toEqual(levelUpRoll(pc));
    expect(levelUpRoll(pc)).toEqual(levelUpRoll(structuredClone(pc)));
  });

  it("gives the next level after that a different one", () => {
    const pc = sheet({ id: "a-particular-person" });
    expect(levelUpSeed(pc)).not.toBe(levelUpSeed(sheet({ id: pc.id, level: 2 })));
  });

  it("gives two characters different dice", () => {
    expect(levelUpSeed(sheet({ id: "one" }))).not.toBe(levelUpSeed(sheet({ id: "two" })));
  });
});

describe("the three raises", () => {
  it("wants three, and only from under the ceiling", () => {
    const pc = sheet();
    expect(requiredRaises(pc)).toBe(RAISES_PER_LEVEL);
    expect(raisableAbilities(pc)).toEqual(["str", "dex", "con", "int", "wis", "cha"]);
  });

  it("drops an ability off the list at the ceiling", () => {
    const pc = sheet({ abilities: { str: ABILITY_MAX, dex: 2, con: 4, int: 1, wis: 2, cha: 1 } });
    expect(raisableAbilities(pc)).not.toContain("str");
    expect(requiredRaises(pc)).toBe(RAISES_PER_LEVEL);
  });

  it("asks for fewer when there are fewer left to raise", () => {
    const capped = ABILITY_MAX;
    const pc = sheet({
      abilities: { str: capped, dex: capped, con: capped, int: capped, wis: capped, cha: 1 },
    });
    expect(requiredRaises(pc)).toBe(1);
  });
});

describe("taking the level", () => {
  const take = (pc: PlayerCharacter, raises: Parameters<typeof applyLevelUp>[1]["raises"]) =>
    applyLevelUp(pc, { roll: rollLevelUpHp(new Rng(SEED), pc), raises });

  it("raises the level, the maximum, and exactly the three chosen", () => {
    const pc = sheet();
    const roll = rollLevelUpHp(new Rng(SEED), pc);
    const next = applyLevelUp(pc, { roll, raises: ["str", "wis", "cha"] });

    expect(next.level).toBe(2);
    expect(next.hp.max).toBe(roll.hpMax);
    expect(next.abilities).toEqual({ str: 4, dex: 2, con: 4, int: 1, wis: 3, cha: 2 });
  });

  it("carries the current total up with the maximum", () => {
    const pc = sheet({ hp: { current: 12, max: 12 } });
    const next = take(pc, ["str", "dex", "con"]);
    expect(next.hp.current).toBe(next.hp.max);
  });

  it("gains the same points for somebody who was not at full", () => {
    const pc = sheet({ hp: { current: 4, max: 12 } });
    const next = take(pc, ["str", "dex", "con"]);
    expect(next.hp.current).toBe(4 + (next.hp.max - 12));
    expect(next.hp.current).toBeLessThan(next.hp.max);
  });

  it("does not touch the sheet it was given", () => {
    const pc = sheet();
    const before = structuredClone(pc);
    take(pc, ["str", "dex", "con"]);
    expect(pc).toEqual(before);
  });

  it("leaves the experience where it is — the track is cumulative", () => {
    const pc = sheet({ xp: 2400, level: 2 });
    expect(take(pc, ["str", "dex", "con"]).xp).toBe(2400);
  });

  it("refuses the wrong number of raises", () => {
    const pc = sheet();
    expect(() => take(pc, ["str", "dex"])).toThrow(/raises 3/);
    expect(() => take(pc, ["str", "dex", "con", "int"])).toThrow(/raises 3/);
  });

  it("refuses the same ability twice", () => {
    expect(() => take(sheet(), ["str", "str", "con"])).toThrow(/different/);
  });

  it("refuses an ability already at the ceiling", () => {
    const pc = sheet({ abilities: { str: ABILITY_MAX, dex: 2, con: 4, int: 1, wis: 2, cha: 1 } });
    expect(() => take(pc, ["str", "dex", "con"])).toThrow(/ceiling/);
  });

  it("clears what was owed, one level at a time", () => {
    const pc = sheet({ xp: 2000 });
    expect(pendingLevels(pc)).toBe(2);
    const second = take(pc, ["str", "dex", "con"]);
    expect(pendingLevels(second)).toBe(1);
    expect(pendingLevels(take(second, ["str", "dex", "con"]))).toBe(0);
  });
});
