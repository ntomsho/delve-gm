/**
 * STANDARD EQUIPMENT
 * ==================
 *
 * One table of everything a shop sells, a gear roll can hand you, or a
 * character walks in carrying. The gear tables in `tables.ts` and the
 * shop's sections both index into it, so a rope is one object with one price
 * and one description however a player came by it.
 *
 * IT WAS TWO LISTS. Knave prints its starting-gear tables on p.2 and its Item
 * Costs on p.3, and they overlap without agreeing: 155 rows between them for
 * 113 distinct things, 42 of which were the same name twice, and another 16 the
 * same object under two labels — Torches and Torch, Padlock and Padlock and
 * key, Instrument and Musical instrument. Prose written per row would have been
 * written twice and drifted, which is the thing `tables.ts` opens by
 * refusing. So the rows became keys into this, and the two places that print a
 * name print the same one.
 *
 * A TEMPLATE IS AN ITEM, minus the three things only a minted copy can know:
 * its id, who is holding it, and whatever its kind rolls for. There is no
 * separate shape for "the description of a rope" — an item is an entity and
 * carries what every entity carries, so `base`, `state` and `composed` are
 * written here, on the entry, in the fields they will end up in.
 *
 * WHY THE PROSE IS WRITTEN AND NOT GENERATED. `composed` is the only one of the
 * three the player has read, and for a gambeson it is the same paragraph in
 * every run of every dungeon — a call spent writing it is a call spent
 * reproducing a description of a quilted coat. Filling an entry in here retires
 * that call forever. An entry left blank is not broken: it mints exactly what
 * it minted before this file existed, prose-less, and the runtime writes one
 * when it first has to.
 *
 * WHAT `amount` IS FOR. A count or a measure — "50 feet", "5", "4 hours". The
 * Item Costs page also used it for variants (Book *blank*, Spike *iron*, Tent
 * *3 man*), which is a different kind of fact entirely; those are folded into
 * the name here, so `amount` means one thing.
 *
 * The cycle between this file and `tables.ts` is types only — the tables
 * take `EquipmentKey`, this takes `Spell` — so nothing of it survives to
 * runtime.
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

/** What a copy knows and a template cannot: who it is, and who holds it. */
type Minted = "id" | "parentId" | "type";

/**
 * Five templates rather than one with everything optional, so that an entry
 * calling itself a weapon without a damage die does not compile. `slots`
 * defaults to 1 at the mint — Knave says most items take one and only armor and
 * weapons say otherwise — and a book's own facts are rolled there too.
 */
export type GearTemplate = Omit<IItem, Minted | "slots"> & { slots?: number; itemKind?: "gear" };
export type WeaponTemplate = Omit<IWeapon, Minted | "slots"> & { slots?: number };
export type ArmorTemplate = Omit<IArmor, Minted | "slots"> & { slots?: number };
export type BookTemplate = Omit<IBook, Minted | "slots" | "book"> & {
  slots?: number;
  /** pin either half; whatever is left out is rolled when the book is made */
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
 * Every standard thing, keyed. Prices are Knave's Item Costs page in copper
 * pennies, which is also what the thing is WORTH — a shop that sold at one
 * number and valued at another would be two tables again.
 *
 * Armor and weapons are here rather than in a stat table of their own: their
 * numbers are item fields, and a gambeson's price, slots, quality and defense
 * are four facts about one object.
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
  // A spellbook has no price in Knave and a purse is not bought at all. Both
  // are still standard things a character carries, so both are described here.
  // The 500 is ours: eight gambesons, half a chain shirt, and a placeholder
  // until somebody decides what a spell is actually worth.
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

export const EQUIPMENT_KEYS = Object.keys(STANDARD_EQUIPMENT) as EquipmentKey[];

/** The template, for a screen that wants to price or describe a thing unbought. */
export function equipment(key: EquipmentKey): ItemTemplate {
  return STANDARD_EQUIPMENT[key];
}

/**
 * The kind-specific facts of an ENTRY, for a screen pricing something nobody
 * has bought yet. Narrowing the template union in one place, so a shop row and
 * a weapon picker do not each write the same `itemKind ===` test.
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
 * HOW MANY ARE LEFT, WHERE THE STRING SAYS SO.
 *
 * `amount` is prose — "2 days", "6 doses", "50 feet", "a handful" — because that
 * is how a player and a game master talk about a measure, and none of it is a number
 * the game does arithmetic on. The one question anything asks of it is whether
 * it has run out, and this is the whole of the parsing: the leading integer, or
 * nothing.
 *
 * NOTHING IS NOT ZERO, and the difference is a thing being deleted. "A handful"
 * has no count and must survive being written; only a stated zero is empty. So
 * this returns `undefined` rather than 0 for anything it cannot read, and the
 * caller that erases items reads it that way — see `applyToItem`.
 *
 * The purse parses its own string in `character-creation.ts` and keeps doing so.
 * That is deliberate: money is a value as well as a count, `setPurse` writes
 * both from one number, and folding the two together would make one function
 * answer to two different invariants.
 */
export function amountCount(amount: string | undefined): number | undefined {
  const n = Number.parseInt(amount?.trim() ?? "", 10);
  return Number.isFinite(n) ? n : undefined;
}

/** The display name, for a table row that has nothing else to draw. */
export function equipmentName(key: EquipmentKey): string {
  const t: ItemTemplate = STANDARD_EQUIPMENT[key];
  return t.amount ? `${t.name} (${t.amount})` : t.name;
}

// ===========================================================================
// MINTING
// ===========================================================================

/**
 * What the two printed tables disagreed about: the same object in a different
 * quantity at a different price. Knave's gear roll hands you five torches for
 * five copper and its shop sells one for one, and that is the whole of the
 * difference between them.
 */
export interface ItemOverride {
  amount?: string;
  value?: number;
}

/**
 * What a bought or rolled thing is like before anything has happened to it.
 *
 * Used only where an entry has a `base` and no `state` of its own. A carried
 * item with no state at all would read as NOT YET ENCOUNTERED, which is exactly
 * wrong for something in the player's own pack — see the lifetimes at the top
 * of `entities.ts`.
 */
export const STOCK_STATE = "Sound and unremarkable; nothing has happened to it yet.";

const written = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t === "" ? undefined : t;
};

