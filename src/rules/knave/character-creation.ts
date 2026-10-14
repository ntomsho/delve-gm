/**
 * CHARACTER CREATION
 * ==================
 *
 * Pure and seeded, like all of the domain code outside the shells. Every number a
 * character is made of comes from an `Rng` passed in — the same rule the
 * game master lives under at runtime, applied here so that a character is a
 * function of a seed and a handful of choices rather than of when it was made.
 *
 * The tables are in `tables.ts`. This file is the dice and the rules.
 *
 * ROLLS CARRY THEIR DICE. `rollAbilities` returns the individual d6s and
 * `rollStartingGear` returns the d20 that produced each line, because the
 * interface prints them — "2d6 → 4 2", "d20→11". A screen that had to re-derive
 * those would be inventing numbers, which is the one thing nothing in this
 * project is allowed to do.
 *
 * TWO MODES. Normal is the generous one and hardcore is close to the book:
 *
 *   |                | normal    | hardcore | Knave 1.0 as printed |
 *   |----------------|-----------|----------|----------------------|
 *   | ability dice   | 2d6 low   | 3d6 low  | 3d6, keep lowest     |
 *   | swaps          | 2         | 1        | 1 (a swap of two)    |
 *   | point buy      | 10 pts    | 7 pts    | — (not in the book)  |
 *   | rerolls        | 3         | 0        | — (not in the book)  |
 *   | hit points     | 2d8 min 9 | d8 min 5 | d8, no floor         |
 *
 * The hit point floors are the sharpest departure from the book, and the reason
 * is the same one Knave's own note gives when it suggests letting a PC reroll
 * below 5: a level 1 character on 1 HP is not a hard start, it is a character
 * who does not get to play. Normal takes two dice and floors at 9; hardcore
 * keeps the single die and floors at 5.
 *
 * WHAT A REROLL BUYS. One budget, spent from three screens: abilities, hit
 * points, and starting gear. Traits are free — they are flavour and a player
 * fishing for a face they like is not gaming anything. Hit points are not
 * free, because an unlimited d8 is an 8 every time.
 */

import { Rng, makeId } from "../../generation/content/blueprint.ts";
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
 * `Ability` is `dungeon-entities`', not a second copy — a creature's six and a
 * character's six are the same six, and two unions that must agree are one
 * union.
 */
export const ABILITIES: readonly Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export type TraitKey = keyof CharacterTraits;
export const TRAIT_KEYS: readonly TraitKey[] = [
  "physique", "face", "skin", "hair", "clothing", "virtue",
  "vice", "speech", "background", "misfortunes", "alignment",
];

/** Build one record per ability, without a cast that outruns what TS can see. */
function perAbility<T>(f: (a: Ability) => T): Record<Ability, T> {
  return { str: f("str"), dex: f("dex"), con: f("con"), int: f("int"), wis: f("wis"), cha: f("cha") };
}

// ===========================================================================
// MODES
// ===========================================================================

export type { CreationMode };

export interface CreationRules {
  /** How many d6 per ability. The LOWEST is the bonus, either way. */
  abilityDice: 2 | 3;
  /** How many pairs of abilities may be swapped after rolling. */
  swaps: number;
  /** Point-buy budget, above the +1 every ability starts at. */
  pointBuy: number;
  /** Rerolls for the whole of creation — abilities, hit points, gear. */
  rerolls: number;
  /** How many d8, and the total the result is never allowed below. */
  hp: { dice: number; floor: number };
}

export const CREATION_RULES: Record<CreationMode, CreationRules> = {
  normal: { abilityDice: 2, swaps: 2, pointBuy: 10, rerolls: 3, hp: { dice: 2, floor: 9 } },
  hardcore: { abilityDice: 3, swaps: 1, pointBuy: 7, rerolls: 0, hp: { dice: 1, floor: 5 } },
};

/** The best a mode's hit dice can do, for a screen that wants to show a range. */
export const hpCeiling = (mode: CreationMode): number => CREATION_RULES[mode].hp.dice * 8;

export const CREATION_MODES: readonly CreationMode[] = ["normal", "hardcore"];

// ===========================================================================
// ABILITIES
// ===========================================================================

/** One ability's roll, dice and all. `bonus` is the lowest die. */
export interface AbilityRoll {
  dice: number[];
  bonus: number;
}

export type AbilityRolls = Record<Ability, AbilityRoll>;

/** Roll n d6 and keep the lowest — Knave's mechanic, with n set by the mode. */
export function rollAbility(rng: Rng, mode: CreationMode): AbilityRoll {
  const dice = Array.from({ length: CREATION_RULES[mode].abilityDice }, () => rng.d(6));
  return { dice, bonus: Math.min(...dice) };
}

