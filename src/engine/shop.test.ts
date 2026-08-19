/**
 * THE SHOP, as arithmetic.
 *
 * What is worth asserting here is what money does to a sheet: the purse is
 * prose on an item and has to survive a round trip through it, a cart has to
 * cost what its rows cost, and `checkout` has to bind every purchase to the
 * character who paid for it. The screen disables the buttons that would break
 * these rules — these tests are what says the rules exist somewhere the screen
 * is not.
 *
 * Headless, per the extension rule in `vite.config.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  ARMOR_GOODS,
  ALL_GOODS,
  EMPTY_CART,
  GEAR_GOODS,
  SHOP_DISPLAY,
  WEAPON_GOODS,
  addToCart,
  canAfford,
  canAffordOneMore,
  cartCount,
  cartLines,
  cartSlots,
  cartTotal,
  changeFrom,
  checkout,
  goodByKey,
  purse,
  removeFromCart,
  setPurse,
  setQty,
  slotsUsed,
  type Cart,
  type PlayerCharacter,
} from "./index.ts";
import { Rng, buyKit, finishCharacter, rollAbilities, rollTraits, bonusesOf } from "./index.ts";
import { WEAPONS } from "./knave-tables.ts";
import { armorFacts, equipment, weaponFacts } from "./equipment.ts";
import { isArmor, isWeapon } from "./dungeon-entities.ts";

/** Purchases roll — a book rolls for what is in it — so the till needs a stream. */
const till = () => new Rng(SEED);

const SEED = 20260817;

const weapon = (name: string) => WEAPONS.find((k) => equipment(k).name === name)!;

/**
 * A buyer, with a purse of a stated size and a weapon already in their hands.
 *
 * `finishCharacter` is what creation uses, so this is the same object the shop
 * meets in the app — including the copper row, which is the thing under test.
 */
function buyer(copper = 400, held = "Sword"): PlayerCharacter {
  const rng = new Rng(SEED);
  const pc = finishCharacter({
    mode: "normal",
    name: "Tuesday Relish",
    abilities: bonusesOf(rollAbilities(rng, "normal")),
    traits: rollTraits(rng),
    hp: 9,
    kit: buyKit(rng, weapon(held)),
  });
  setPurse(pc, copper);
  return pc;
}

const good = (key: string) => {
  const g = goodByKey(key);
  if (!g) throw new Error(`no good called ${key}`);
  return g;
};

const LANTERN = "lantern";
const TORCH = "torch";
const GAMBESON = "gambeson";

describe("the catalogue", () => {
  it("prices everything, in whole copper", () => {
    for (const g of ALL_GOODS) {
      expect(g.cost, g.key).toBeGreaterThan(0);
      expect(Number.isInteger(g.cost), g.key).toBe(true);
      expect(g.slots, g.key).toBeGreaterThanOrEqual(1);
    }
  });

  it("has no two goods answering to one key", () => {
    const keys = ALL_GOODS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prices armor and weapons from the creation tables, not a second copy", () => {
    // The same numbers character creation charges. If these ever disagree it is
    // because somebody transcribed the Item Costs page twice, which is the one
    // thing `knave-tables.ts` opens by refusing to do.
    expect(good(GAMBESON).cost).toBe(60);
    expect(armorFacts(GAMBESON)?.defense).toBe(12);
    expect(good("crossbow").cost).toBe(60);
    expect(weaponFacts("crossbow")?.damage).toBe("1d8");
    expect(GEAR_GOODS.some((g) => g.kind !== "gear")).toBe(false);
    expect(ARMOR_GOODS).toHaveLength(7);
    expect(WEAPON_GOODS).toHaveLength(WEAPONS.length);
  });

  it("puts every good in exactly one displayed section", () => {
    const shown = SHOP_DISPLAY.flatMap((s) => s.goods.map((g) => g.key));
    expect(shown.sort()).toEqual(ALL_GOODS.map((g) => g.key).sort());
  });

  it("mints a fresh item every time, ids and all", () => {
    const a = good(TORCH).toItem(till());
    const b = good(TORCH).toItem(till());
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe("Torch");
    expect(a.amount).toBe("1 hour");
    expect(a.slots).toBe(1);
  });

  it("mints armor and weapons with their stats on", () => {
    const g = good(GAMBESON).toItem(till());
    expect(isArmor(g) && g.armor).toEqual({ armorType: "body", defense: 12 });
    expect(g.quality).toBe(3);
    expect(g.currentQuality).toBe(3);

    const bow = good("bow").toItem(till());
    expect(isWeapon(bow) && bow.weapon).toEqual({ damage: "1d6", hands: 2, ranged: true });
  });
});

describe("the purse", () => {
  it("round-trips through the item it is written on", () => {
    const pc = buyer(340);
    expect(purse(pc)).toBe(340);
    setPurse(pc, 15);
    expect(purse(pc)).toBe(15);
  });

  it("is no row at all when it is empty", () => {
    const pc = buyer(20);
    setPurse(pc, 0);
    expect(purse(pc)).toBe(0);
    expect(pc.inventory.some((i) => i.name === "Copper")).toBe(false);
  });

  it("comes back when there is something to put in it", () => {
    const pc = buyer(20);
    setPurse(pc, 0);
    setPurse(pc, 5);
    expect(purse(pc)).toBe(5);
    expect(pc.inventory.filter((i) => i.name === "Copper")).toHaveLength(1);
    // Money weighs nothing in Knave and the shop must not start charging for it.
    expect(pc.inventory.find((i) => i.name === "Copper")?.slots).toBe(0);
  });

  it("reads a rolled character as broke rather than as a mystery", () => {
    const pc = buyer(0);
    expect(purse(pc)).toBe(0);
  });
});

