/**
 * Character creation: the dice and rules for making a Knave character. The
 * tables they roll on are in `tables.ts`.
 *
 * Every number comes from an `Rng` passed in, so the same seed and the same
 * choices always make the same character.
 *
 * Rolls return their individual dice, not just the result: `rollAbilities`
 * returns each d6 and `rollGearSlot` returns the d20 behind each line of
 * gear. The creation screens show those dice ("2d6 → 4 2", "d20 → 11"), and
 * they must show the dice that were actually rolled, not numbers made up to
 * match the result.
 *
 * There are two modes. Normal is more generous; hardcore is close to the book:
 *
 *   |                | normal    | hardcore | Knave 1.0 as printed |
 *   |----------------|-----------|----------|----------------------|
 *   | ability dice   | 2d6 low   | 3d6 low  | 3d6, keep lowest     |
 *   | swaps          | 2         | 1        | 1 (a swap of two)    |
 *   | point buy      | 10 pts    | 7 pts    | — (not in the book)  |
 *   | rerolls        | 3         | 0        | — (not in the book)  |
 *   | hit points     | 2d8 min 9 | d8 min 5 | d8, no floor         |
 *
 * The minimum hit points are the biggest change from the book. Knave itself
 * suggests letting a character reroll hit points below 5, for the same reason:
 * a level 1 character with 1 hit point barely gets to play. Normal rolls two
 * d8s with a minimum of 9; hardcore rolls one d8 with a minimum of 5.
 *
 * Rerolls come from one budget, shared by three screens: abilities, hit points
 * and starting gear. Rerolling traits is free, because traits are only
 * description and rerolling them gains the player nothing. Hit point rerolls
 * cost one, because with unlimited rerolls every d8 would end up an 8.
 */

import { makeId } from "../../shared/utils/id.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { isArmor, isWeapon, type Ability, type AnyItem } from "../../shared/world/entities.ts";
import { mintItem, mintSpellbook, type EquipmentKey } from "./equipment.ts";
import type {
  CharacterAbilities,
  CharacterTraits,
  CreationMode,
  EquipSlot,
  EquippedSlots,
  PlayerCharacter,
} from "./character.ts";
import {
  DUNGEONEERING_GEAR,
  GENERAL_GEAR_1,
  GENERAL_GEAR_2,
  SPELLS,
  STARTING_RATIONS,
  TRAIT_TABLES,
  WEAPONS,
  rollArmorTable,
  rollHelmetShieldTable,
  type GearRow,
  type Spell,
  type WeaponKey,
} from "./tables.ts";

/**
 * The six abilities in sheet order. The `Ability` type comes from
 * `src/shared/world/entities.ts`, because creatures and characters have the
 * same six abilities and one type keeps them from drifting apart.
 */
export const ABILITIES: readonly Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export type TraitKey = keyof CharacterTraits;
export const TRAIT_KEYS: readonly TraitKey[] = [
  "physique", "face", "skin", "hair", "clothing", "virtue",
  "vice", "speech", "background", "misfortunes", "alignment",
];

/** Builds a record with one entry per ability, typed without needing a cast. */
function perAbility<T>(f: (a: Ability) => T): Record<Ability, T> {
  return { str: f("str"), dex: f("dex"), con: f("con"), int: f("int"), wis: f("wis"), cha: f("cha") };
}

// ===========================================================================
// MODES
// ===========================================================================

export type { CreationMode };

export interface CreationRules {
  /** How many d6 to roll per ability. In both modes the lowest die is the bonus. */
  abilityDice: 2 | 3;
  /** How many pairs of abilities may be swapped after rolling. */
  swaps: number;
  /** Points to spend in point buy, on top of the +1 every ability starts at. */
  pointBuy: number;
  /** Rerolls for all of creation, shared by abilities, hit points and gear. */
  rerolls: number;
  /** How many d8s to roll, and the minimum hit points. */
  hp: { dice: number; floor: number };
}

export const CREATION_RULES: Record<CreationMode, CreationRules> = {
  normal: { abilityDice: 2, swaps: 2, pointBuy: 10, rerolls: 3, hp: { dice: 2, floor: 9 } },
  hardcore: { abilityDice: 3, swaps: 1, pointBuy: 7, rerolls: 0, hp: { dice: 1, floor: 5 } },
};

