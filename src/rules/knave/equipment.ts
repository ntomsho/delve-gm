/**
 * Standard equipment: one catalogue of every item the shop sells, a gear roll
 * can give, or a new character starts with. The gear tables in `tables.ts` and
 * the shop's sections both refer to entries here by key, so a rope has one
 * price and one description however the player got it.
 *
 * Knave prints two overlapping lists: the starting-gear tables (page 2) and
 * Item Costs (page 3). Many items appear in both, sometimes under different
 * names (Torches and Torch, Padlock and Padlock and key, Instrument and
 * Musical instrument). Keeping both lists would mean writing every item's
 * description twice, and the copies would drift apart. So each item is one
 * entry here, and both lists use its key.
 *
 * Each entry (a template) is an item without the things only a created copy
 * has: its id, its holder, and anything rolled for it, like a book's subject.
 * Entries use the same fields as items, including the description fields
 * `base`, `state` and `composed`.
 *
 * Descriptions are written here rather than generated, because a gambeson's
 * description is the same in every dungeon, and generating it each time
 * wastes a model call. An entry with empty descriptions still works: its
 * items start undescribed, and the game writes a description the first time
 * one is needed.
 *
 * `amount` is only ever a count or a measurement ("50 feet", "5", "4 hours").
 * Knave's Item Costs page also uses that column for variants (Book *blank*,
 * Spike *iron*, Tent *3 man*); here those go in the name instead.
 *
 * This file and `tables.ts` import each other, but only types (`tables.ts`
 * uses `EquipmentKey`, this uses `Spell`), so there is no cycle at runtime.
 */

import { rollBookSubject } from "../maze-rats/tables.ts";
import { makeId } from "../../shared/utils/id.ts";
import { Rng } from "../../shared/utils/rng.ts";
import type {
  AnyItem,
  ArmorFacts,
  BookFacts,
  IArmor,
  IBook,
  IItem,
  ISpellbook,
  IWeapon,
  WeaponFacts,
} from "../../shared/world/entities.ts";
import type { Spell } from "./tables.ts";

// ===========================================================================
// TEMPLATES
// ===========================================================================

/** Fields only a created item has: its id, its holder and its entity type. */
type Minted = "id" | "parentId" | "type";

/**
 * One template type per item kind, rather than one type with everything
 * optional, so that a weapon entry without a damage die doesn't compile.
 * `slots` may be left out and defaults to 1 when the item is created (in
 * Knave most items take one slot; armour and weapons say otherwise). A book's
 * facts can also be left out and are rolled when it is created.
 */
export type GearTemplate = Omit<IItem, Minted | "slots"> & { slots?: number; itemKind?: "gear" };
export type WeaponTemplate = Omit<IWeapon, Minted | "slots"> & { slots?: number };
export type ArmorTemplate = Omit<IArmor, Minted | "slots"> & { slots?: number };
export type BookTemplate = Omit<IBook, Minted | "slots" | "book"> & {
  slots?: number;
  /** set either field to fix it; anything left out is rolled when the book is created */
  book?: Partial<BookFacts>;
};
export type SpellbookTemplate = Omit<ISpellbook, Minted | "slots" | "spellBook"> & {
  slots?: number;
};

export type ItemTemplate =
  | GearTemplate
  | WeaponTemplate
  | ArmorTemplate
  | BookTemplate
  | SpellbookTemplate;

// ===========================================================================
// THE TABLE
// ===========================================================================

/**
 * Every standard item, by key. `value` is the price from Knave's Item Costs
 * page, in copper, and it is also what the item is worth everywhere else, so
 * the shop never sells at one price and values at another.
 *
 * Armour and weapon stats are kept here too, not in a separate stat table,
 * because they are fields of the item: a gambeson's price, slots, quality and
 * defense all describe the same object.
 */
