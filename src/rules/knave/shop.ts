/**
 * The shop, where a character buys gear with their copper and sells what they
 * carry.
 *
 * It opens at the end of character creation for a character who took starting
 * money instead of rolling gear, and from the character list between runs.
 *
 * This file has no UI. A cart is a plain object, and `checkout` takes a sheet
 * and a cart and returns a new sheet. The screen (`src/ui/shop/Shop.tsx`)
 * decides what to show and disables what the player can't afford; the rules
 * for what buying and selling do are here, so they can be tested without a
 * browser.
 *
 * Prices: every row is a key into `STANDARD_EQUIPMENT` in `equipment.ts`, and
 * its price is that entry's `value`. `SHOP_SECTIONS` in `tables.ts` says which
 * keys are for sale and under which heading. Armour and weapons come from
 * `ARMOR_KEYS` and `WEAPON_CLASSES`, the same lists character creation rolls
 * on. So the shop and character creation get a gambeson's price from the same
 * line.
 *
 * A weapon is chosen as a class, then a name, the same as at creation. The
 * class sets damage, hands, slots, quality and price; the name is just
 * description and costs nothing.
 *
 * Buying and selling happen in one transaction. A player selling a gambeson
 * to afford brigandine is making one trade, and committing the sale on its own
 * click would leave them with neither if they then left without buying. So the
 * items to sell are a list of ids kept beside the cart, their `proceeds` count
 * towards what the player can afford, and `checkout` takes both.
 *
 * Equipment sells for half its shop price; treasure sells for its full value.
 * Treasure exists to be sold, so the shop takes no cut. Equipment is useful in
 * itself, and buying it back at full price would let players use it as money.
 *
 * `sellOffer` decides which is which. If the shop has a row with the item's
 * name, or the item has weapon, armour, book or spellbook stats, it is
 * equipment. Anything else came out of a dungeon and is treasure. This is the
 * same split generation uses in `src/generation/content/rewards.ts`: equipment
 * rewards are priced from the catalogue, and treasure rewards are given a
 * share of the dungeon's wealth.
 *
 * Buying several of something creates separate items. Three torches are three
 * one-slot items, not one item with "3" on it, because that is how they weigh
 * in Knave and so the player can drop just one.
 */

import type { AnyItem, IItem } from "../../shared/world/entities.ts";
import {
  EQUIP_SLOTS,
  addItem,
  canEquip,
  equip,
  removeItem,
  slotCapacity,
  slotsUsed,
  type EquipSlot,
  type PlayerCharacter,
} from "./character.ts";
import { purse, purseItem, setPurse } from "./character-creation.ts";
import type { Rng } from "../../shared/utils/rng.ts";
import {
  STANDARD_EQUIPMENT,
  mintItem,
  type EquipmentKey,
  type ItemTemplate,
} from "./equipment.ts";
import {
  ARMOR_KEYS,
  SHOP_SECTIONS,
  WEAPON_CLASSES,
  type ShopSection,
} from "./tables.ts";

// ===========================================================================
// GOODS
// ===========================================================================

/**
 * One item for sale.
 *
 * It is a key into `STANDARD_EQUIPMENT` plus that entry's template, and the
 * price is the template's `value`, so an item is never sold at one price and
 * valued at another. `kind` only tells the screen which stats to show for the
 * row; no rule depends on it.
 *
 * `toItem` creates a new item each time, so every purchase gets its own id.
 */
export interface ShopGood {
  key: EquipmentKey;
  name: string;
  amount?: string;
  cost: number;
  slots: number;
  kind: "gear" | "armor" | "weapon";
  /** Which section it is displayed under. */
  section: string;
  /** The full template, for rows that show defense or damage. */
  template: ItemTemplate;
  toItem: (rng: Rng) => AnyItem;
}

function good(key: EquipmentKey, kind: ShopGood["kind"], section: string): ShopGood {
  const t: ItemTemplate = STANDARD_EQUIPMENT[key];
  return {
    key,
    name: t.name,
    ...(t.amount ? { amount: t.amount } : {}),
    cost: t.value,
    slots: t.slots ?? 1,
    kind,
    section,
    template: t,
    toItem: (rng: Rng) => mintItem(key, "", rng),
  };
}