/** All six, in order. */
export function rollAbilities(rng: Rng, mode: CreationMode): AbilityRolls {
  // Rolled in ABILITIES order, so one seed gives one spread. `perAbility` would
  // fix the order too, but stating it here is what makes that a promise.
  const out = {} as AbilityRolls;
  for (const a of ABILITIES) out[a] = rollAbility(rng, mode);
  return out;
}

export function bonusesOf(rolls: AbilityRolls): CharacterAbilities {
  return perAbility((a) => rolls[a].bonus);
}

/**
 * Swap two abilities. The DICE travel with the bonus, because the card shows
 * both and a swap that moved the number but left "2d6 → 4 2" underneath would
 * be showing the player a lie about where their +5 came from.
 *
 * **Its own inverse**, which is what lets a swap be taken back: applying it a
 * second time to the same pair restores exactly the state before the first, so
 * an undo needs no saved copy of the spread — only the pair.
 */
export function swapAbilities(rolls: AbilityRolls, x: Ability, y: Ability): AbilityRolls {
  return { ...rolls, [x]: rolls[y], [y]: rolls[x] };
}

// ---------------------------------------------------------------------------
// POINT BUY
// ---------------------------------------------------------------------------

/**
 * Every ability starts at +1, and raising one to `v` costs `floor(v / 2)`. So
 * the first two steps are a point each and it gets dearer after that:
 *
 *   +1 → +2   1        +1 → +2 → +3        2
 *   +2 → +3   1        +1 → +2 → +3 → +4   4
 *   +3 → +4   2
 *
 * `MAX` is the ceiling on any one ability at level 1. Rolling can exceed it —
 * 2d6-keep-lowest can hand out a 6 — and that is allowed to stand; the cap is
 * on what a player may *choose*, not on what the dice may give.
 */
export const POINT_BUY = {
  START: 1,
  MAX: 4,
  costTo: (value: number): number => Math.floor(value / 2),
} as const;

/** What it costs to raise one ability from +1 to `value`. */
export function costOfAbility(value: number): number {
  let total = 0;
  for (let v = POINT_BUY.START + 1; v <= value; v++) total += POINT_BUY.costTo(v);
  return total;
}

/** What a whole spread costs. */
export function pointsSpent(a: CharacterAbilities): number {
  return ABILITIES.reduce((n, k) => n + costOfAbility(a[k]), 0);
}

export function pointsLeft(a: CharacterAbilities, mode: CreationMode): number {
  return CREATION_RULES[mode].pointBuy - pointsSpent(a);
}

/** The spread every point-buy character starts from: +1 across the board. */
export function startingBuy(): CharacterAbilities {
  return perAbility(() => POINT_BUY.START);
}

/** Whether one more step in `k` is affordable and legal. Cheap enough to call per render. */
export function canRaise(a: CharacterAbilities, k: Ability, mode: CreationMode): boolean {
  return a[k] < POINT_BUY.MAX && POINT_BUY.costTo(a[k] + 1) <= pointsLeft(a, mode);
}

/**
 * Everything wrong with a point-buy spread, as sentences. A list rather than a
 * boolean so the screen can say which rule was broken — the same reasoning as
 * the applier's rejection reasons.
 */
export function validatePointBuy(a: CharacterAbilities, mode: CreationMode): string[] {
  const issues: string[] = [];
  for (const k of ABILITIES) {
    if (a[k] < POINT_BUY.START) issues.push(`${k.toUpperCase()} is below the +${POINT_BUY.START} every ability starts at`);
    if (a[k] > POINT_BUY.MAX) issues.push(`${k.toUpperCase()} is above +${POINT_BUY.MAX}, the level 1 ceiling`);
  }
  const over = -pointsLeft(a, mode);
  if (over > 0) issues.push(`${over} point${over === 1 ? "" : "s"} over the ${CREATION_RULES[mode].pointBuy} available`);
  return issues;
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
  /** What the dice actually said, before the floor. */
  total: number;
  /** The starting total AND the maximum. There is not another one coming. */
  hp: number;
  /** Whether the floor did the work rather than the dice. */
  floored: boolean;
}

/**
 * Hit points, by mode: 2d8 floored at 9, or one d8 floored at 5.
 *
 * The dice are kept and the floor is reported separately, so the screen can say
 * *the rule caught you* rather than quietly print a number the dice never
 * showed. Same reasoning as the ability cards printing their d6s.
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
 * The six rolls, as the things a player can reroll one at a time. A slot is
 * one die, and one die can produce more than one item — 20 on Helmets and
 * Shields is a helmet AND a shield — which is why a group holds a list.
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

/** What the tables are called on the sheet. */
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
 * Everything a character walks in with. `groups` is empty on the buying path
 * and `copper` is 0 on the rolled one; the two paths are exclusive and the
 * shape says so without a discriminant nobody would read.
 */
export interface StartingKit {
  rations: AnyItem;
  weapon: AnyItem;
  groups: GearGroup[];
  copper: number;
  coin?: AnyItem;
}

