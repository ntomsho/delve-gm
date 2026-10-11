/**
 * THE SHOP
 * ========
 *
 * The other half of character creation's equipment step. A character who took
 * the copper instead of rolling on the gear tables walks out of creation with
 * rations, a weapon and a purse; this is where the purse becomes gear.
 *
 * Pure, like everything in `src/engine/`. No React, no fetch, no clock — a
 * cart is a plain object and `checkout` is a function from a sheet and a cart
 * to a new sheet. The screen decides what to show and disables what cannot be
 * afforded; every rule about what a purchase *does* is here, where it can be
 * asserted without a DOM.
 *
 * WHERE THE PRICES COME FROM. Every row is a key into `STANDARD_EQUIPMENT`, and
 * a good's price is that entry's `value`. The sections in `knave-tables.ts` say
 * which keys are on sale and under which heading; the armor rows and the weapon
 * picker walk `ARMOR_KEYS` and `WEAPON_CLASSES`, which are the same two
 * groupings character creation rolls on. So the shop and the creation step
 * price a gambeson from one line of one file, and neither owns it.
 *
 * A WEAPON IS A CLASS AND THEN A NAME, exactly as it is at creation — the class
 * fixes damage, hands, slots, quality and price, and the name on top of it is
 * fiction that costs nothing. The screen asks in that order because the numbers
 * do.
 *
 * SELLING IS THE SAME TRANSACTION. The counter buys as well as sells, and both
 * halves settle at one button: a player selling the gambeson to afford the
 * brigandine is doing one thing, not two, and a screen that committed the sale
 * on the click would leave them holding neither if they then walked out. So the
 * sold pile is a list of ids beside the cart, `proceeds` is added to the purse
 * everything else is measured against, and `checkout` takes both.
 *
 * TWO PRICES, AND THE SPLIT IS WHAT THE THING IS. **Equipment fetches half its
 * store value; treasure fetches all of it.** Treasure is only ever worth what
 * somebody will pay — that is the entire point of a jewelled reliquary — so
 * there is no margin to take on it. Equipment has a use beside its price, and a
 * shop that bought a lantern back for thirty copper would make the lantern a
 * currency rather than a tool. Half is the oldest answer to that and it is
 * enough.
 *
 * WHAT COUNTS AS EQUIPMENT is `sellOffer`, and it asks two questions in order:
 * is there a row on this very screen with that name, and failing that, does the
 * item carry weapon, armor, book or spellbook facts. Anything else came out of a
 * dungeon and is treasure.
 *
 * THAT LINE IS THE SAME LINE THE GENERATOR DRAWS, which is why two files can
 * agree without either knowing about the other. `dungeon-rewards.ts` gives an
 * equipment reward a catalog price and a treasure reward a share of the
 * conserved pot; a thing with a catalog price has a store value to halve, and a
 * thing with a share is worth that share to whoever will pay it. Potions are the
 * case that settled it — they were an equipment row inventing a price out of the
 * key band, they are a treasure row now, and this function was already calling
 * them treasure while they were on the wrong side of it.
 *
 * QUANTITIES MINT SEPARATE ITEMS. Three torches are three items of one slot
 * each, not one item saying "3", because that is what they weigh in Knave and
 * because dropping one of them has to be possible.
 */

import type { AnyItem, IItem } from "./dungeon-entities.ts";
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
} from "./dungeon-character.ts";
import { purse, purseItem, setPurse } from "./character-creation.ts";
import type { Rng } from "./dungeon-blueprint.ts";
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
} from "./knave-tables.ts";

// ===========================================================================
// GOODS
// ===========================================================================

/**
 * One thing with a price on it.
 *
 * A row is a key into `STANDARD_EQUIPMENT` and the template behind it, and the
 * price IS the template's `value` — a shop that sold at one number and valued
 * at another would be the two-tables problem all over again. `kind` is what the
 * screen reads to decide how much of a stat line a row needs; nothing
 * mechanical branches on it.
 *
 * `toItem` mints a fresh copy, so every purchase gets its own id and no two
 * rows on a sheet can be the same object.
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
  /** Everything else about it, for a row that has to print defense or damage. */
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

/** The armor rows, worst to best — which is also cheapest to dearest. */
export const ARMOR_GOODS: readonly ShopGood[] = ARMOR_KEYS.map((k) => good(k, "armor", "armor"));