/** The armour rows, from worst to best, which is also cheapest to most expensive. */
export const ARMOR_GOODS: readonly ShopGood[] = ARMOR_KEYS.map((k) => good(k, "armor", "armor"));

/** Every named weapon, in class order. The screen groups them by class. */
export const WEAPON_GOODS: readonly ShopGood[] = WEAPON_CLASSES.flatMap((c) =>
  c.members.map((k) => good(k, "weapon", "weapons"))
);

export const GEAR_GOODS: readonly ShopGood[] = SHOP_SECTIONS.flatMap((s) =>
  s.entries.map((k) => good(k, "gear", s.key))
);

export const ALL_GOODS: readonly ShopGood[] = [...ARMOR_GOODS, ...WEAPON_GOODS, ...GEAR_GOODS];

const BY_KEY = new Map<string, ShopGood>(ALL_GOODS.map((g) => [g.key, g]));

/**
 * The same rows looked up by name. A carried item can only be matched to a
 * row by its name: an `IItem` doesn't record which catalogue entry it came
 * from, on purpose, so a gambeson found in a dungeon and one bought here are
 * the same kind of object.
 *
 * If a name appeared twice, the first row would win. In practice names are
 * unique: `equipment.ts` merges the book's duplicate names into one key each,
 * and the catalogue test checks it.
 */
const BY_NAME = new Map<string, ShopGood>();
for (const g of ALL_GOODS) if (!BY_NAME.has(g.name)) BY_NAME.set(g.name, g);

export function goodByKey(key: string): ShopGood | undefined {
  return BY_KEY.get(key);
}

/** The shop row with this item name, if the shop sells it. */
export function goodByName(name: string): ShopGood | undefined {
  return BY_NAME.get(name);
}

/**
 * The shop's sections in the order the screen shows them. Armour and weapons
 * come first because they are what most players are shopping for.
 */
export interface ShopDisplaySection extends Omit<ShopSection, "entries"> {
  goods: readonly ShopGood[];
}

export const SHOP_DISPLAY: readonly ShopDisplaySection[] = [
  { key: "armor", label: "Armor", note: "Defense, then what it costs you in slots.", goods: ARMOR_GOODS },
  { key: "weapons", label: "Weapons", note: "The class is the numbers; the name is yours.", goods: WEAPON_GOODS },
  ...SHOP_SECTIONS.map((s) => ({
    key: s.key,
    label: s.label,
    ...(s.note ? { note: s.note } : {}),
    goods: GEAR_GOODS.filter((g) => g.section === s.key),
  })),
];

// ===========================================================================
// THE CART
// ===========================================================================

/**
 * What the player is buying: each good's key and how many.
 *
 * A record rather than a list, so each key appears only once with its count;
 * a list could hold the same key twice. Keys stay in the order the player
 * added them, which is the order the screen shows.
 */
export type Cart = Readonly<Record<string, number>>;

export const EMPTY_CART: Cart = {};

/** Sets a line's quantity to `qty`. 0 or less removes the line. */
export function setQty(cart: Cart, key: string, qty: number): Cart {
  const next = { ...cart };
  if (qty <= 0) delete next[key];
  else next[key] = Math.floor(qty);
  return next;
}

export function addToCart(cart: Cart, key: string, n = 1): Cart {
  return setQty(cart, key, (cart[key] ?? 0) + n);
}

export function removeFromCart(cart: Cart, key: string, n = 1): Cart {
  return setQty(cart, key, (cart[key] ?? 0) - n);
}

export interface CartLine {
  good: ShopGood;
  qty: number;
  /** The line's total cost, `cost × qty`. */
  cost: number;
  slots: number;
}

/**
 * The cart as rows for display. A key that matches no good is skipped. That
 * can only happen if the tables changed while a cart was open, and carts are
 * never saved, so in practice only during development with hot reload.
 */
export function cartLines(cart: Cart): CartLine[] {
  const lines: CartLine[] = [];
  for (const [key, qty] of Object.entries(cart)) {
    const good = goodByKey(key);
    if (good && qty > 0) lines.push({ good, qty, cost: good.cost * qty, slots: good.slots * qty });
  }
  return lines;
}

