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
 * WHERE THE PRICES COME FROM. `SHOP_SECTIONS` in `knave-tables.ts` is the Item
 * Costs page minus its armor and weapon halves, which were already transcribed
 * for character creation as `ARMOR_STATS` and `WEAPON_CLASSES`. Those are what
 * the armor rows and the weapon picker read, so the shop and the creation step
 * price a gambeson from one line of one file.
 *
 * A WEAPON IS A CLASS AND THEN A NAME, exactly as it is at creation — the class
 * fixes damage, hands, slots, quality and price, and the name on top of it is
 * fiction that costs nothing. The screen asks in that order because the numbers
 * do.
 *
 * NO SELLING. A shop that buys is a second set of rules — what a used gambeson
 * is worth, whether a spellbook can be pawned — and nothing has asked for one.
 * A cart can be emptied before it is bought, which covers changing your mind;
 * what it does not cover is regret, and regret is a Knave character's own
 * business.
 *
 * QUANTITIES MINT SEPARATE ITEMS. Three torches are three items of one slot
 * each, not one item saying "3", because that is what they weigh in Knave and
 * because dropping one of them has to be possible.
 */

import type { IItem } from "./dungeon-entities.ts";
import {
  EQUIP_SLOTS,
  addItem,
  canEquip,
  equip,
  slotCapacity,
  slotsUsed,
  type EquipSlot,
  type PlayerCharacter,
} from "./dungeon-character.ts";
import { purse, setPurse, weaponItem } from "./character-creation.ts";
import { makeId } from "./dungeon-blueprint.ts";
import {
  ARMOR_STATS,
  SHOP_SECTIONS,
  WEAPON_CLASSES,
  weaponsIn,
  type ArmorKey,
  type ArmorStat,
  type GearEntry,
  type ShopSection,
  type WeaponStat,
} from "./knave-tables.ts";

// ===========================================================================
// GOODS
// ===========================================================================

/**
 * One thing with a price on it.
 *
 * `toItem` is what a purchase mints — a closure rather than a stored template,
 * so every copy bought gets its own id and no two rows on a sheet can be the
 * same object. `kind` is what the screen reads to decide how much of a stat
 * line a row needs; nothing mechanical branches on it.
 */
export interface ShopGood {
  key: string;
  name: string;
  amount?: string;
  cost: number;
  slots: number;
  kind: "gear" | "armor" | "weapon";
  /** Which section it is displayed under. */
  section: string;
  /** Set on an armor good, for the row that has to print its defense. */
  armor?: ArmorStat;
  /** Set on a weapon good, for the same reason. */
  weapon?: WeaponStat;
  toItem: () => IItem;
}

/** Keys are display-stable and human-legible, so a failing test names a thing. */
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const gearKey = (section: string, e: GearEntry): string =>
  `gear:${section}:${slug(e.name)}${e.amount ? `-${slug(e.amount)}` : ""}`;

function gearGood(section: string, e: GearEntry): ShopGood {
  return {
    key: gearKey(section, e),
    name: e.name,
    ...(e.amount ? { amount: e.amount } : {}),
    cost: e.cost,
    slots: e.slots ?? 1,
    kind: "gear",
    section,
    toItem: () => ({
      id: makeId(),
      name: e.name,
      type: "Item",
      parentId: "",
      slots: e.slots ?? 1,
      ...(e.amount ? { amount: e.amount } : {}),
    }),
  };
}

function armorGood(key: ArmorKey): ShopGood {
  const a = ARMOR_STATS[key];
  return {
    key: `armor:${key}`,
    name: a.name,
    cost: a.cost,
    slots: a.slots,
    kind: "armor",
    section: "armor",
    armor: a,
    toItem: () => ({
      id: makeId(),
      name: a.name,
      type: "Item",
      parentId: "",
      slots: a.slots,
      quality: a.quality,
      currentQuality: a.quality,
      armor: { armorType: a.armorType, defense: a.defense },
    }),
  };
}

function weaponGood(w: WeaponStat): ShopGood {
  return {
    key: `weapon:${slug(w.name)}`,
    name: w.name,
    cost: w.cost,
    slots: w.slots,
    kind: "weapon",
    section: "weapons",
    weapon: w,
    toItem: () => weaponItem(w),
  };
}

/** The armor rows, worst to best — which is also cheapest to dearest. */
export const ARMOR_GOODS: readonly ShopGood[] = (
  ["gambeson", "brigandine", "chain", "halfPlate", "fullPlate", "helmet", "shield"] as const
).map(armorGood);

/** Every named weapon, in class order. The screen groups them by class again. */
export const WEAPON_GOODS: readonly ShopGood[] = WEAPON_CLASSES.flatMap((c) =>
  weaponsIn(c).map(weaponGood)
);

export const GEAR_GOODS: readonly ShopGood[] = SHOP_SECTIONS.flatMap((s) =>
  s.entries.map((e) => gearGood(s.key, e))
);

export const ALL_GOODS: readonly ShopGood[] = [...ARMOR_GOODS, ...WEAPON_GOODS, ...GEAR_GOODS];

const BY_KEY = new Map(ALL_GOODS.map((g) => [g.key, g]));

export function goodByKey(key: string): ShopGood | undefined {
  return BY_KEY.get(key);
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

/** What is left in the purse if they buy what is on the counter. */
export const changeFrom = (pc: PlayerCharacter, cart: Cart): number =>
  purse(pc) - cartTotal(cart);

export const canAfford = (pc: PlayerCharacter, cart: Cart): boolean =>
  changeFrom(pc, cart) >= 0;

/**
 * Whether one more of this would still be payable for.
 *
 * The screen disables the `+` with this rather than letting a player build a
 * cart they cannot buy and discover it at the counter.
 */
export const canAffordOneMore = (pc: PlayerCharacter, cart: Cart, good: ShopGood): boolean =>
  changeFrom(pc, cart) >= good.cost;

// ===========================================================================
// CHECKOUT
// ===========================================================================

export interface Purchase {
  /** The sheet after buying. A new object; the one passed in is untouched. */
  pc: PlayerCharacter;
  /** What was minted, in cart order. */
  bought: IItem[];
  spent: number;
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
 */
export function checkout(pc: PlayerCharacter, cart: Cart): Purchase {
  const lines = cartLines(cart);
  const spent = lines.reduce((n, l) => n + l.cost, 0);
  const held = purse(pc);
  if (spent > held) {
    throw new Error(`that comes to ${spent} cp and the purse holds ${held}`);
  }

  const next = structuredClone(pc);
  const bought: IItem[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.qty; i++) {
      const item = line.good.toItem();
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
    equipped,
    overburdened: slotsUsed(next) > slotCapacity(next),
  };
}
