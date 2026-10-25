/**
 * The player character: the Knave 1.0 character sheet and the helpers that
 * change it.
 *
 * The character is made at character creation, before any run. Every game
 * master call includes the sheet, so the model always knows who the player
 * is, what they carry and what they have equipped. During play the diff
 * applier changes the sheet (inventory, equipment) through the helpers here.
 *
 * The sheet follows Knave: six abilities stored as bonuses (the matching
 * defense is always bonus + 10), hit points, a level, the eleven Knave traits,
 * an inventory of real Item entities, and a free-text list of conditions.
 *
 * Carrying capacity is also Knave's: a character has as many inventory slots
 * as their CON defense (CON bonus + 10). Each item takes up its `slots` value
 * (1 if unset). See the slot helpers below.
 */

import { isArmor, isBook, isWeapon, type ArmorType, type IItem } from "../../shared/world/entities.ts";

export interface CharacterAbilities {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/**
 * The eleven Knave traits, each stored as the full text that was rolled. The
 * UI shortens them where needed. Creation rolls all eleven, so none is ever
 * missing.
 */
export interface CharacterTraits {
  physique: string;
  face: string;
  skin: string;
  hair: string;
  clothing: string;
  virtue: string;
  vice: string;
  speech: string;
  background: string;
  misfortunes: string;
  alignment: string;
}

/**
 * What the character is holding and wearing. Each slot holds the id of an item
 * in `inventory`, since you can only equip what you carry. The equip helpers
 * below enforce the rules: each slot takes only its kind of item, and a shield
 * can't be used with a two-handed weapon.
 */
export interface EquippedSlots {
  weapon?: string;
  armor?: string;
  helmet?: string;
  shield?: string;
}

export type EquipSlot = keyof EquippedSlots;

/**
 * Which set of creation rules made this character (how dice, swaps, points
 * and rerolls work). `CREATION_RULES` in `character-creation.ts` has the
 * details. The type is defined here, not there, because `PlayerCharacter`
 * uses it and `character-creation.ts` already imports this file; importing
 * the other way would create a cycle.
 *
 * Optional: the test character has no mode, and a missing mode just means
 * "unknown".
 */
export type CreationMode = "normal" | "hardcore";

export interface PlayerCharacter {
  /** the character's entity id; each inventory item's `parentId` is set to it */
  id: string;
  name: string;
  /** Knave level, starting at 1. A level-up rolls this many d8s for maximum hit points. */
  level: number;
  /**
   * Total experience earned across every run this character survived.
   * `XP_PER_LEVEL` in `level-up.ts` is one level's worth.
   *
   * It only ever goes up. Gaining XP doesn't change `level` by itself: the
   * player takes each level they've earned on the level-up screen
   * (`applyLevelUp` in `level-up.ts`).
   *
   * Only surviving a run earns XP. The one place that adds to it is
   * `carriedOut` in `src/server/db/characters.ts`, which runs only when a run
   * ends in `escaped` or `goal_met`.
   *
   * Optional: characters made before XP existed don't have it, and missing
   * means 0.
   */
  xp?: number;
  /** Which creation rules made the character. Nothing changes it during play. */
  mode?: CreationMode;
  hp: { current: number; max: number };
  /** the six Knave abilities, stored as bonuses; each one's defense is bonus + 10 */
  abilities: CharacterAbilities;
  /** the eleven Knave traits */
  traits: CharacterTraits;
  /**
   * Everything carried, as full Item entities rather than names, because play
   * needs each item's quality, weapon or armour stats, amount and so on. Each
   * item's `parentId` is this character's id; `addItem` sets it.
   */
  inventory: IItem[];
  /** what is held and worn, as ids of items in `inventory`; see the equip helpers */
  equipped: EquippedSlots;
  /**
   * Free-text conditions such as "hungry", "poisoned", "blessed", "leg wound".
   * No code enforces them; the game master reads them and decides what they
   * mean in the story.
   */
  conditions: string[];
}

// ===========================================================================
// INVENTORY SLOTS  (Knave: capacity = CON defense = CON bonus + 10)
// ===========================================================================

export interface SlotReport {
  capacity: number;
  used: number;
  free: number;
  /** carrying more than capacity allows; Knave leaves the penalty up to the game master */
  overburdened: boolean;
}

/** Total slots this character can carry: CON defense (CON bonus + 10). */
export function slotCapacity(pc: PlayerCharacter): number {
  return pc.abilities.con + 10;
}

/** Slots currently taken up, summing each item's cost (default 1). */
export function slotsUsed(pc: PlayerCharacter): number {
  return pc.inventory.reduce((n, it) => n + (it.slots ?? 1), 0);
}

export function slotsFree(pc: PlayerCharacter): number {
  return slotCapacity(pc) - slotsUsed(pc);
}

export function isOverburdened(pc: PlayerCharacter): boolean {
  return slotsUsed(pc) > slotCapacity(pc);
}

/** Whether an item would fit in the remaining free slots. */
export function canCarry(pc: PlayerCharacter, item: IItem): boolean {
  return (item.slots ?? 1) <= slotsFree(pc);
}

/** Capacity / used / free / overburdened in one call, for display or checks. */
export function inventoryStatus(pc: PlayerCharacter): SlotReport {
  const capacity = slotCapacity(pc);
  const used = slotsUsed(pc);
  return { capacity, used, free: capacity - used, overburdened: used > capacity };
}

/**
 * Adds an item to the inventory and sets its `parentId` to the character.
 * Returns false and adds nothing if it wouldn't fit, unless `force` is set.
 * Forcing it can leave the character overburdened, which `isOverburdened`
 * reports.
 */
export function addItem(pc: PlayerCharacter, item: IItem, opts: { force?: boolean } = {}): boolean {
  if (!opts.force && !canCarry(pc, item)) return false;
  item.parentId = pc.id;
  pc.inventory.push(item);
  return true;
}

/** Remove an item by id; returns the removed item, or undefined if not held.
 *  Also clears any equipment slot that pointed at it. */
export function removeItem(pc: PlayerCharacter, itemId: string): IItem | undefined {
  const i = pc.inventory.findIndex((x) => x.id === itemId);
  if (i === -1) return undefined;
  for (const slot of EQUIP_SLOTS) if (pc.equipped[slot] === itemId) delete pc.equipped[slot];
  return pc.inventory.splice(i, 1)[0];
}

// ===========================================================================
// EQUIPMENT
// ===========================================================================

export const EQUIP_SLOTS: readonly EquipSlot[] = ["weapon", "armor", "helmet", "shield"];

export interface EquipCheck {
  ok: boolean;
  reason?: string;
}

/** The inventory item with this id, if the character is carrying it. */
export function heldItem(pc: PlayerCharacter, itemId: string | undefined): IItem | undefined {
  return itemId ? pc.inventory.find((i) => i.id === itemId) : undefined;
}

function isTwoHanded(item: IItem | undefined): boolean {
  return item !== undefined && isWeapon(item) && item.weapon.hands === 2;
}

/** Whether an item is the right kind of thing for a slot (ignores conflicts). */
function slotAcceptsItem(slot: EquipSlot, item: IItem): boolean {
  const armorType: ArmorType | undefined = isArmor(item) ? item.armor.armorType : undefined;
  switch (slot) {
    case "weapon": return isWeapon(item);
    case "armor": return armorType === "body";
    case "helmet": return armorType === "helmet";
    case "shield": return armorType === "shield";
  }
}

/** Whether `itemId` may be equipped to `slot`, and why not if it can't. */
export function canEquip(pc: PlayerCharacter, slot: EquipSlot, itemId: string): EquipCheck {
  const item = heldItem(pc, itemId);
  if (!item) return { ok: false, reason: "that item isn't in the character's inventory" };
  if (!slotAcceptsItem(slot, item)) {
    const need =
      slot === "weapon" ? "a weapon" :
      slot === "armor" ? "body armor" :
      slot === "helmet" ? "a helmet" : "a shield";
    return { ok: false, reason: `the ${slot} slot needs ${need}` };
  }
  // A shield and a two-handed weapon cannot be worn together.
  if (slot === "shield" && isTwoHanded(heldItem(pc, pc.equipped.weapon))) {
    return { ok: false, reason: "a shield can't be used alongside a two-handed weapon" };
  }
  if (slot === "weapon" && isTwoHanded(item) && pc.equipped.shield) {
    return { ok: false, reason: "a two-handed weapon can't be used while a shield is equipped" };
  }
  return { ok: true };
}

/** Equip an item to a slot after validation; returns the check result. */
export function equip(pc: PlayerCharacter, slot: EquipSlot, itemId: string): EquipCheck {
  const check = canEquip(pc, slot, itemId);
  if (check.ok) pc.equipped[slot] = itemId;
  return check;
}

// ---------------------------------------------------------------------------
// KNOCK-ON EFFECTS
// ---------------------------------------------------------------------------

/**
 * Which filled slots would have to be emptied for `itemId` to go into `slot`.
 *
 * Knave has only one such rule: a shield and a two-handed weapon would need
 * three hands. It works both ways: equipping a halberd puts the shield away,
 * and equipping a shield puts the halberd away.
 */
export function conflictingSlots(pc: PlayerCharacter, slot: EquipSlot, itemId: string): EquipSlot[] {
  const item = heldItem(pc, itemId);
  if (!item) return [];

  if (slot === "weapon" && isTwoHanded(item) && pc.equipped.shield) return ["shield"];
  if (slot === "shield" && isTwoHanded(heldItem(pc, pc.equipped.weapon))) return ["weapon"];
  return [];
}

export interface EquipOutcome extends EquipCheck {
  /** slots emptied to make the new arrangement possible */
  displaced: EquipSlot[];
}

/**
 * Equips an item, first unequipping anything it conflicts with.
 *
 * The diff applier calls this. A diff states the end result ("the halberd is
 * now in their hands"), and this function makes the rest true, so the game
 * master doesn't have to remember to put the shield away first, and a turn
 * isn't wasted on a refusal when it forgets.
 *
 * `canEquip` is still the strict check, for a UI asking "is this allowed right
 * now". Problems this function can't fix, such as an item that isn't carried
 * or the wrong kind of item for the slot, still fail here, and nothing is
 * changed.
 */
export function equipResolving(pc: PlayerCharacter, slot: EquipSlot, itemId: string): EquipOutcome {
  const displaced = conflictingSlots(pc, slot, itemId);
  const before = displaced.map((s) => [s, pc.equipped[s]] as const);
  for (const s of displaced) unequip(pc, s);

  const check = canEquip(pc, slot, itemId);
  if (!check.ok) {
    // Re-equip what was just put away, so a refusal changes nothing.
    for (const [s, id] of before) if (id !== undefined) pc.equipped[s] = id;
    return { ...check, displaced: [] };
  }

  pc.equipped[slot] = itemId;
  return { ok: true, displaced };
}

/** Clear an equipment slot. */
export function unequip(pc: PlayerCharacter, slot: EquipSlot): void {
  delete pc.equipped[slot];
}

/** Re-check every filled slot; returns a list of problems (empty = all valid). */
export function validateEquipment(pc: PlayerCharacter): string[] {
  const issues: string[] = [];
  for (const slot of EQUIP_SLOTS) {
    const id = pc.equipped[slot];
    if (id === undefined) continue;
    const check = canEquip(pc, slot, id);
    if (!check.ok) issues.push(`${slot}: ${check.reason}`);
  }
  return issues;
}

// ===========================================================================
// ATTACK  (Knave: melee uses STR, ranged uses WIS)
// ===========================================================================

/** The bonus applied to a melee attack roll. */
export function meleeAttackBonus(pc: PlayerCharacter): number {
  return pc.abilities.str;
}

/** The bonus applied to a ranged attack roll. */
export function rangedAttackBonus(pc: PlayerCharacter): number {
  return pc.abilities.wis;
}

/**
 * The character's armour defense, which an attacker must beat to hit them.
 * It is the body armour's `armor.defense` (11 with no body armour), plus 1 for
 * a helmet and 1 for a shield. The creature version is `armorDefense` in
 * `src/shared/world/entities.ts`.
 */
export function armorDefense(pc: PlayerCharacter): number {
  const worn = heldItem(pc, pc.equipped.armor);
  const base = worn && isArmor(worn) ? worn.armor.defense : 11;
  const helmet = heldItem(pc, pc.equipped.helmet) ? 1 : 0;
  const shield = heldItem(pc, pc.equipped.shield) ? 1 : 0;
  return base + helmet + shield;
}

// ===========================================================================
// DISPLAY
// ===========================================================================

/** A short one-line description of an item, for the character sheet in a prompt. */
export function itemSummary(it: IItem): string {
  const bits: string[] = [it.name || "unnamed item"];
  if (it.amount) bits.push(`(${it.amount})`);
  if (isWeapon(it)) {
    const w = it.weapon;
    bits.push(`[${w.ranged ? "ranged " : ""}${w.damage}${w.hands === 2 ? ", 2h" : ""}]`);
  }
  if (isArmor(it)) bits.push(`[armor def ${it.armor.defense}]`);
  if (isBook(it)) {
    const subject = it.book.subject || "no stated subject";
    bits.push(it.book.exhausted ? `[${subject}, read out]` : `[${subject}]`);
  }
  const q = it.currentQuality ?? it.quality;
  if (q !== undefined) bits.push(`q${q}`);
  const s = it.slots ?? 1;
  if (s !== 1) bits.push(`${s} slots`);
  return bits.join(" ");
}
