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
 *   composed  Player-facing prose, rendered from base + state, and the only one
 *             of the three the player has actually READ. Regenerate whenever
 *             base or state changes.
 *
 * ON `composed` AS A SOURCE OF TRUTH. It was originally specified as a pure
 * cache that nothing should ever read to make a decision, and mechanically it
 * still is one: it is derived, it goes stale, and it is rewritten from the
 * other two. But the referee is not a render pass, and the rule had a
 * consequence nobody wanted — a description that mentioned a climbable ledge,
 * a state that did not, and a player told on one turn that the ledge was there
 * and on the next that it never existed.
 *
 * So at runtime the precedence is the other way round: what the player has been
 * told BINDS. If `composed` and `state` disagree about something the player is
 * acting on, `composed` is right and `state` is behind, and the referee's job
 * is to catch the record up rather than to argue. Going back on what the player
 * was told is the one failure a run does not recover from.
 *
 * Nothing in this file enforces that — it is a rule about judgement and it
 * lives in the referee's playbook. It is written here because this is where
 * anyone reading the lifetimes will look for it.
 */

import type { MonsterSeed, NpcSeed } from "./dungeon-blueprint.ts";
// Type-only, so there is no runtime edge from the entity model to the fixture
// vocabulary — the same arrangement `dungeon-room-size.ts` has with the rooms
// loop. The menu owns the words; this file owns what an entity stores.
import type { Placement } from "./dungeon-fixtures.ts";

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

/**
 * Which equipment slot a piece of armor belongs in. `body` — not `armor` — so
 * the KIND of thing and the SLOT it goes in never share a word: the slot is
 * called `armor` and holds a `body` piece, plus a helmet and a shield at +1 each.
 */
export type ArmorType = "body" | "helmet" | "shield";

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
   * `state` has moved since `composed` was written, so the description is out
   * of date and must be regenerated the next time the player encounters this.
   *
   * This is deliberately NOT "clear `composed`". State changes on things the
   * player is nowhere near — a creature that flees two rooms away and bleeds
   * out there — and there is no reason to spend a call describing a room nobody
   * is standing in, nor to throw away a perfectly good description in the
   * meantime. It also keeps `composed === undefined` meaning exactly one thing:
   * never encountered, which is what fog of war reads.
   */
  needUpdate?: boolean;
  /**
   * The player is not aware of this yet: a false-backed drawer, a thing waiting
   * in the dark. Absent or false means visible.
   *
   * Hiding something clears `needUpdate` and revealing it sets it, because
   * `composed` is prose for the player and a concealed thing owes them none.
   * See `setIsHidden`.
   *
   * DECIDED AT FIRST COMPOSITION, not at generation. When an entity is composed
   * for the first time — `composed === undefined` — the referee reads the
   * fiction and asks whether someone standing in the room would notice it. That
   * is a judgement about what has just been written, not something a procgen
   * roll can make, so it is made where the prose is.
   *
   * Set back to false when the player finds it. Hidden things are still
   * described and still exist; `isHidden` governs whether the player is shown
   * them, and nothing else.
   *
   * Always false for a Room. A room the player is standing in is not concealed
   * from them, and the map reads `composed !== undefined` as "has been here" —
   * which only holds if rooms are never hidden.
   */
  isHidden?: boolean;
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
 * The shared identity of a whole rolled group -- what these things ARE anywhere
 * in the dungeon, not what any one of them is doing in any one room. Every
 * creature instanced from the group resolves its base through here, which is
 * what stops twelve skeletons drifting apart.
 *
 * Inhabitant groups are written by the Dungeon Pass, before any room exists:
 * who lives here is part of the dungeon's fiction, not a per-room detail.
 * Wanderer groups are rolled during stocking as filler and are written by the
 * content pass, in the single chunk each of them appears in.
 */
export interface GroupTemplate {
  /** the InhabitantGroup id: `<dungeonId>:g<i>` */
  id: string;
  name?: string;
  base?: string;
}

/**
 * Every shared prose identity in the dungeon, keyed by the `blueprintId` the
 * entities point at.
 *
 * `creatures` and `hazards` are one-offs minted during generation or mid-game.
 * `groups` is the rolled population -- addressed by InhabitantGroup id, and the
 * reason a group's base cannot go missing: the registry is part of
 * EntityPassResult and is persisted with it, so nothing has to remember to
 * carry a loose map around.
 */