/**
 * The part every item has, whatever kind it is.
 *
 * `composed` falls back to `base` and settles the description debt, which is
 * the point of the whole file: a thing that arrives described is never swept up
 * by a composition pass. An entry with no prose at all stays undescribed and
 * `needUpdate` is left alone, so an unfilled table mints what it always did.
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
 * Maze Rats: a book is about something.
 *
 * The subject is rolled here because it is what the book IS. How much is in it
 * is not — `uses` starts at nothing and climbs as the book is read, and whether
 * a reading was the last one is settled at the reading. See `consultRoll`.
 */
function mintBook(t: BookTemplate, rng: Rng | undefined): BookFacts {
  const uses = t.book?.uses ?? 0;
  if (t.book?.subject !== undefined) return { subject: t.book.subject, uses };
  if (!rng) throw new Error(`${t.name} is a book and rolls for its subject — mint it with an Rng`);
  return { subject: rollBookSubject(rng), uses };
}

/**
 * An item from a template, which is what every mint here comes down to.
 *
 * Separate from `mintItem` so that a template built somewhere else — a test, or
 * a thing the fiction has just invented — goes through exactly the same door as
 * a table entry, rather than through a second construction that could disagree
 * with it.
 *
 * The `Rng` is optional because most kinds roll for nothing — a purse of copper
 * and a coil of rope are entirely decided by the template — and required in
 * practice for the one kind that does. Which kinds those are is this file's
 * business rather than the caller's, so a book minted without a stream throws
 * here rather than quietly inventing what is written in it.
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
      // The template has everything about a spellbook except the one thing that
      // makes it worth carrying, and this function has no way to know it.
      throw new Error(`${t.name} is a spellbook — mint it with mintSpellbook, which knows the spell`);
    default:
      return item;
  }
}

/** One standard thing, ready to be carried. */
export function mintItem(
  key: EquipmentKey,
  parentId: string,
  rng?: Rng,
  over: ItemOverride = {}
): AnyItem {
  return mintTemplate(STANDARD_EQUIPMENT[key], parentId, rng, over);
}

/**
 * A spellbook, which is the `spellbook` entry plus the spell it holds.
 *
 * Knave's spellbook is one spell read once a day, so `exhausted` is the whole
 * of its state and the spell's own printed effect is the whole of its content.
 * The name carries the spell because a shelf of four books all called
 * "Spellbook" is a shelf nobody can act on.
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
// NOTHING, HERE. `VALUE_BANDS` and `rollItemValue` were the whole of it, and
// they are gone: grade alone set an item's worth, so a dungeon's total take was
// whatever its grades happened to roll -- three significant parcels was
// 3,600-36,000cp against a Knave starting purse of 60-360.
//
// Money is a conserved pot now, partitioned across the placed treasure before
// anything reaches the LLM. See `rewards.ts`. What a found thing is
// worth arrives WITH it, from the share it drew or from the catalog above, and
// the game master still never names a number.