/** Every named weapon, in class order. The screen groups them by class again. */
export const WEAPON_GOODS: readonly ShopGood[] = WEAPON_CLASSES.flatMap((c) =>
  c.members.map((k) => good(k, "weapon", "weapons"))
);

export const GEAR_GOODS: readonly ShopGood[] = SHOP_SECTIONS.flatMap((s) =>
  s.entries.map((k) => good(k, "gear", s.key))
);

export const ALL_GOODS: readonly ShopGood[] = [...ARMOR_GOODS, ...WEAPON_GOODS, ...GEAR_GOODS];

const BY_KEY = new Map<string, ShopGood>(ALL_GOODS.map((g) => [g.key, g]));

/**
 * The same rows under the name printed on them, which is the only handle a
 * carried item offers — an `IItem` keeps no pointer back to the catalog entry it
 * was minted from, deliberately, because a found gambeson and a bought one are
 * the same object and neither is a reference to a table.
 *
 * First writer wins, so a name appearing twice prices from wherever it is
 * displayed first. It does not: `equipment.ts` opens by collapsing the two
 * printed tables' duplicate names into one key each, and the catalogue test
 * asserts the keys are unique.
 */
const BY_NAME = new Map<string, ShopGood>();
for (const g of ALL_GOODS) if (!BY_NAME.has(g.name)) BY_NAME.set(g.name, g);

export function goodByKey(key: string): ShopGood | undefined {
  return BY_KEY.get(key);
}

/** The row this thing would be bought from, if the shop stocks one. */
export function goodByName(name: string): ShopGood | undefined {
  return BY_NAME.get(name);
}

/**
 * The sections in the order the screen draws them, armor and weapons first
 * because they are the reason most purses are opened.
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
 * What is on the counter: a good's key against how many of it.
 *
 * A plain record rather than a list, because "three torches" is one decision
 * taken three times and a list would let the same key appear twice and disagree
 * with itself. Insertion order is the display order, which is the order the
 * player put things down in.
 */
export type Cart = Readonly<Record<string, number>>;

export const EMPTY_CART: Cart = {};

/** Set a line to exactly `qty`. Zero or less removes it. */
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
  /** `cost × qty`, so the row does not have to multiply. */
  cost: number;
  slots: number;
}

/**
 * The cart as rows. **A key with no good behind it is dropped**, which can only
 * happen if a table changed under a cart that was already open — and a cart is
 * never persisted, so this is a guard against a hot reload rather than against
 * data.
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

export const cartCount = (cart: Cart): number =>
  cartLines(cart).reduce((n, l) => n + l.qty, 0);

// ===========================================================================
// THE SOLD PILE
// ===========================================================================

/**
 * What is being sold: ids of rows already on the sheet.
 *
 * Ids rather than keys, and a list rather than a count, because selling is the
 * mirror of buying in every way but this one — every carried thing is a distinct
 * object with its own quality, its own name and its own history, and "sell a
 * torch" is not a sentence the sheet can answer. `Sold` is what the screen holds
 * beside its `Cart`, and `EMPTY_SOLD` is the pair to `EMPTY_CART`.
 */
export type Sold = readonly string[];

export const EMPTY_SOLD: Sold = [];

export type SellKind = "equipment" | "treasure";

/** One carried thing with a price on it, going the other way. */
export interface SellOffer {
  item: IItem;
  kind: SellKind;
  /** Copper the counter will pay for it. Zero means nobody here wants it. */
  offer: number;
  /**
   * What it is being halved from, for a row that wants to show the working.
   * The catalog price where there is one, and the item's own `value` otherwise.
   * Equal to `offer` for treasure, which is not halved.
   */
  worth: number;
}

/**
 * What the counter will pay for one thing, and why.
 *
 * TWO QUESTIONS, IN ORDER. A row on this screen with that name settles it and
 * prices from the catalog rather than from the item — "half its **store**
 * value" is the rule, and a gambeson dragged out of a flooded aviary is worth
 * half of what a gambeson costs, not half of whatever the dungeon happened to
 * write on it. Failing a name, an item carrying weapon, armor, book or spellbook
 * facts is equipment by construction: a spellbook is named for the spell inside
 * it and will never match a row, and it is plainly not treasure.
 *
 * Everything left came out of a dungeon with a share of the pot on it, and that
 * share IS what it fetches. See the header.
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
 * Everything on the sheet that the counter will look at, in pack order.
 *
 * **THE PURSE IS NOT ON IT.** Money is not a good, and a shop that bought sixty
 * copper for thirty would be a machine for emptying a character. It is the one
 * row excluded here rather than filtered by the screen, so that no caller can
 * forget — `checkout` sells from this list too, which is what makes selling the
 * purse impossible rather than merely undrawn.
 *
 * A ZERO OFFER IS STILL A ROW. What the shop will not pay for is a thing the
 * player is entitled to be told about; the screen shows it and refuses the
 * click, which is a better answer than a pack that silently has holes in it.
 */