export interface TemplateRegistry {
  creatures: Record<string, CreatureTemplate>;
  hazards: Record<string, HazardSeed>;
  groups: Record<string, GroupTemplate>;
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
  hazardId?: string;
  /**
   * Where in the drawn room it stands, when the room was drawn at all.
   *
   * Absent on a dungeon with no block plan, and absent on anything the content
   * pass declined to place — both of which are ordinary. The map draws what it
   * has; nothing depends on this being present.
   *
   * Written once, at generation. Not on the applier's writable-path allowlist:
   * a brazier that gets knocked over changes its `state`, not its footprint.
   */
  place?: Placement;
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
  /**
   * Armor bonus is derived: defense - 10. Only `body` pieces carry a meaningful
   * defense (Gambeson 12 through Full Plate 16); a helmet and a shield each
   * contribute a flat +1, so they store `defense: 1` and nothing reads it as a
   * total. Unarmored is 11.
   */
  armor?: { armorType: ArmorType; defense: number };
  spellBook?: { spellName: string; spellDescription: string; exhausted: boolean; };
  /**
   * Where it lies, for an item whose `parentId` is a ROOM.
   *
   * Meaningless once it is in a chest or a pack — then the thing holding it is
   * what has a position — so it is written only for items loose on the floor and
   * ignored by the map for any item whose parent is not a room. It is left in
   * place rather than cleared on pickup, because a stale footprint on an item in
   * a backpack costs nothing and clearing it is one more thing to get wrong.
   */
  place?: Placement;
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
  /** id of an IRoom. Always a real room — the surface is never this end. */
  endpointA: string;
  /**
   * id of an IRoom, or NULL for a way out of the dungeon entirely.
   *
   * A null end is the surface: daylight, the street, the hillside the party
   * climbed down from. It is not a room and never will be one, which is why it
   * is absent rather than pointing at a placeholder — a placeholder would be
   * something the map draws, the router walks into, and the referee describes.
   *
   * Every dungeon has at least one, on the entrance room. Stepping through it
   * ends the run: see `Stage` / `departed`.
   */
  endpointB: string | null;
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

// ---------------------------------------------------------------------------
// WAYS THROUGH
// ---------------------------------------------------------------------------

/**
 * A way out of the dungeon rather than a way between two of its rooms.
 *
 * Everything that walks the graph has to ask this first. A surface exit joins
 * one room to nothing, so a router that treats it as an edge walks into null,
 * and a map that draws it has nowhere to draw it to.
 */
export function isSurfaceExit(c: IRoomConnector): boolean {
  return c.endpointB === null;
}

/** True when this connector is a way out of `roomId`. */
export function touches(c: IRoomConnector, roomId: string): boolean {
  return c.endpointA === roomId || c.endpointB === roomId;
}

/**
 * The far side of a connector, seen from `roomId`. Null means the surface.
 *
 * Callers that cannot cope with the surface must check `isSurfaceExit` rather
 * than testing the result, because `null` here is a real answer — "outside" —
 * and not a failure to resolve.
 */
export function farSide(c: IRoomConnector, roomId: string): string | null {
  return c.endpointA === roomId ? c.endpointB : c.endpointA;
}

// ---------------------------------------------------------------------------
// BASE RESOLUTION
// ---------------------------------------------------------------------------

/**
 * An entity's standing prose identity, wherever it happens to live.
 *
 * Three storage sites, because three kinds of thing share identity differently:
 *
 *   inline `base`          a one-off -- a room, a connector, a named person who
 *                          is nobody but themselves
 *   registry.groups[id]    one of a rolled population; every instance shares it
 *   registry.creatures[id] a one-off creature template -- an elite, a loose
 *   registry.hazards[id]   seed, the goal creature; a hazard's shared effect
 *
 * Inline wins, so a named member of a people group keeps their own identity
 * rather than the group's. Returns undefined only when generation left the
 * entity unwritten, which `validateWritten` treats as a hard failure.
 */
export function resolveBase(e: IEntity, reg: TemplateRegistry): string | undefined {
  if (e.base !== undefined) return e.base;

  const blueprintId = (e as Partial<ICreature>).narrative?.blueprintId
    ?? (e as Partial<ITemplated>).blueprintId;
  if (blueprintId === undefined) return undefined;

  if (e.type === "Hazard") return reg.hazards[blueprintId]?.base;
  return reg.groups[blueprintId]?.base ?? reg.creatures[blueprintId]?.base;
}

/**
 * A player-visible name, in the case a player-visible name is written in.
 *
 * Names are minted by a model in two places — the content pass when it writes
 * the dungeon, and the referee when it creates something mid-run — and both
 * produce whatever register the surrounding sentence was in. One R2 dungeon
 * held "The Residue", "The Cutlass", "The ledger" and "unmarked ledger" at the
 * same time. A name is a label, and a label is capitalised.
 *
 * FIRST LETTER ONLY, and the rest is left exactly as written. "an iron door"
 * becomes "An iron door" and not "An Iron Door": title case would have to know
 * which words are part of a proper name, and it is wrong more often than the
 * lower-case first letter it set out to fix. Normalised where names are MINTED
 * rather than where they are drawn, because `definite()` in `verbs.ts` rewrites
 * a name into the middle of a sentence and a display-side fix would have to
 * fight it.
 */
export function properName(name: string): string {
  const s = name.trim();
  return s === "" ? s : s[0].toUpperCase() + s.slice(1);
}

/** The display name for a creature that takes its identity from a group. */
export function resolveName(e: IEntity, reg: TemplateRegistry): string {
  if (e.name) return e.name;
  const blueprintId = (e as Partial<ICreature>).narrative?.blueprintId;
  return (blueprintId ? reg.groups[blueprintId]?.name : undefined) ?? "";
}

/**
 * `composed` is derived, so anything that mutates state must mark it stale and
 * let the render pass regenerate it. (That it is derived does not make it
 * ignorable — see the note on the three lifetimes at the top of this file:
 * what the player has been told outranks a state that has fallen behind.)
 *
 * The old description is left in place until it is actually rewritten — see the
 * note on `needUpdate`.
 */
export function setState(e: IEntity, state: string): void {
  e.state = state;
  e.needUpdate = true;
}

/** The description has been rewritten from the current base + state. */
export function setComposed(e: IEntity, composed: string): void {
  e.composed = composed;
  e.needUpdate = false;
}

/**
 * Conceal or reveal, settling what that means for the description.
 *
 * `composed` is prose for the player. A concealed thing owes them none, so
 * hiding something settles its description debt; revealing it opens one, and
 * the next composition pass picks it up. That is why a hidden thing can sit
 * with `state` written and `composed` empty without looking perpetually stale.
 */
export function setIsHidden(e: IEntity, hidden: boolean): void {
  e.isHidden = hidden;
  e.needUpdate = !hidden;
}

/**
 * Whether this owes the player fresh prose.
 *
 * `undefined` means never described, and so yes. `false` is a settled state,
 * reached either by writing a description or by concealing the thing. `true`
 * means the description is out of date.
 */
export function needsComposition(e: IEntity): boolean {
  return e.needUpdate !== false;
}