describe("the cart", () => {
  it("counts, costs and weighs what is in it", () => {
    let cart: Cart = EMPTY_CART;
    cart = addToCart(cart, TORCH, 3);
    cart = addToCart(cart, LANTERN);

    expect(cartCount(cart)).toBe(4);
    expect(cartTotal(cart)).toBe(3 * 1 + 30);
    expect(cartSlots(cart)).toBe(4);
    expect(cartLines(cart).map((l) => l.good.key)).toEqual([TORCH, LANTERN]);
  });

  it("drops a line taken to zero rather than keeping an empty one", () => {
    let cart = addToCart(EMPTY_CART, TORCH);
    cart = removeFromCart(cart, TORCH);
    expect(cartLines(cart)).toHaveLength(0);
    expect(Object.keys(cart)).toHaveLength(0);
  });

  it("cannot be taken below zero", () => {
    const cart = removeFromCart(EMPTY_CART, TORCH, 5);
    expect(cartTotal(cart)).toBe(0);
  });

  it("ignores a key with no good behind it", () => {
    const cart = setQty(EMPTY_CART, "nonesuch", 2);
    expect(cartLines(cart)).toHaveLength(0);
    expect(cartTotal(cart)).toBe(0);
  });

  it("knows what is affordable and what is one torch too far", () => {
    const pc = buyer(31);
    const cart = addToCart(EMPTY_CART, LANTERN);
    expect(changeFrom(pc, cart)).toBe(1);
    expect(canAfford(pc, cart)).toBe(true);
    expect(canAffordOneMore(pc, cart, good(TORCH))).toBe(true);
    expect(canAffordOneMore(pc, cart, good(LANTERN))).toBe(false);
  });
});

describe("checkout", () => {
  it("hands back a new sheet and leaves the old one alone", () => {
    const pc = buyer(400);
    const before = structuredClone(pc);
    const { pc: after } = checkout(pc, addToCart(EMPTY_CART, LANTERN), till());

    expect(pc).toEqual(before);
    expect(after).not.toBe(pc);
    expect(after.inventory.some((i) => i.name === "Lantern")).toBe(true);
  });

  it("takes the money and binds every purchase to the buyer", () => {
    const pc = buyer(400);
    const { pc: after, bought, spent } = checkout(pc, addToCart(EMPTY_CART, TORCH, 5), till());

    expect(spent).toBe(5);
    expect(purse(after)).toBe(395);
    expect(bought).toHaveLength(5);
    // Five torches, five slots, five items — not one row saying "5".
    expect(after.inventory.filter((i) => i.name === "Torch")).toHaveLength(5);
    for (const item of bought) expect(item.parentId).toBe(after.id);
  });

  it("refuses a cart the purse cannot cover", () => {
    const pc = buyer(10);
    expect(() => checkout(pc, addToCart(EMPTY_CART, LANTERN), till())).toThrow(/30 cp and the purse holds 10/);
  });

  it("spends the purse to exactly nothing without leaving a copper row", () => {
    const pc = buyer(30);
    const { pc: after } = checkout(pc, addToCart(EMPTY_CART, LANTERN), till());
    expect(purse(after)).toBe(0);
    expect(after.inventory.some((i) => i.name === "Copper")).toBe(false);
  });

  it("puts bought armor on, because armor nobody is wearing is money for nothing", () => {
    const pc = buyer(400);
    expect(pc.equipped.armor).toBeUndefined();

    const { pc: after, equipped } = checkout(pc, addToCart(EMPTY_CART, GAMBESON), till());
    expect(equipped).toContain("armor");
    const worn = after.inventory.find((i) => i.id === after.equipped.armor);
    expect(worn?.name).toBe("Gambeson");
  });

  it("never displaces what they already chose to carry", () => {
    const pc = buyer(400);
    const sword = pc.equipped.weapon;
    expect(sword).toBeDefined();

    const { pc: after, equipped } = checkout(pc, addToCart(EMPTY_CART, "dagger"), till());
    expect(after.equipped.weapon).toBe(sword);
    expect(equipped).not.toContain("weapon");
    expect(after.inventory.some((i) => i.name === "Dagger")).toBe(true);
  });

  it("leaves a shield in the pack beside a two-handed weapon", () => {
    // Already holding a halberd, so the shield slot is empty and the shield is
    // still refused. `canEquip` is what says so, here exactly as at creation.
    const pc = buyer(400, "Halberd");
    expect(pc.equipped.shield).toBeUndefined();

    const { pc: after, equipped } = checkout(pc, addToCart(EMPTY_CART, "shield"), till());

    expect(equipped).not.toContain("shield");
    expect(after.equipped.shield).toBeUndefined();
    expect(after.inventory.some((i) => i.name === "Shield")).toBe(true);
  });

  it("gives a shield to somebody with a hand free", () => {
    const pc = buyer(400, "Sword");
    const { pc: after, equipped } = checkout(pc, addToCart(EMPTY_CART, "shield"), till());

    expect(equipped).toContain("shield");
    expect(after.equipped.shield).toBeDefined();
  });

  it("reports being over capacity and buys anyway", () => {
    const pc = buyer(400);
    const room = pc.abilities.con + 10 - slotsUsed(pc);
    const { pc: after, overburdened } = checkout(pc, addToCart(EMPTY_CART, TORCH, room + 2), till());

    expect(overburdened).toBe(true);
    expect(after.inventory.filter((i) => i.name === "Torch")).toHaveLength(room + 2);
  });

  it("buys nothing on an empty cart, and takes nothing for it", () => {
    const pc = buyer(400);
    const { pc: after, bought, spent } = checkout(pc, EMPTY_CART, till());
    expect(bought).toHaveLength(0);
    expect(spent).toBe(0);
    expect(purse(after)).toBe(400);
  });
});
