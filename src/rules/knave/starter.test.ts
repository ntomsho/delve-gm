import { describe, expect, it } from "vitest";
import { Rng } from "../../shared/utils/rng.ts";
import { isOverburdened, validateEquipment } from "./character.ts";
import { CREATION_RULES, hpCeiling, pointsSpent } from "./character-creation.ts";
import { STARTER_ABILITIES, STARTER_HP, seedFromText, starterCharacter } from "./starter.ts";

const starter = (seed = 1) => starterCharacter(new Rng(seed));

describe("the starter character", () => {
  it("spends exactly the normal point buy, no more", () => {
    expect(pointsSpent(STARTER_ABILITIES)).toBe(CREATION_RULES.normal.pointBuy);
  });

  it("has hit points a normal character could roll", () => {
    expect(STARTER_HP).toBeGreaterThanOrEqual(CREATION_RULES.normal.hp.floor);
    expect(STARTER_HP).toBeLessThanOrEqual(hpCeiling("normal"));
    expect(starter().hp).toEqual({ current: STARTER_HP, max: STARTER_HP });
  });

  it("is a level 1 normal-mode character with a clean bill of health", () => {
    const pc = starter();
    expect(pc).toMatchObject({ level: 1, mode: "normal", conditions: [] });
    expect(pc.name).not.toBe("Nameless");
  });

  it("is wearing the sword, gambeson and shield, legally", () => {
    const pc = starter();
    const nameOf = (id?: string) => pc.inventory.find((i) => i.id === id)?.name.toLowerCase();
    expect(nameOf(pc.equipped.weapon)).toContain("sword");
    expect(nameOf(pc.equipped.armor)).toContain("gambeson");
    expect(nameOf(pc.equipped.shield)).toContain("shield");
    expect(validateEquipment(pc)).toEqual([]);
  });

  it("owns everything it carries, and can carry it", () => {
    const pc = starter();
    expect(pc.inventory.every((i) => i.parentId === pc.id)).toBe(true);
    expect(pc.inventory.map((i) => i.name.toLowerCase()).join(" ")).toMatch(/torch.*rope|rope.*torch/);
    expect(isOverburdened(pc)).toBe(false);
  });

  it("is the same person from the same seed, and somebody else from another", () => {
    const strip = (pc: ReturnType<typeof starter>) => ({ name: pc.name, traits: pc.traits, gender: pc.gender });
    expect(strip(starter(7))).toEqual(strip(starter(7)));
    expect(strip(starter(7))).not.toEqual(strip(starter(8)));
  });
});

describe("seedFromText", () => {
  it("is stable and spreads neighbouring ids apart", () => {
    expect(seedFromText("abc")).toBe(seedFromText("abc"));
    expect(seedFromText("user-1")).not.toBe(seedFromText("user-2"));
    expect(Number.isInteger(seedFromText("x")) && seedFromText("x") >= 0).toBe(true);
  });
});