export function sellOffers(pc: PlayerCharacter): SellOffer[] {
  const money = purseItem(pc);
  return pc.inventory.filter((i) => i.id !== money?.id).map(sellOffer);
}

/** Just the treasure, and only what there is an offer on. What "Sell all" sells. */
export function treasureOffers(pc: PlayerCharacter): SellOffer[] {
  return sellOffers(pc).filter((o) => o.kind === "treasure" && o.offer > 0);
}

/** The offers actually selected, in pack order. An id with no row behind it is dropped. */
export function soldLines(pc: PlayerCharacter, sold: Sold): SellOffer[] {
  const ids = new Set(sold);
  return sellOffers(pc).filter((o) => ids.has(o.item.id));
}

/** What the sold pile pays. */
export const proceeds = (pc: PlayerCharacter, sold: Sold): number =>
  soldLines(pc, sold).reduce((n, o) => n + o.offer, 0);

/** Slots the sold pile gives back, for a meter that has to count both directions. */
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
 * What is left in the purse if they buy what is on the counter and sell what is
 * beside it.
 *
 * `sold` is optional and empty by default, which is what keeps every caller that
 * only ever buys — creation's last step, the tests below the cart — reading the
 * same as it did before there was a sold pile.
 */
export const changeFrom = (pc: PlayerCharacter, cart: Cart, sold: Sold = EMPTY_SOLD): number =>
  purse(pc) + proceeds(pc, sold) - cartTotal(cart);

export const canAfford = (pc: PlayerCharacter, cart: Cart, sold: Sold = EMPTY_SOLD): boolean =>
  changeFrom(pc, cart, sold) >= 0;

/**
 * Whether one more of this would still be payable for.
 *
 * The screen disables the `+` with this rather than letting a player build a
 * cart they cannot buy and discover it at the counter.
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
  /** The sheet after the transaction. A new object; the one passed in is untouched. */
  pc: PlayerCharacter;
  /** What was minted, in cart order. */
  bought: AnyItem[];
  spent: number;
  /** What left the pack, in pack order. Already gone from `pc`. */
  sold: IItem[];
  /** What the sold pile fetched. */
  earned: number;
  /** What went straight onto them, and into which slot. */
  equipped: EquipSlot[];
  /** Slots used against capacity afterwards. Reported, never enforced. */
  overburdened: boolean;
}

/**
 * Buy the cart.
 *
 * CAPACITY IS NOT ENFORCED, for the same reason creation does not enforce it: a
 * rolled kit can already exceed CON defense, `isOverburdened` is what reports
 * it, and a shop that refused the fourth torch would be a rule Knave does not
 * have. `addItem` is forced and the outcome says whether they are over.
 *
 * MONEY IS ENFORCED. Overspending is not a judgement call, and a cart that
 * costs more than the purse is a bug in whatever built it — the screen disables
 * the `+` that would do it — so this throws rather than silently buying less.
 *
 * WHAT IS BOUGHT GOES ON, WHERE THERE IS ROOM FOR IT. An empty equip slot takes
 * the first thing bought that fits it, because a gambeson nobody is wearing is
 * money spent on nothing. **A filled slot is never displaced**: what they are
 * already carrying is an arrangement they chose, and a purchase is not an
 * argument for undoing it. `canEquip` is the strict check, so a shield bought
 * beside a two-hander stays in the pack exactly as a rolled one does.
 *
 * SELLING HAPPENS FIRST, and it has to. The money pays for the cart, the slots
 * pay for what the cart weighs, and an equip slot emptied by selling what was in
 * it is a slot the new armor can go straight into — which is the whole of what a
 * player selling a gambeson to buy brigandine expects to happen. `removeItem`
 * clears the slot on its way out, so nothing here has to remember to.
 *
 * WHAT IS SOLD IS READ OFF `sellOffers`, NOT OFF THE ARGUMENT. An id that names
 * nothing is dropped and the purse can never be sold, both by construction
 * rather than by a check that a later caller could skip.
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