/** The highest hit points a mode's dice can roll, for showing the range on screen. */
export const hpCeiling = (mode: CreationMode): number => CREATION_RULES[mode].hp.dice * 8;

export const CREATION_MODES: readonly CreationMode[] = ["normal", "hardcore"];

// ===========================================================================
// ABILITIES
// ===========================================================================

/** One ability's roll: the dice, and the bonus (the lowest die). */
export interface AbilityRoll {
  dice: number[];
  bonus: number;
}

export type AbilityRolls = Record<Ability, AbilityRoll>;

/** Rolls the mode's number of d6s and keeps the lowest, as Knave does. */
export function rollAbility(rng: Rng, mode: CreationMode): AbilityRoll {
  const dice = Array.from({ length: CREATION_RULES[mode].abilityDice }, () => rng.d(6));
  return { dice, bonus: Math.min(...dice) };
}

/** Rolls all six abilities, in `ABILITIES` order. */
export function rollAbilities(rng: Rng, mode: CreationMode): AbilityRolls {
  // The loop over ABILITIES fixes the roll order, so a seed always gives the
  // same abilities. `perAbility` would happen to use the same order, but this
  // makes it explicit.
  const out = {} as AbilityRolls;
  for (const a of ABILITIES) out[a] = rollAbility(rng, mode);
  return out;
}

export function bonusesOf(rolls: AbilityRolls): CharacterAbilities {
  return perAbility((a) => rolls[a].bonus);
}

/**
 * Swaps two abilities. The dice move with the bonus, because the screen shows
 * both, and moving only the bonus would show dice that didn't produce it.
 *
 * Swapping the same pair again undoes it exactly, so undoing a swap only
 * needs to remember the pair, not the whole set of rolls.
 */
export function swapAbilities(rolls: AbilityRolls, x: Ability, y: Ability): AbilityRolls {
  return { ...rolls, [x]: rolls[y], [y]: rolls[x] };
}

// ---------------------------------------------------------------------------
// POINT BUY
// ---------------------------------------------------------------------------

/**
 * Point buy. Every ability starts at +1, and each step up to `v` costs
 * `floor(v / 2)` points. The first two steps cost 1 each, then it gets more
 * expensive:
 *
 *   +1 → +2   1        +1 → +2 → +3        2
 *   +2 → +3   1        +1 → +2 → +3 → +4   4
 *   +3 → +4   2
 *
 * `MAX` is the highest a player can buy an ability to at level 1. Rolled
 * abilities can go higher (2d6 keep lowest can give a 6), and that is
 * allowed: the cap limits what a player can choose, not what the dice give.
 */
export const POINT_BUY = {
  START: 1,
  MAX: 4,
  costTo: (value: number): number => Math.floor(value / 2),
} as const;

/** The points it costs to raise one ability from +1 to `value`. */
export function costOfAbility(value: number): number {
  let total = 0;
  for (let v = POINT_BUY.START + 1; v <= value; v++) total += POINT_BUY.costTo(v);
  return total;
}

/** The points spent on all six abilities. */
export function pointsSpent(a: CharacterAbilities): number {
  return ABILITIES.reduce((n, k) => n + costOfAbility(a[k]), 0);
}

export function pointsLeft(a: CharacterAbilities, mode: CreationMode): number {
  return CREATION_RULES[mode].pointBuy - pointsSpent(a);
}

/** Where point buy starts: +1 in every ability. */
export function startingBuy(): CharacterAbilities {
  return perAbility(() => POINT_BUY.START);
}

/** Whether ability `k` can be raised by one: under `MAX` and affordable. Cheap enough to call on every render. */
export function canRaise(a: CharacterAbilities, k: Ability, mode: CreationMode): boolean {
  return a[k] < POINT_BUY.MAX && POINT_BUY.costTo(a[k] + 1) <= pointsLeft(a, mode);
}

// ===========================================================================
// TRAITS
// ===========================================================================

export function rollTrait(k: TraitKey, rng: Rng): string {
  const table = TRAIT_TABLES[k];
  return table[rng.d(table.length) - 1];
}

export function rollTraits(rng: Rng): CharacterTraits {
  const out = {} as CharacterTraits;
  for (const k of TRAIT_KEYS) out[k] = rollTrait(k, rng);
  return out;
}