export const cartTotal = (cart: Cart): number =>
  cartLines(cart).reduce((n, l) => n + l.cost, 0);

export const cartSlots = (cart: Cart): number =>
  cartLines(cart).reduce((n, l) => n + l.slots, 0);

// ===========================================================================
// THE SOLD PILE
// ===========================================================================

/**
 * What the player is selling: the ids of items in their inventory.
 *
 * Unlike the cart, this lists ids rather than keys with counts. Each carried
 * item is a separate object with its own quality and name, so the player
 * sells a particular torch, not "a torch". The screen keeps a `Sold` beside
 * its `Cart`; `EMPTY_SOLD` matches `EMPTY_CART`.
 */
export type Sold = readonly string[];

export const EMPTY_SOLD: Sold = [];

export type SellKind = "equipment" | "treasure";

/** One carried item and what the shop will pay for it. */
export interface SellOffer {
  item: IItem;
  kind: SellKind;
  /** Copper the shop will pay. 0 means the shop won't buy it. */
  offer: number;
  /**
   * The full value the offer is based on, so a row can show how the offer was
   * worked out. The shop price if the shop sells it, otherwise the item's own
   * `value`. For treasure this equals `offer`, since treasure isn't halved.
   */
  worth: number;
}

/**
 * What the shop will pay for one item, and whether it counts as equipment or
 * treasure.
 *
 * First, if the shop sells an item with this name, it is equipment and the
 * offer is half the shop's price, not half the item's own `value`. A gambeson
 * found in a dungeon sells for half of what a gambeson costs here, whatever
 * value generation gave it. Second, an item with weapon, armour, book or
 * spellbook stats is equipment too. (A spellbook is named after its spell, so
 * it never matches a shop row by name.)
 *
 * Anything else is treasure, and sells for its full `value`, which is its
 * share of the dungeon's wealth. See the file header.
 */
export function sellOffer(item: IItem): SellOffer {
  const stocked = goodByName(item.name);
  if (stocked || item.itemKind !== undefined) {
    const worth = stocked ? stocked.cost : item.value;
    return { item, kind: "equipment", offer: Math.floor(worth / 2), worth };
  }
  return { item, kind: "treasure", offer: item.value, worth: item.value };
}

/**
 * An offer for every item the character carries, in inventory order.
 *
 * The copper item is left out, because money can't be sold (as equipment, 60
 * copper would sell for 30). It is excluded here, not by the screen, and
 * `checkout` sells only from this list, so no caller can sell the copper.
 *
 * Items the shop won't pay for are still listed, with an offer of 0. The
 * screen shows them and doesn't let the player sell them, so the player can
 * see the shop won't take them instead of wondering where they went.
 */
export function sellOffers(pc: PlayerCharacter): SellOffer[] {
  const money = purseItem(pc);
  return pc.inventory.filter((i) => i.id !== money?.id).map(sellOffer);
}

/** Only treasure with an offer above 0. This is what the "Sell all" button sells. */
export function treasureOffers(pc: PlayerCharacter): SellOffer[] {
  return sellOffers(pc).filter((o) => o.kind === "treasure" && o.offer > 0);
}

/** The offers for the items chosen to sell, in inventory order. Ids that match nothing are skipped. */
export function soldLines(pc: PlayerCharacter, sold: Sold): SellOffer[] {
  const ids = new Set(sold);
  return sellOffers(pc).filter((o) => ids.has(o.item.id));
}

/** The total the shop pays for the items being sold. */
export const proceeds = (pc: PlayerCharacter, sold: Sold): number =>
  soldLines(pc, sold).reduce((n, o) => n + o.offer, 0);

/** Inventory slots freed by the items being sold, for the slot meter. */
export const soldSlots = (pc: PlayerCharacter, sold: Sold): number =>
  soldLines(pc, sold).reduce((n, o) => n + o.item.slots, 0);

export function addToSold(sold: Sold, id: string): Sold {
  return sold.includes(id) ? sold : [...sold, id];
}

export function removeFromSold(sold: Sold, id: string): Sold {
  return sold.filter((x) => x !== id);
}