/**
 * Nobody holds it yet. `finishCharacter` binds every item's `parentId` to the
 * character it mints, which is the last moment at which a kit is still a kit
 * rather than somebody's belongings.
 */
const PLACEHOLDER_PARENT = "";

/** One line of a d20 gear table, in the quantity that table prints. */
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
 * Copper as a carried thing, so the shop and the sheet read the same row.
 *
 * The amount is prose — `IItem.amount` is "count or measurement WITH its unit"
 * and money is no exception — which means somebody has to read it back. That is
 * `purse` below, and it lives here rather than in the shop so that the one file
 * writing this string is the one file parsing it.
 */
export const COPPER_NAME = "Copper";

/**
 * A purse is the one item whose `value` is not a fact about what kind of thing
 * it is: sixty copper is worth sixty copper. Written from the amount at every
 * mint, so the two can never disagree.
 */
export function copperItem(amount: number): AnyItem {
  return mintItem("copper", PLACEHOLDER_PARENT, undefined, {
    amount: `${amount} cp`,
    value: amount,
  });
}

/** The copper row, if they are carrying one. */
export function purseItem(pc: PlayerCharacter): AnyItem | undefined {
  return pc.inventory.find((i) => i.name === COPPER_NAME && i.amount?.endsWith(" cp"));
}

/** How much money they have. Nothing carried and nothing parseable both mean 0. */
export function purse(pc: PlayerCharacter): number {
  const n = Number.parseInt(purseItem(pc)?.amount ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Set the purse, in place. **A purse of nothing is no row at all** — a line
 * reading "Copper (0 cp)" on a sheet is noise, and an empty pocket is better
 * said by an empty pocket.
 *
 * Mutates, like `addItem` and `equip` beside it; the shop clones before it
 * calls anything here.
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
 * One table, one die. Rerollable on its own, which is what the interface's
 * per-line ↻ spends a reroll on.
 *
 * The two armor tables are house-ruled and can pay out a random spellbook
 * instead of protection — see `tables.ts` for the printed bands beside
 * ours. Everything else is a straight d20 index.
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
 * The rolled path. Two days of rations and the chosen weapon are free, then
 * one roll each on Armor, Helmets & Shields, General Gear 1 and General Gear 2,
 * and **two** on Dungeoneering Gear.
 */
export function rollKit(rng: Rng, weapon: WeaponKey): StartingKit {
  return {
    rations: gearItem(STARTING_RATIONS, rng),
    weapon: mintItem(weapon, PLACEHOLDER_PARENT, rng),
    groups: GEAR_SLOTS.map((slot) => rollGearSlot(rng, slot)),
    copper: 0,
  };
}

/** The other path: 3d6 × 20 copper and no gear rolls. The shop spends it. */
export function startingCopper(rng: Rng): number {
  return (rng.d(6) + rng.d(6) + rng.d(6)) * 20;
}

/** Rations, the chosen weapon, and the money. What a buyer walks in with. */
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

/** Swap the weapon without disturbing anything the dice decided. */
export function withWeapon(kit: StartingKit, rng: Rng, weapon: WeaponKey): StartingKit {
  return { ...kit, weapon: mintItem(weapon, PLACEHOLDER_PARENT, rng) };
}

/** Replace one slot's roll, leaving the other five where they are. */
export function rerollGearSlot(kit: StartingKit, rng: Rng, slot: GearSlot): StartingKit {
  const next = rollGearSlot(rng, slot);
  return { ...kit, groups: kit.groups.map((g) => (g.slot === slot ? next : g)) };
}

/** Everything carried, in the order it should be read. */
export function kitItems(kit: StartingKit): AnyItem[] {
  return [
    kit.rations,
    kit.weapon,
    ...kit.groups.flatMap((g) => g.items),
    ...(kit.coin ? [kit.coin] : []),
  ];
}

/**
 * What starts equipped. The weapon always; armor, helmet and shield when the
 * dice supplied them.
 *
 * A shield beside a two-hander is the one arrangement Knave forbids, so the
 * shield stays carried rather than worn — `canEquip` would refuse it and a
 * character who arrives failing `validateEquipment` is a character the applier
 * will complain about on the first commit of the run.
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
 * A name to start the field off with, not a name imposed. The lists are the
 * lower-class halves of the Maze Rats name tables in `blueprint.ts` —
 * copied rather than imported because those are private to that module and a PC
 * is not an NPC roll.
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
 * The one place a draft becomes a `PlayerCharacter`. Ids are minted here and
 * every item's `parentId` is bound to the character, which is the invariant
 * `addItem` maintains at runtime and which nothing downstream re-checks.
 *
 * Capacity is deliberately NOT enforced. A rolled kit can exceed CON defense —
 * that is Knave working as intended, `isOverburdened` reports it, and refusing
 * to make the character over it would mean silently dropping something the dice
 * gave them.
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

/** The weapons the picker offers, straight off the Item Costs page. */
export { WEAPONS };