export const STANDARD_EQUIPMENT = {
  // --- armor -----------------------------------------------------------------
  gambeson: {
    name: "Gambeson", slots: 1, quality: 3, value: 60,
    itemKind: "armor", armor: { armorType: "body", defense: 12 },
    base: "",
    state: "",
    composed: "",
  },
  brigandine: {
    name: "Brigandine", slots: 2, quality: 4, value: 500,
    itemKind: "armor", armor: { armorType: "body", defense: 13 },
    base: "",
    state: "",
    composed: "",
  },
  chain_armor: {
    name: "Chain", slots: 3, quality: 5, value: 1200,
    itemKind: "armor", armor: { armorType: "body", defense: 14 },
    base: "",
    state: "",
    composed: "",
  },
  half_plate: {
    name: "Half plate", slots: 4, quality: 6, value: 4000,
    itemKind: "armor", armor: { armorType: "body", defense: 15 },
    base: "",
    state: "",
    composed: "",
  },
  full_plate: {
    name: "Full plate", slots: 5, quality: 7, value: 8000,
    itemKind: "armor", armor: { armorType: "body", defense: 16 },
    base: "",
    state: "",
    composed: "",
  },
  helmet: {
    name: "Helmet", slots: 1, quality: 1, value: 40,
    itemKind: "armor", armor: { armorType: "helmet", defense: 1 },
    base: "",
    state: "",
    composed: "",
  },
  shield: {
    name: "Shield", slots: 1, quality: 1, value: 40,
    itemKind: "armor", armor: { armorType: "shield", defense: 1 },
    base: "",
    state: "",
    composed: "",
  },

  // --- weapons ---------------------------------------------------------------
  dagger: {
    name: "Dagger", slots: 1, quality: 3, value: 5,
    itemKind: "weapon", weapon: { damage: "1d6", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  cudgel: {
    name: "Cudgel", slots: 1, quality: 3, value: 5,
    itemKind: "weapon", weapon: { damage: "1d6", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  sickle: {
    name: "Sickle", slots: 1, quality: 3, value: 5,
    itemKind: "weapon", weapon: { damage: "1d6", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  staff: {
    name: "Staff", slots: 1, quality: 3, value: 5,
    itemKind: "weapon", weapon: { damage: "1d6", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  spear: {
    name: "Spear", slots: 2, quality: 3, value: 10,
    itemKind: "weapon", weapon: { damage: "1d8", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  sword: {
    name: "Sword", slots: 2, quality: 3, value: 10,
    itemKind: "weapon", weapon: { damage: "1d8", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  mace: {
    name: "Mace", slots: 2, quality: 3, value: 10,
    itemKind: "weapon", weapon: { damage: "1d8", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  axe: {
    name: "Axe", slots: 2, quality: 3, value: 10,
    itemKind: "weapon", weapon: { damage: "1d8", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  flail: {
    name: "Flail", slots: 2, quality: 3, value: 10,
    itemKind: "weapon", weapon: { damage: "1d8", hands: 1 },
    base: "",
    state: "",
    composed: "",
  },
  halberd: {
    name: "Halberd", slots: 3, quality: 3, value: 20,
    itemKind: "weapon", weapon: { damage: "1d10", hands: 2 },
    base: "",
    state: "",
    composed: "",
  },
  war_hammer: {
    name: "War Hammer", slots: 3, quality: 3, value: 20,
    itemKind: "weapon", weapon: { damage: "1d10", hands: 2 },
    base: "",
    state: "",
    composed: "",
  },
  long_sword: {
    name: "Long Sword", slots: 3, quality: 3, value: 20,
    itemKind: "weapon", weapon: { damage: "1d10", hands: 2 },
    base: "",
    state: "",
    composed: "",
  },
  battle_axe: {
    name: "Battle Axe", slots: 3, quality: 3, value: 20,
    itemKind: "weapon", weapon: { damage: "1d10", hands: 2 },
    base: "",
    state: "",
    composed: "",
  },
  sling: {
    name: "Sling", slots: 1, quality: 3, value: 5,
    itemKind: "weapon", weapon: { damage: "1d4", hands: 1, ranged: true },
    base: "",
    state: "",
    composed: "",
  },
  bow: {
    name: "Bow", slots: 2, quality: 3, value: 15,
    itemKind: "weapon", weapon: { damage: "1d6", hands: 2, ranged: true },
    base: "",
    state: "",
    composed: "",
  },
  crossbow: {
    name: "Crossbow", slots: 3, quality: 3, value: 60,
    itemKind: "weapon", weapon: { damage: "1d8", hands: 2, ranged: true },
    base: "",
    state: "",
    composed: "",
  },

  // --- gear ------------------------------------------------------------------
  air_bladder: {
    name: "Air bladder", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  bear_trap: {
    name: "Bear trap", value: 20,
    base: "",
    state: "",
    composed: "",
  },
  bedroll: {
    name: "Bedroll", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  bellows: {
    name: "Bellows", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  grease: {
    name: "Black grease", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  block_and_tackle: {
    name: "Block and tackle", value: 30,
    base: "",
    state: "",
    composed: "",
  },
  blank_book: {
    name: "Blank book", value: 300,
    base: "",
    state: "",
    composed: "",
  },
  reading_book: {
    name: "Reading book", value: 600,
    itemKind: "book",
    base: "",
    state: "",
    composed: "",
  },
  bottle: {
    name: "Bottle", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  bucket: {
    name: "Bucket", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  caltrops: {
    name: "Caltrops", amount: "1 bag", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  marked_cards: {
    name: "Cards with an extra ace", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  chain: {
    name: "Chain", amount: "10 feet", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  chalk: {
    name: "Chalk", amount: "10 pieces", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  chisel: {
    name: "Chisel", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  cookpots: {
    name: "Cookpots", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  crowbar: {
    name: "Crowbar", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  drill: {
    name: "Drill", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  face_paint: {
    name: "Face paint", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  fake_jewels: {
    name: "Fake jewels", value: 50,
    base: "",
    state: "",
    composed: "",
  },
  fishing_rod: {
    name: "Fishing rod and tackle", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  glass_marbles: {
    name: "Glass marbles", amount: "1 bag", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  glue: {
    name: "Glue", amount: "1 bottle", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  grappling_hook: {
    name: "Grappling hook", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  hammer: {
    name: "Hammer", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  holy_water: {
    name: "Holy water", value: 25,
    base: "",
    state: "",
    composed: "",
  },
  horn: {
    name: "Horn", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  hourglass: {
    name: "Hourglass", value: 300,
    base: "",
    state: "",
    composed: "",
  },
  incense: {
    name: "Incense", amount: "1 packet", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  iron_tongs: {
    name: "Iron tongs", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  ladder: {
    name: "Ladder", amount: "10 feet", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  sponge: {
    name: "Large sponge", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  lens: {
    name: "Lens", value: 100,
    base: "",
    state: "",
    composed: "",
  },
  lockpicks: {
    name: "Lockpicks", value: 100,
    base: "",
    state: "",
    composed: "",
  },
  manacles: {
    name: "Manacles", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  metal_file: {
    name: "Metal file", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  mirror: {
    name: "Small silver mirror", value: 200,
    base: "",
    state: "",
    composed: "",
  },
  musical_instrument: {
    name: "Musical instrument", value: 200,
    base: "",
    state: "",
    composed: "",
  },
  nails: {
    name: "Nails", amount: "12", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  net: {
    name: "Net", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  oilskin_bag: {
    name: "Oilskin bag", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  oilskin_trousers: {
    name: "Oilskin trousers", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  padlock: {
    name: "Padlock and key", value: 20,
    base: "",
    state: "",
    composed: "",
  },
  perfume: {
    name: "Perfume", value: 50,
    base: "",
    state: "",
    composed: "",
  },
  pick: {
    name: "Pick", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  pole: {
    name: "Pole", amount: "10 feet", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  quill_and_ink: {
    name: "Quill and ink", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  rope: {
    name: "Rope", amount: "50 feet", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  sack: {
    name: "Sack", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  saw: {
    name: "Saw", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  loaded_dice: {
    name: "Set of loaded dice", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  shovel: {
    name: "Shovel", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  small_bell: {
    name: "Small bell", value: 20,
    base: "",
    state: "",
    composed: "",
  },
  soap: {
    name: "Soap", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  iron_spike: {
    name: "Iron spike", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  wood_spike: {
    name: "Wooden spike", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  spiked_boots: {
    name: "Spiked boots", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  spyglass: {
    name: "Spyglass", value: 1000,
    base: "",
    state: "",
    composed: "",
  },
  tar: {
    name: "Tar", amount: "1 pot", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  tent_3man: {
    name: "Three-man tent", value: 100,
    base: "",
    state: "",
    composed: "",
  },
  tent_personal: {
    name: "Personal tent", value: 50,
    base: "",
    state: "",
    composed: "",
  },
  twine: {
    name: "Twine", amount: "300 feet", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  waterskin: {
    name: "Waterskin", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  whistle: {
    name: "Whistle", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  candle: {
    name: "Candle", amount: "4 hours", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  lantern: {
    name: "Lantern", value: 30,
    base: "",
    state: "",
    composed: "",
  },
  lamp_oil: {
    name: "Lamp oil", amount: "4 hours", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  tinderbox: {
    name: "Tinderbox", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  torch: {
    name: "Torch", amount: "1 hour", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  arrows: {
    name: "Arrows", amount: "20", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  quiver: {
    name: "Quiver", amount: "capacity 20", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  poor_clothing: {
    name: "Poor clothing", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  standard_clothing: {
    name: "Standard clothing", value: 50,
    base: "",
    state: "",
    composed: "",
  },
  winter_clothing: {
    name: "Winter clothing", value: 100,
    base: "",
    state: "",
    composed: "",
  },
  noble_clothing: {
    name: "Noble clothing", value: 3000,
    base: "",
    state: "",
    composed: "",
  },
  furs: {
    name: "Furs", value: 5000,
    base: "",
    state: "",
    composed: "",
  },
  rations: {
    name: "Travel rations", amount: "1 day", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  animal_feed: {
    name: "Animal feed", amount: "1 day", value: 2,
    base: "",
    state: "",
    composed: "",
  },
  bacon: {
    name: "Bacon", amount: "1 side", value: 10,
    base: "",
    state: "",
    composed: "",
  },
  bread: {
    name: "Bread", amount: "1 loaf", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  cheese: {
    name: "Cheese", amount: "1 lb", value: 2,
    base: "",
    state: "",
    composed: "",
  },
  cider: {
    name: "Cider", amount: "4 gallons", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  cod: {
    name: "Cod", amount: "whole", value: 20,
    base: "",
    state: "",
    composed: "",
  },
  eggs: {
    name: "Eggs", amount: "24", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  flour: {
    name: "Flour", amount: "5 lbs", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  fruit: {
    name: "Fruit", amount: "1 lb", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  garlic: {
    name: "Garlic", amount: "1 bunch", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  grain: {
    name: "Grain", amount: "1 bushel", value: 4,
    base: "",
    state: "",
    composed: "",
  },
  herbs: {
    name: "Herbs", amount: "1 bunch", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  lard: {
    name: "Lard", amount: "5 lbs", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  onions: {
    name: "Onions", amount: "1 bushel", value: 8,
    base: "",
    state: "",
    composed: "",
  },
  salt: {
    name: "Salt", amount: "1 bushel", value: 3,
    base: "",
    state: "",
    composed: "",
  },
  spices: {
    name: "Spices", amount: "1 lb", value: 100,
    base: "",
    state: "",
    composed: "",
  },
  sugar: {
    name: "Sugar", amount: "1 lb", value: 12,
    base: "",
    state: "",
    composed: "",
  },
  wine: {
    name: "Wine or ale", amount: "1 bottle", value: 1,
    base: "",
    state: "",
    composed: "",
  },
  card_deck: {
    name: "Card deck", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  dice_set: {
    name: "Dice set", value: 5,
    base: "",
    state: "",
    composed: "",
  },
  // --- not on either printed list --------------------------------------------
  // Knave gives a spellbook no price, and copper isn't bought. Characters still
  // carry both, so both have entries. The spellbook's 500 is our own
  // placeholder (about eight gambesons) until spells are properly priced.
  spellbook: {
    name: "Spellbook", slots: 1, value: 500,
    itemKind: "spellbook",
    base: "",
    state: "",
    composed: "",
  },
  copper: {
    name: "Copper", slots: 0, value: 0,
    base: "",
    state: "",
    composed: "",
  },
} satisfies Record<string, ItemTemplate>;

export type EquipmentKey = keyof typeof STANDARD_EQUIPMENT;

/** The template for `key`, for a screen that shows an item nobody has bought yet. */
export function equipment(key: EquipmentKey): ItemTemplate {
  return STANDARD_EQUIPMENT[key];
}

/**
 * The weapon stats of a catalogue entry, or undefined if it isn't a weapon
 * (and `armorFacts` below for armour). For screens showing items nobody has
 * bought yet, so the shop and the weapon picker don't each repeat the same
 * `itemKind` check.
 */
export function weaponFacts(key: EquipmentKey): WeaponFacts | undefined {
  const t: ItemTemplate = STANDARD_EQUIPMENT[key];
  return t.itemKind === "weapon" ? t.weapon : undefined;
}

export function armorFacts(key: EquipmentKey): ArmorFacts | undefined {
  const t: ItemTemplate = STANDARD_EQUIPMENT[key];
  return t.itemKind === "armor" ? t.armor : undefined;
}

/**
 * The number at the start of an item's `amount`, or undefined if there isn't
 * one.
 *
 * `amount` is text ("2 days", "6 doses", "50 feet", "a handful"), because
 * that's how people describe quantities, and the game never does arithmetic
 * on it. The only question asked of it is whether the item has run out, and
 * this is all the parsing that needs.
 *
 * Undefined and 0 mean different things. "A handful" has no number and must
 * not count as used up; only an amount that says 0 is empty. `applyToItem` in
 * `src/gameplay/diffs/handlers.ts` relies on this: it destroys an item only
 * when this returns 0.
 *
 * Copper is parsed separately by `purse` in `character-creation.ts`, on
 * purpose: for money the amount and the `value` must stay equal, which
 * `setPurse` handles, and that rule doesn't apply to other items.
 */
export function amountCount(amount: string | undefined): number | undefined {
  const n = Number.parseInt(amount?.trim() ?? "", 10);
  return Number.isFinite(n) ? n : undefined;
}

// ===========================================================================
// MINTING
// ===========================================================================

/**
 * Lets one entry come in a different quantity and price. Knave's gear table
 * gives five torches worth five copper, while its shop sells one for one
 * copper; that is the only way the two lists disagree.
 */
export interface ItemOverride {
  amount?: string;
  value?: number;
}

/**
 * The `state` given to a new item whose entry has a `base` but no `state`.
 *
 * An item with no `state` counts as not yet encountered (see the description
 * fields at the top of `src/shared/world/entities.ts`), which would be wrong
 * for something already in the player's inventory.
 */
export const STOCK_STATE = "Sound and unremarkable; nothing has happened to it yet.";

const written = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t === "" ? undefined : t;
};

/**
 * Creates the fields every item has, whatever its kind.
 *
 * `composed` falls back to `base`. If the item ends up with either,
 * `needUpdate` is set to false: it already counts as described, and the game
 * won't spend a model call describing it. An entry with no descriptions at
 * all creates an undescribed item and leaves `needUpdate` unset.
 */
function mintCommon(t: ItemTemplate, parentId: string, over: ItemOverride): IItem {
  const base = written(t.base);
  const state = written(t.state) ?? (base === undefined ? undefined : STOCK_STATE);
  const composed = written(t.composed) ?? base;
  const amount = over.amount ?? t.amount;

  return {
    id: makeId(),
    name: t.name,
    type: "Item",
    parentId,
    slots: t.slots ?? 1,
    value: over.value ?? t.value,
    ...(amount !== undefined ? { amount } : {}),
    ...(t.quality !== undefined ? { quality: t.quality, currentQuality: t.quality } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(composed !== undefined ? { composed, needUpdate: false } : {}),
  };
}

/**
 * Rolls a book's subject on the Maze Rats table, unless the template sets one.
 *
 * The subject is fixed when the book is created. How much the book holds is
 * not: `uses` starts at 0 and goes up with each reading, and `consultRoll` in
 * `rolls.ts` decides at each reading whether it was the last.
 */
function mintBook(t: BookTemplate, rng: Rng | undefined): BookFacts {
  const uses = t.book?.uses ?? 0;
  if (t.book?.subject !== undefined) return { subject: t.book.subject, uses };
  if (!rng) throw new Error(`${t.name} is a book and rolls for its subject — mint it with an Rng`);
  return { subject: rollBookSubject(rng), uses };
}

/**
 * Creates an item from a template. Every item this file creates goes through
 * here.
 *
 * Separate from `mintItem` so that a template from elsewhere (a test, or an
 * item the game has just made up) is created the same way as a catalogue
 * entry.
 *
 * The `Rng` is optional because most items roll nothing; copper or a rope is
 * fully described by its template. Books need it for their subject, so
 * creating a book without one throws instead of making up a subject.
 */
export function mintTemplate(
  t: ItemTemplate,
  parentId: string,
  rng?: Rng,
  over: ItemOverride = {}
): AnyItem {
  const item = mintCommon(t, parentId, over);

  switch (t.itemKind) {
    case "weapon":
      return { ...item, itemKind: "weapon", weapon: { ...t.weapon } };
    case "armor":
      return { ...item, itemKind: "armor", armor: { ...t.armor } };
    case "book":
      return { ...item, itemKind: "book", book: mintBook(t, rng) };
    case "spellbook":
      // A spellbook needs a spell, which a template doesn't have.
      throw new Error(`${t.name} is a spellbook — mint it with mintSpellbook, which knows the spell`);
    default:
      return item;
  }
}

/** Creates the catalogue item with this key. */
export function mintItem(
  key: EquipmentKey,
  parentId: string,
  rng?: Rng,
  over: ItemOverride = {}
): AnyItem {
  return mintTemplate(STANDARD_EQUIPMENT[key], parentId, rng, over);
}

/**
 * Creates a spellbook: the `spellbook` entry plus the spell it holds.
 *
 * In Knave a spellbook holds one spell that can be cast once a day, so
 * `exhausted` is all the state it needs, and its content is the spell's
 * printed effect. The spell goes in the name so that several spellbooks can
 * be told apart.
 */
export function mintSpellbook(spell: Spell, parentId: string): ISpellbook {
  const t: ItemTemplate = STANDARD_EQUIPMENT.spellbook;
  return {
    ...mintCommon(t, parentId, {}),
    name: `Spellbook: ${spell.name}`,
    itemKind: "spellbook",
    spellBook: { spellName: spell.name, spellDescription: spell.effect, exhausted: false },
  };
}

// ===========================================================================
// WHAT SOMETHING FOUND IS WORTH
// ===========================================================================
//
// Not decided in this file. A dungeon's total wealth is fixed at generation
// and divided among its treasure before any model sees it
// (`src/generation/content/rewards.ts`). A found item's value comes with it,
// either from that share or from the catalogue above, so the game master
// never picks a number.
