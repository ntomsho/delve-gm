/**
 * ENTITY LAYER
 * ============
 *
 * Every concrete thing in a running dungeon. Sits on top of Phase A (structure)
 * and the blueprint seed (rolled content).
 *
 * Three prose fields, three different lifetimes:
 *
 *   base      Prose identity. Synthesised ONCE by the LLM from a template's
 *             procgen keywords. Shared by every entity built on that template,
 *             so twelve skeletons cannot drift apart. Never changes after it is
 *             set -- if a thing changes enough that its base would change, it
 *             should become a new entity instead.
 *   state     What is going on with it right now in the fiction. Written when
 *             the player first encounters the entity, rewritten whenever the
 *             fiction moves. `state === undefined` means NOT YET ENCOUNTERED.
 *   composed  Player-facing prose, rendered from base + state. A cache, never
 *             a source of truth: nothing should read `composed` to make a
 *             decision. Regenerate whenever base or state changes.
 */

import type { MonsterSeed, NpcSeed } from "./dungeon-blueprint";

// ---------------------------------------------------------------------------
// BASE
// ---------------------------------------------------------------------------

export type EntityType =
  | "Room"
  | "RoomConnector"
  | "Creature"
  | "RoomFeature"
  | "Item"
  | "MobileEffect"
  | "Hazard";

export interface IEntity {
  id: string;
  name: string;
  type: EntityType;
  /**
   * Prose identity. Stored inline ONLY for entities with no template;
   * templated entities (creatures, hazards) resolve it through their
   * blueprint id. Use resolveBase() rather than reading this directly.
   */
  readonly base?: string;
  /** Undefined = the player has not encountered this yet. */
  state?: string;
  /** Derived cache of base + state. Display only. */
  composed?: string;
  /**
   * The procgen rolls behind this entity's base, keyed by the table each was
   * rolled from (e.g. { "Trait": "Fungal", "Feature": "Claws" }). Written by
   * the content pass and carried as context into any later pass that revisits
   * the entity.
   */
  keywords?: Record<string, string>;
  children?: IEntity[];
}

/** An entity whose base prose lives on a shared dungeon-level template. */
export interface ITemplated {
  blueprintId: string;
}

// ---------------------------------------------------------------------------
// TEMPLATES  (dungeon level; one base, many instances)
// ---------------------------------------------------------------------------

/**
 * Neither Knave nor Maze Rats supplies trap tables, so these keywords are our
 * own procgen vocabulary rather than a lift from either book.
 */
export interface HazardSeed {
  id: string;
  /** procgen keyword: what it does */
  effect: string;
  /** procgen keyword: what sets it off */
  trigger: string;
  /** LLM-synthesised from the keywords above; shared by every instance */
  base?: string;
}

/** A one-off creature template: not part of the rolled population. */
export interface CreatureTemplate {
  id: string;
  seed: MonsterSeed | NpcSeed;
  base?: string;
}

/**
 * Templates that are NOT the rolled inhabitant population -- one-offs created
 * during room generation or mid-game. The rolled population stays in
 * DungeonBlueprintSeed.inhabitants and is addressed by group id.
 */
export interface TemplateRegistry {
  creatures: Record<string, CreatureTemplate>;
  hazards: Record<string, HazardSeed>;
}

// ---------------------------------------------------------------------------
// CREATURE
// ---------------------------------------------------------------------------

export type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";

/**
 * Knave defaults every one of a monster's six ability bonuses AND its attack
 * bonus to its Hit Dice. So only deviations are stored: {} is a perfectly
 * average creature for its HD. Effective value = hitDice + (modifiers[k] ?? 0).
 */
export type CreatureModifiers = Partial<Record<Ability | "attack", number>>;

export interface CreatureStats {
  /** the spine: fills abilities, attack, and max HP */
  hitDice: number;
  hp: number;
  modifiers: CreatureModifiers;
  /** default 11 (unarmored). Armor BONUS is derived: defense - 10. */
  armorDefense?: number;
  /** die expression for the natural attack; default "1d6" */
  damage?: string;
  /** 2d6 morale rating, 5-9; default 7 */
  morale?: number;
}

/**
 * Points at whichever rolled template this creature was instanced from.
 * `member` selects which part of a group: absent = the group's base monster
 * (all identical underlings share it), "elite" = biggerSpecimen, or an
 * NpcSeed id for a specific person.
 */
export interface CreatureNarrative {
  blueprintId: string;
  member?: string;
}