export function toggleSold(sold: Sold, id: string): Sold {
  return sold.includes(id) ? removeFromSold(sold, id) : addToSold(sold, id);
}

// ===========================================================================
// WHAT IT ALL COMES TO
// ===========================================================================

/**
 * The copper the character will have after buying the cart and selling the
 * `sold` items. `sold` defaults to nothing, for callers that only buy.
 */
export const changeFrom = (pc: PlayerCharacter, cart: Cart, sold: Sold = EMPTY_SOLD): number =>
  purse(pc) + proceeds(pc, sold) - cartTotal(cart);

/**
 * Whether the character could still afford one more of `good`.
 *
 * The screen uses this to disable the `+` button, so a player can't build a
 * cart they can't pay for.
 */
export const canAffordOneMore = (
  pc: PlayerCharacter,
  cart: Cart,
  good: ShopGood,
  sold: Sold = EMPTY_SOLD
): boolean => changeFrom(pc, cart, sold) >= good.cost;

// ===========================================================================
// CHECKOUT
// ===========================================================================

export interface Purchase {
  /** The sheet after the transaction. A new object; the sheet passed in is unchanged. */
  pc: PlayerCharacter;
  /** The items bought, in cart order. */
  bought: AnyItem[];
  spent: number;
  /** The items sold, in inventory order. They are no longer in `pc`. */
  sold: IItem[];
  /** Copper received for the items sold. */
  earned: number;
  /** The equipment slots that newly bought items were equipped into. */
  equipped: EquipSlot[];
  /** Whether the character now carries more than their capacity. Reported, never prevented. */
  overburdened: boolean;
}

/**
 * Sells the `sold` items and buys the cart.
 *
 * Carrying capacity is not enforced, as at character creation: Knave has no
 * rule stopping a character from carrying too much, and `overburdened` in the
 * result reports it.
 *
 * Money is enforced. A cart that costs more than the character can pay is a
 * bug in the caller (the screen disables the `+` that would cause it), so
 * this throws rather than quietly buying less.
 *
 * Bought items are equipped where there is an empty slot: each empty slot
 * takes the first bought item that fits it. A filled slot is never changed,
 * because the player chose what is in it. `canEquip` is the check, so a shield
 * bought while holding a two-handed weapon stays in the inventory.
 *
 * Selling happens first. Its money pays for the cart, its slots make room for
 * what is bought, and a slot emptied by selling (`removeItem` unequips the
 * item) can take the new purchase. So selling a gambeson to buy brigandine
 * leaves the brigandine worn.
 *
 * The items to sell are looked up through `sellOffers`, not taken straight
 * from `sold`, so ids that match nothing are skipped and the copper item can
 * never be sold.
 */
export function checkout(
  pc: PlayerCharacter,
  cart: Cart,
  rng: Rng,
  sold: Sold = EMPTY_SOLD
): Purchase {
  const lines = cartLines(cart);
  const spent = lines.reduce((n, l) => n + l.cost, 0);
  const offers = soldLines(pc, sold);
  const earned = offers.reduce((n, o) => n + o.offer, 0);
  const held = purse(pc) + earned;
  if (spent > held) {
    throw new Error(`that comes to ${spent} cp and the purse holds ${held}`);
  }

  const next = structuredClone(pc);
  const gone: IItem[] = [];
  for (const o of offers) {
    const removed = removeItem(next, o.item.id);
    if (removed) gone.push(removed);
  }

  const bought: AnyItem[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.qty; i++) {
      const item = line.good.toItem(rng);
      addItem(next, item, { force: true });
      bought.push(item);
    }
  }
  setPurse(next, held - spent);

  const equipped: EquipSlot[] = [];
  for (const slot of EQUIP_SLOTS) {
    if (next.equipped[slot] !== undefined) continue;
    const fits = bought.find((it) => canEquip(next, slot, it.id).ok);
    if (fits && equip(next, slot, fits.id).ok) equipped.push(slot);
  }

  return {
    pc: next,
    bought,
    spent,
    sold: gone,
    earned,
    equipped,
    overburdened: slotsUsed(next) > slotCapacity(next),
  };
}
