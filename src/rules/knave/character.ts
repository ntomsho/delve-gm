/**
 * character.ts
 * ====================
 *
 * The player character. Made during character creation, before play; the
 * runtime reads it into the context of every generation so the model always
 * knows who is standing in the room, what they can perceive, and what they can
 * reach or carry. Mutation in play (damage, inventory changes, quality loss,
 * conditions) happens through the helpers here.
 *
 * Knave-native: six abilities stored as BONUSES (a defense is always bonus + 10),
 * HP, level (which caps ability bonuses), the eleven Knave background traits, an
 * inventory of real Item entities, and a free-text condition list.
 *
 * CARRYING CAPACITY is Knave's: slots = CON defense = CON bonus + 10. Each item
 * costs its own `slots` (default 1); the total may not exceed capacity. See the
 * slot helpers below.
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
 * The eleven Knave character-creation traits, each the rolled value as prose.
 * Stored in full; presentation trims as needed. All present -- creation rolls
 * every one.
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
 * What the character currently has in hand and worn. Each slot holds the id of
 * an item in `inventory` (you can only equip what you carry). Validation lives in
 * the equip helpers below — a slot only accepts the right kind of item, and a
 * shield and a two-handed weapon cannot be equipped at once.
 */
export interface EquippedSlots {
  weapon?: string;
  armor?: string;
  helmet?: string;
  shield?: string;
}

export type EquipSlot = keyof EquippedSlots;

/**
 * Which set of creation rules made this character -- dice, swaps, points and
 * rerolls. See `character-creation.ts` for the table. Declared here rather than
 * there because `PlayerCharacter` carries it and that module already imports
 * this one; the other direction would be a cycle.
 *
 * Optional: the test character and anything made before Phase 5 has no mode,
 * and a missing one means nothing more interesting than "we do not know".
 */
export type CreationMode = "normal" | "hardcore";

export interface PlayerCharacter {
  /** entity id -- inventory items point their parentId here */
  id: string;
  name: string;
  /** Knave: level sets the ceiling on ability bonuses. */
  level: number;
  /**
   * Experience earned across every run this character has survived, in Knave's
   * own units -- `XP_PER_LEVEL` is a level's worth.
   *
   * IT DOES NOT LEVEL THEM UP. Levelling is its own session and its own set of
   * decisions (what a level costs, what it gives, whether the track at 1000 is
   * the right track for a dungeon that pays out ~3000), and none of them are
   * settled by adding a counter. This accumulates and is shown; `level` is still
   * only moved by whatever lands next.
   *
   * ONLY A SURVIVOR EARNS IT. `carriedOut` is the one thing that writes this,
   * and it is called on exactly the two endings that walk out of the dungeon.
   *
   * Optional: every character made before the tally existed has none, and zero
   * and "never scored a run" are the same thing for every purpose there is.
   */
  xp?: number;
  /** How they were rolled up. Identity, and never writable at runtime. */
  mode?: CreationMode;
  hp: { current: number; max: number };
  /** the six Knave abilities as BONUSES; the defense of each is bonus + 10 */
  abilities: CharacterAbilities;
  /** the eleven Knave traits */
  traits: CharacterTraits;
  /**
   * Carried gear as full Item entities -- we need quality, weapon/armor, amount,
   * etc., not just labels. Standard starting equipment will likely get a lighter
   * treatment later so it is not verbose; that is a future change. Each item's
   * parentId should be this character's id (addItem keeps that true).
   */
  inventory: IItem[];
  /** what is wielded and worn -- ids into `inventory`; see the equip helpers */
  equipped: EquippedSlots;
  /**
   * Descriptive status effects the model interprets freely -- "hungry",
   * "poisoned", "blessed", "leg wound". No hard rules; the model reads them as
   * fiction and applies them at its discretion.
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
  /** carrying more than capacity -- Knave leaves the consequence to the table */
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
 * Add an item to the character's inventory, binding its parentId to the
 * character. Refuses (returns false) if it would exceed capacity, unless
 * `force` is set -- forcing leaves the character overburdened, which callers can
 * detect via isOverburdened().
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
 * Which filled slots CANNOT stay filled if `itemId` goes into `slot`.
 *
 * Only one rule in Knave: a shield and a two-handed weapon need three hands
 * between them. It is symmetric — taking up the halberd puts the shield away,
 * and taking up the shield puts the halberd away — because both are the same
 * physical fact stated from opposite ends.
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
 * Equip, clearing whatever the new arrangement contradicts.
 *
 * This is what the diff applier calls. A diff states the destination — "the
 * halberd is now in their hands" — and it is this function's job to work out
 * everything that has to be true for that, rather than the game master's job to
 * remember to put the shield away first and lose a round trip when it forgets.
 *
 * `canEquip` stays strict and is still the right question for a UI asking
 * "is this legal right now"; the failures it reports that this cannot resolve
 * — an item not carried, the wrong kind of thing for the slot — remain
 * failures here.
 */
export function equipResolving(pc: PlayerCharacter, slot: EquipSlot, itemId: string): EquipOutcome {
  const displaced = conflictingSlots(pc, slot, itemId);
  const before = displaced.map((s) => [s, pc.equipped[s]] as const);
  for (const s of displaced) unequip(pc, s);

  const check = canEquip(pc, slot, itemId);
  if (!check.ok) {
    // Put back what we moved: a refusal must change nothing.
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
 * The character's armor defense — the number a foe must meet to hit them.
 * Starts from the item in the **armor** slot (its `armor.defense`), or 11 when
 * the slot is empty, then +1 for an equipped helmet and +1 for an equipped
 * shield. Parallels the creature-side `armorDefense(stats)` in dungeon-entities.
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

/** A one-line label for an item, terse enough for the PC block in a prompt. */
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