// ===========================================================================
// HIT POINTS
// ===========================================================================

export interface HpRoll {
  dice: number[];
  /** The sum of the dice, before the minimum is applied. */
  total: number;
  /** The character's starting and maximum hit points (they start at full). */
  hp: number;
  /** True if the dice came in under the minimum, so the minimum set `hp`. */
  floored: boolean;
}

/**
 * Rolls hit points for the mode: 2d8 with a minimum of 9 (normal), or 1d8
 * with a minimum of 5 (hardcore).
 *
 * The dice are returned along with whether the minimum applied, so the screen
 * can show the real dice and say the minimum was used, instead of showing a
 * number the dice never rolled.
 */
export function rollHp(rng: Rng, mode: CreationMode): HpRoll {
  const { dice: count, floor } = CREATION_RULES[mode].hp;
  const dice = Array.from({ length: count }, () => rng.d(8));
  const total = dice.reduce((a, b) => a + b, 0);
  return { dice, total, hp: Math.max(total, floor), floored: total < floor };
}

// ===========================================================================
// STARTING GEAR
// ===========================================================================

/**
 * The six starting-gear rolls, each of which the player can reroll on its own.
 * Each is one d20 on one table. One roll can give more than one item (20 on
 * Helmets and Shields gives both), so a `GearGroup` holds a list.
 */
export type GearSlot =
  | "armor"
  | "helmetShield"
  | "dungeoneering1"
  | "dungeoneering2"
  | "general1"
  | "general2";

export const GEAR_SLOTS: readonly GearSlot[] = [
  "armor",
  "helmetShield",
  "dungeoneering1",
  "dungeoneering2",
  "general1",
  "general2",
];

/** Each gear table's name as the creation screen shows it. */
export const GEAR_SLOT_LABEL: Record<GearSlot, string> = {
  armor: "Armor",
  helmetShield: "Helmets & shields",
  dungeoneering1: "Dungeoneering gear",
  dungeoneering2: "Dungeoneering gear",
  general1: "General gear 1",
  general2: "General gear 2",
};

export interface GearGroup {
  slot: GearSlot;
  d20: number;
  items: AnyItem[];
}

/**
 * Everything a new character starts with. A player either rolls their gear
 * (`rollKit`) or gets money to buy it (`buyKit`). Rolled kits have `groups`
 * and `copper` 0; bought kits have no `groups` and the money in `copper` and
 * `coin`.
 */
export interface StartingKit {
  rations: AnyItem;
  weapon: AnyItem;
  groups: GearGroup[];
  copper: number;
  coin?: AnyItem;
}

/**
 * The `parentId` kit items have before the character exists.
 * `finishCharacter` replaces it with the new character's id.
 */
const PLACEHOLDER_PARENT = "";

/** Creates the item for one row of a d20 gear table, with the amount the table gives. */
function gearItem(row: GearRow, rng: Rng): AnyItem {
  return mintItem(row.key, PLACEHOLDER_PARENT, rng, {
    ...(row.amount !== undefined ? { amount: row.amount } : {}),
    ...(row.value !== undefined ? { value: row.value } : {}),
  });
}

export function rollSpell(rng: Rng): Spell {
  return SPELLS[rng.d(SPELLS.length) - 1];
}

/**
 * The name of the inventory item that holds the character's money. Money is
 * an ordinary item, so the shop and the character sheet read the same thing.
 *
 * Like every `IItem.amount`, the amount is text with its unit ("60 cp"), so
 * it has to be parsed to get the number. `purse` below does that. It is in
 * this file, not the shop, so the code that writes the text and the code that
 * parses it are in one place.
 */
export const COPPER_NAME = "Copper";

/**
 * Creates a copper item holding `amount`. Its `value` (what it is worth) is
 * set to the same amount every time, so the two can't disagree. Money is the
 * only item whose value depends on how much of it there is.
 */
export function copperItem(amount: number): AnyItem {
  return mintItem("copper", PLACEHOLDER_PARENT, undefined, {
    amount: `${amount} cp`,
    value: amount,
  });
}

/** The character's copper item, if they have one. */
export function purseItem(pc: PlayerCharacter): AnyItem | undefined {
  return pc.inventory.find((i) => i.name === COPPER_NAME && i.amount?.endsWith(" cp"));
}