export interface ICreature extends IEntity {
  type: "Creature";
  /** creatures move themselves, but occupy exactly one room */
  roomId: string;
  stats: CreatureStats;
  narrative: CreatureNarrative;
  /**
   * How many bodies this one entity represents. A pack of one creature type is
   * a single entity with a count and one shared stat block, not N duplicates.
   * Undefined or 1 means a lone specimen (an elite, a named person, a Solo).
   */
  count?: number;
  /** One-line description of what the creature is doing when first encountered. */
  activity?: string;
  /**
   * Set when a creature belongs to an inhabitant group but does NOT share its
   * seed -- a Solo's young, thralls, or attendant creatures, which are rolled
   * separately. `narrative.blueprintId` points at their own template, so
   * without this the group tie would be lost.
   */
  affiliationGroupId?: string;
}

// ---------------------------------------------------------------------------
// HAZARD
// ---------------------------------------------------------------------------

/**
 * Saves use Knave's standard DC; the ability called for and any damage are
 * decided by the LLM in the moment, so neither is stored.
 */
export interface IHazard extends IEntity, ITemplated {
  type: "Hazard";
  /** the trigger has been set off */
  sprung?: boolean;
  /** currently producing its effect */
  active?: boolean;
}

// ---------------------------------------------------------------------------
// FIXED / CARRIED / SPANNING
// ---------------------------------------------------------------------------

export interface IRoomFeature extends IEntity {
  type: "RoomFeature";
  roomId: string;
  /** requires a search to find */
  hidden?: boolean;
  hazardId?: string;
}

export interface IItem extends IEntity {
  type: "Item";
  /** an IRoom, an ICreature, or an IRoomFeature (chests, etc.) */
  parentId: string;
  /** Knave inventory slots; default 1 */
  slots: number;
  /** starting / maximum quality */
  quality?: number;
  /** adjusted in play as the item degrades */
  currentQuality?: number;
  /** count or measurement WITH its unit, e.g. "300 feet", "6 doses" */
  amount?: string;
  weapon?: { damage: string; hands?: 1 | 2; ranged?: boolean };
  /** armor bonus is derived: defense - 10 */
  armor?: { defense: number };
}

/** Fires, gas, weather: self-mobile and may span several rooms at once. */
export interface IMobileEffect extends IEntity {
  type: "MobileEffect";
  roomIds: string[];
}

export interface IRoom extends IEntity {
  type: "Room";
  hazardId?: string;
}

export interface IRoomConnector extends IEntity {
  /** id of an IRoom */
  endpointA: string;
  /** id of an IRoom */
  endpointB: string;
  type: "RoomConnector";
  /**
   * What currently prevents passage -- locked, blocked, concealed, flooded,
   * too dangerous. Absent means freely usable. DELETE the field once the
   * player resolves the condition.
   */
  conditional?: string;
  hazardId?: string;
}

export type AnyEntity =
  | IRoom
  | IRoomConnector
  | ICreature
  | IRoomFeature
  | IItem
  | IMobileEffect
  | IHazard;

// ---------------------------------------------------------------------------
// DERIVATION
// ---------------------------------------------------------------------------
// Everything Knave fixes by formula is computed on read, never stored, so
// saved state cannot go internally inconsistent.

/** Effective ability bonus: HD plus any stored deviation. */
export function abilityBonus(s: CreatureStats, a: Ability): number {
  return s.hitDice + (s.modifiers[a] ?? 0);
}

/** Knave: a defense is always its bonus + 10. */
export function abilityDefense(s: CreatureStats, a: Ability): number {
  return abilityBonus(s, a) + 10;
}

export function attackBonus(s: CreatureStats): number {
  return s.hitDice + (s.modifiers.attack ?? 0);
}

export function maxHp(s: CreatureStats): number {
  return s.hitDice * 4;
}

export function armorDefense(s: CreatureStats): number {
  return s.armorDefense ?? 11;
}

export function armorBonus(s: CreatureStats): number {
  return armorDefense(s) - 10;
}

export function damageDie(s: CreatureStats): string {
  return s.damage ?? "1d6";
}

export function morale(s: CreatureStats): number {
  return s.morale ?? 7;
}

/** Knave: carrying capacity is CON bonus + 10 slots. */
export function itemSlots(s: CreatureStats): number {
  return abilityBonus(s, "con") + 10;
}

export function hasBeenEncountered(e: IEntity): boolean {
  return e.state !== undefined;
}

/**
 * `composed` is a cache. Anything that mutates state must mark it stale so the
 * render pass knows to regenerate; nothing should read `composed` to decide.
 */
export function setState(e: IEntity, state: string): void {
  e.state = state;
  e.composed = undefined;
}
