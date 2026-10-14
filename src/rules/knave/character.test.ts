import { describe, expect, it } from "vitest";
import { canEquip, equip, validateEquipment, type PlayerCharacter } from "./character.ts";
import type { AnyItem } from "../../shared/world/entities.ts";

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