/** How much copper the character has. 0 if they have no copper item or its amount can't be read. */
export function purse(pc: PlayerCharacter): number {
  const n = Number.parseInt(purseItem(pc)?.amount ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Sets how much copper the character has, changing `pc` in place. At 0 the
 * copper item is removed, so the sheet doesn't show "Copper (0 cp)".
 *
 * Changes `pc` directly, like `addItem` and `equip` in `character.ts`; the
 * shop makes a copy before calling it.
 */
export function setPurse(pc: PlayerCharacter, amount: number): void {
  const held = purseItem(pc);
  if (amount <= 0) {
    if (held) pc.inventory.splice(pc.inventory.indexOf(held), 1);
    return;
  }
  if (held) {
    held.amount = `${amount} cp`;
    held.value = amount;
  } else pc.inventory.push({ ...copperItem(amount), parentId: pc.id });
}

const PLAIN_TABLE: Partial<Record<GearSlot, readonly GearRow[]>> = {
  dungeoneering1: DUNGEONEERING_GEAR,
  dungeoneering2: DUNGEONEERING_GEAR,
  general1: GENERAL_GEAR_1,
  general2: GENERAL_GEAR_2,
};

/**
 * Rolls one gear table with one d20. The creation screen's ↻ button on each
 * line spends a reroll on this.
 *
 * The two armour tables are changed from the book so that some results give
 * a random spellbook instead of armour; `tables.ts` shows the book's ranges
 * beside ours. The other tables just use the d20 as a row number.
 */
export function rollGearSlot(rng: Rng, slot: GearSlot): GearGroup {
  const plain = PLAIN_TABLE[slot];
  if (plain) {
    const d20 = rng.d(20);
    return { slot, d20, items: [gearItem(plain[d20 - 1], rng)] };
  }

  const d20 = rng.d(20);
  const items: AnyItem[] = [];
  const armorItem = (key: EquipmentKey) => mintItem(key, PLACEHOLDER_PARENT, rng);
  const spellbook = () => mintSpellbook(rollSpell(rng), PLACEHOLDER_PARENT);

  if (slot === "armor") {
    const r = rollArmorTable(d20);
    if (r.armor) items.push(armorItem(r.armor));
    for (let i = 0; i < r.spellbooks; i++) items.push(spellbook());
  } else {
    const r = rollHelmetShieldTable(d20);
    if (r.helmet) items.push(armorItem("helmet"));
    if (r.shield) items.push(armorItem("shield"));
    for (let i = 0; i < r.spellbooks; i++) items.push(spellbook());
  }

  return { slot, d20, items };
}

/**
 * A rolled kit: two days of rations and the chosen weapon, then one roll each
 * on Armor, Helmets & Shields, General Gear 1 and General Gear 2, and two on
 * Dungeoneering Gear.
 */
export function rollKit(rng: Rng, weapon: WeaponKey): StartingKit {
  return {
    rations: gearItem(STARTING_RATIONS, rng),
    weapon: mintItem(weapon, PLACEHOLDER_PARENT, rng),
    groups: GEAR_SLOTS.map((slot) => rollGearSlot(rng, slot)),
    copper: 0,
  };
}

/** Starting money for a player who buys their gear: 3d6 × 20 copper, spent in the shop. */
export function startingCopper(rng: Rng): number {
  return (rng.d(6) + rng.d(6) + rng.d(6)) * 20;
}

/** A kit for buying: rations, the chosen weapon and starting money, with no gear rolls. */
export function buyKit(rng: Rng, weapon: WeaponKey): StartingKit {
  const copper = startingCopper(rng);
  return {
    rations: gearItem(STARTING_RATIONS, rng),
    weapon: mintItem(weapon, PLACEHOLDER_PARENT, rng),
    groups: [],
    copper,
    coin: copperItem(copper),
  };
}

/** Replaces the kit's weapon, leaving everything else as rolled. */
export function withWeapon(kit: StartingKit, rng: Rng, weapon: WeaponKey): StartingKit {
  return { ...kit, weapon: mintItem(weapon, PLACEHOLDER_PARENT, rng) };
}

/** Rerolls one gear table, leaving the other five as they were. */
export function rerollGearSlot(kit: StartingKit, rng: Rng, slot: GearSlot): StartingKit {
  const next = rollGearSlot(rng, slot);
  return { ...kit, groups: kit.groups.map((g) => (g.slot === slot ? next : g)) };
}

/** All the kit's items, in the order the inventory lists them. */
export function kitItems(kit: StartingKit): AnyItem[] {
  return [
    kit.rations,
    kit.weapon,
    ...kit.groups.flatMap((g) => g.items),
    ...(kit.coin ? [kit.coin] : []),
  ];
}

/**
 * What the character starts with equipped: always the weapon, plus any armour,
 * helmet and shield the kit has.
 *
 * Knave doesn't allow a shield with a two-handed weapon, so in that case the
 * shield is carried but not equipped. Equipping both would fail
 * `validateEquipment`, and the applier would object on the run's first commit.
 */
export function kitEquipped(kit: StartingKit): EquippedSlots {
  const equipped: EquippedSlots = { weapon: kit.weapon.id };
  const twoHanded = isWeapon(kit.weapon) && kit.weapon.weapon.hands === 2;

  for (const item of kit.groups.flatMap((g) => g.items)) {
    if (!isArmor(item)) continue;
    switch (item.armor.armorType) {
      case "body": equipped.armor = item.id; break;
      case "helmet": equipped.helmet = item.id; break;
      case "shield": if (!twoHanded) equipped.shield = item.id; break;
    }
  }
  return equipped;
}

// ===========================================================================
// NAMES
// ===========================================================================

const GIVEN = "Alma|Balthazar|Barsaba|Bertram|Bianca|Clovis|Constance|Damaris|Esme|Faustus|Fern|Hester|Jasper|Jessamine|Merrick|Mortimer|Nerissa|Odette|Oswald|Peregrine|Piety|Quentin|Silas|Sybil|Tuesday|Ursula|Waverly|Wendy".split("|");

const SURNAME = "Barrow|Beetleman|Berrycloth|Coffin|Culpepper|Dankworth|Digworthy|Dreggs|Gimble|Graveworm|Hardwick|Hovel|Knibbs|Midnighter|Nethercoat|Ottick|Relish|Rumbold|Rummage|Sallow|Saltmarsh|Silverless|Skitter|Slee|Stoker|Tarwater|Tumbler|Villin".split("|");

/**
 * A random name to fill the name field with; the player can change it. The
 * lists are the lower-class halves of the Maze Rats name tables in
 * `src/generation/content/blueprint.ts`. They are copied rather than imported
 * because those tables are private to that file and are for naming NPCs.
 */
export function rollName(rng: Rng): string {
  return `${rng.pick(GIVEN)} ${rng.pick(SURNAME)}`;
}

// ===========================================================================
// THE FINISHED CHARACTER
// ===========================================================================

export interface CharacterDraft {
  mode: CreationMode;
  name: string;
  abilities: CharacterAbilities;
  traits: CharacterTraits;
  hp: number;
  kit: StartingKit;
}

/**
 * Turns a finished draft into a `PlayerCharacter`. This is the only place that
 * happens. It creates the character's id and sets every item's `parentId` to
 * it. During play `addItem` keeps that true, and nothing else checks it.
 *
 * Carrying capacity is not enforced here. A rolled kit can be more than the
 * character's CON defense allows, which Knave permits; `isOverburdened`
 * reports it. Refusing would mean throwing away something the dice gave them.
 */
export function finishCharacter(draft: CharacterDraft): PlayerCharacter {
  const id = makeId();
  const inventory = kitItems(draft.kit).map((item) => ({ ...item, parentId: id }));
  const held = new Set(inventory.map((i) => i.id));
  const equipped: EquippedSlots = {};
  for (const [slot, itemId] of Object.entries(kitEquipped(draft.kit))) {
    if (itemId && held.has(itemId)) equipped[slot as EquipSlot] = itemId;
  }

  return {
    id,
    name: draft.name.trim() || "Nameless",
    level: 1,
    mode: draft.mode,
    hp: { current: draft.hp, max: draft.hp },
    abilities: { ...draft.abilities },
    traits: { ...draft.traits },
    inventory,
    equipped,
    conditions: [],
  };
}

/** The weapons the creation screen offers, from Knave's Item Costs page. */
export { WEAPONS };
