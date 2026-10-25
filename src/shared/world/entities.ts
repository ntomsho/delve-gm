/**
 * ENTITY LAYER
 * ============
 *
 * Every concrete thing in a running dungeon. Sits on top of the room graph
 * (structure) and the blueprint seed (rolled content).
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
 * other two. But the game master is not a render pass, and the rule had a
 * consequence nobody wanted — a description that mentioned a climbable ledge,
 * a state that did not, and a player told on one turn that the ledge was there
 * and on the next that it never existed.
 *
 * So at runtime the precedence is the other way round: what the player has been
 * told BINDS. If `composed` and `state` disagree about something the player is
 * acting on, `composed` is right and `state` is behind, and the game master's job
 * is to catch the record up rather than to argue. Going back on what the player
 * was told is the one failure a run does not recover from.
 *
 * Nothing in this file enforces that — it is a rule about judgement and it
 * lives in the game master's playbook. It is written here because this is where
 * anyone reading the lifetimes will look for it.
 */

import type { MonsterSeed, NpcSeed } from "./seeds.ts";
// Type-only, so there is no runtime edge from the entity model to the fixture
// vocabulary — the same arrangement `room-size.ts` has with the rooms
// loop. The menu owns the words; this file owns what an entity stores.
import type { Placement } from "./placement.ts";

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
   * for the first time — `composed === undefined` — the game master reads the
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
  /**
   * The spine: fills abilities, attack, and max HP.
   *
   * **0 IS A REAL BAND, not a floor that got hit.** A level 0 creature — the
   * rat, the starved cultist, the thing a level 1 character is meant to be able
   * to kill — is every bonus at +0, every defense at 10, and half a hit die.
   * Every formula below falls out of `hitDice === 0` on its own except the two
   * that cannot: HP, which would be 0, and armour defense, which would be the
   * unarmoured 11.
   */
  hitDice: number;
  hp: number;
  modifiers: CreatureModifiers;
  /** default 11 (unarmored), or 10 at HD 0. Armor BONUS is derived: defense - 10. */
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
   * A room it is making for, one room per turn. Absent means it is where it
   * means to be.
   *
   * "It hears the fight and comes" is one instruction and three rooms of
   * walking, and the walking is a graph question the game master has no business
   * guessing at — the same argument `routeTo` makes for the player. The game master
   * writes the destination; the applier moves it and clears this on arrival.
   */
  approach?: string;
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
  /**
   * This feature is the room's rolled OBSTACLE — the puzzle standing in the way.
   *
   * Signposted on the entity because it has to survive into play. Otherwise the
   * only thing that knows a feature is a puzzle is the generation-time
   * `ElementBinding`, and bindings do not reach the runtime, so nothing at the
   * table could tell an obstacle from a bas-relief. An obstacle is a challenge
   * — see `content/challenges.ts` — and a challenge that cannot be recognised
   * cannot be resolved.
   *
   * Written once, at generation, like `place`. What changes in play is
   * `resolved`.
   */
  isObstacle?: boolean;
  /**
   * The obstacle has been solved or defeated. Either counts, and nothing else
   * does — the two are the same accomplishment seen from opposite ends.
   */
  resolved?: boolean;
}

/**
 * What KIND of thing an item is, where the kind carries facts of its own.
 *
 * Not the same axis as `EntityType`, which says an item is an item. This says
 * which of the four fact blocks below it carries, and it is the discriminant
 * the guards at the bottom of this section read. Absent means `gear`: a rope is
 * a rope, and nothing about it needs a field.
 */
export type ItemKind = "gear" | "weapon" | "armor" | "book" | "spellbook";

export interface WeaponFacts {
  damage: string;
  hands?: 1 | 2;
  ranged?: boolean;
}

/**
 * Armor bonus is derived: defense - 10. Only `body` pieces carry a meaningful
 * defense (Gambeson 12 through Full Plate 16); a helmet and a shield each
 * contribute a flat +1, so they store `defense: 1` and nothing reads it as a
 * total. Unarmored is 11.
 */
export interface ArmorFacts {
  armorType: ArmorType;
  defense: number;
}

/**
 * Maze Rats' books: a subject, and a well that runs dry as it is drawn on.
 *
 * `uses` COUNTS UP — it is how many times the book has been consulted, and it
 * starts at nothing. Each consultation adds one and rolls a d6; the reading
 * that comes up at or under the count is the last the book has in it. So the
 * first is safe five times in six and the sixth is certain, and how much is in
 * a given book is never decided in advance — it is found out by reading it.
 *
 * `exhausted` is that answer, once it has arrived. A LATCH: a book that has
 * given up everything is never un-given. It is not destroyed and not thrown
 * away — the pages are still there, they simply have nothing further to tell
 * anyone. See `consultRoll` in rolls.ts.
 */
export interface BookFacts {
  subject: string;
  /** consultations made so far. Starts at 0. */
  uses: number;
  exhausted?: boolean;
}

/** Knave: one spell, readable once a day. */
export interface SpellbookFacts {
  spellName: string;
  spellDescription: string;
  exhausted: boolean;
}

export interface IItem extends IEntity {
  type: "Item";
  /** an IRoom, an ICreature, or an IRoomFeature (chests, etc.) */
  parentId: string;
  /** Knave inventory slots; default 1 */
  slots: number;
  /**
   * What it is worth, in copper pennies. Zero for anything nobody would buy.
   *
   * The same number for a bought thing and a found one — the shop's price list
   * IS the value list (`STANDARD_EQUIPMENT` in equipment.ts), and treasure is
   * valued by `rollItemValue` from the seeded RNG rather than by whoever is
   * describing it. A model naming a price would be a model generating a number.
   */
  value: number;
  /** starting / maximum quality */
  quality?: number;
  /** adjusted in play as the item degrades */
  currentQuality?: number;
  /** count or measurement WITH its unit, e.g. "300 feet", "6 doses" */
  amount?: string;
  /** which of the four fact blocks it carries; absent means plain gear */
  itemKind?: ItemKind;
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

/**
 * THE FOUR KINDS THAT CARRY FACTS.
 *
 * Children rather than four more optional fields on `IItem`, so that a thing
 * claiming to be a weapon has a damage die by construction. `IItem` stays the
 * general case and the supertype — an inventory is an `IItem[]` and always was
 * — and the guards below are how anything gets at the facts. They check the
 * FIELD and not just the tag: a subtype is a promise about what is there, and a
 * tag on its own is only a promise about what was meant.
 *
 * A spellbook is not a book. Knave's spellbook holds one spell and is read once
 * a day; Maze Rats' book holds a subject and answers questions six times and
 * then never again. They share the word and nothing else, so neither extends
 * the other.
 */
export interface IWeapon extends IItem {
  itemKind: "weapon";
  weapon: WeaponFacts;
}

export interface IArmor extends IItem {
  itemKind: "armor";
  armor: ArmorFacts;
}

export interface IBook extends IItem {
  itemKind: "book";
  book: BookFacts;
}

export interface ISpellbook extends IItem {
  itemKind: "spellbook";
  spellBook: SpellbookFacts;
}

/** Every shape an item can have. Narrow to it with the guards below. */
export type AnyItem = IItem | IWeapon | IArmor | IBook | ISpellbook;

export function isWeapon(i: IItem): i is IWeapon {
  return i.itemKind === "weapon" && (i as IWeapon).weapon !== undefined;
}

export function isArmor(i: IItem): i is IArmor {
  return i.itemKind === "armor" && (i as IArmor).armor !== undefined;
}

export function isBook(i: IItem): i is IBook {
  return i.itemKind === "book" && (i as IBook).book !== undefined;
}

export function isSpellbook(i: IItem): i is ISpellbook {
  return i.itemKind === "spellbook" && (i as ISpellbook).spellBook !== undefined;
}

/**
 * What it is worth, in copper.
 *
 * Through a helper because `value` arrived after the first characters were
 * saved, and a sheet written before it is a sheet with no prices on it rather
 * than a sheet that should crash the panel adding them up.
 */
export function itemValue(i: IItem): number {
  return i.value ?? 0;
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
   * something the map draws, the router walks into, and the game master describes.
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

/**
 * HD x 4, and **half a hit die at HD 0** — 2, the same number `1d4` and `1d8/2`
 * both average to. Multiplying would give a creature with no hit points at all,
 * which is not a weak monster but an absent one.
 */
export function maxHp(s: CreatureStats): number {
  return s.hitDice === 0 ? HALF_HIT_DIE_HP : s.hitDice * 4;
}

/** Half a hit die, taken as the average the way full HD are taken as 4. */
export const HALF_HIT_DIE_HP = 2;

/**
 * Unarmoured is 11, and **10 at HD 0** — the +0 bonus band read through Knave's
 * "a defense is always its bonus + 10", the same as every ability defense a
 * level 0 creature has. A stored `armorDefense` still wins: a level 0 thing in
 * a breastplate is armoured like anything else.
 */
export function armorDefense(s: CreatureStats): number {
  return s.armorDefense ?? (s.hitDice === 0 ? 10 : 11);
}

export function damageDie(s: CreatureStats): string {
  return s.damage ?? "1d6";
}

export function morale(s: CreatureStats): number {
  return s.morale ?? 7;
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
 * An entity's base: the fixed prose that says what it is.
 *
 * The base is stored in one of four places, checked in this order:
 *
 *   1. `e.base`, on the entity itself. Used by things nothing else shares
 *      a description with: a room, a connector, a named person. It wins
 *      over the registry, so a named member of a group keeps their own
 *      description instead of the group's.
 *   2. `registry.hazards[id]`, for hazards. Holds the effect every instance
 *      of that hazard shares.
 *   3. `registry.groups[id]`, for a member of a rolled population. Every
 *      member shares the group's description.
 *   4. `registry.creatures[id]`, for a one-off creature template: an elite,
 *      a loose seed, the goal creature.
 *
 * `id` is the entity's blueprint id. Returns undefined only when generation
 * never wrote a base for the entity; `validateWritten` treats that as a
 * hard failure.
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
 * the dungeon, and the game master when it creates something mid-run — and both
 * produce whatever register the surrounding sentence was in. One playtest-R2 dungeon
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
 * `undefined` means never described. `false` is a settled state,
 * reached either by writing a description or by concealing the thing. `true`
 * means the description is out of date.
 */
export function needsComposition(e: IEntity): boolean {
  return e.needUpdate !== false;
}

/** Ties an emitted entity back to the stocked element it came from, so the
 *  Rooms Pass `elements` manifestations can be matched to entities by ref. */
export interface ElementBinding {
  entityId: string;
  roomId: string;
  /** matches the element ref the Rooms Pass payload used */
  element:
    | "entrance"
    | "hazard"
    | "obstacle"
    | "clue"
    | "reward"
    | "creature"
    | "connector"
    | "detail";
  /** the rolled keyword(s) behind it, for the writing pass */
  keywords: string[];
  /**
   * Reward bindings only: which `Reward` this entity came out of.
   *
   * One reward can emit several entities -- a general-gear row hands over two
   * to four things -- and several rewards can sit in one room, so the room is
   * not enough to find the reward an item belongs to. The keys pass reads
   * this to find the challenge a placed key answers.
   */
  rewardId?: string;
  /**
   * Creature bindings only: the `MobileEntity.id` this entity was emitted from.
   *
   * Stocking names creatures by mobile id -- a challenge does, and so does a
   * reward carried by one -- while entities get their own minted ids, and
   * nothing else carries the mapping between them.
   */
  mobileId?: string;
}

export interface DetailCandidate {
  roomId: string;
  /** the rolled detail, e.g. "Chains" */
  text: string;
}

export interface EntityPassResult {
  registry: TemplateRegistry;
  rooms: IRoom[];
  connectors: IRoomConnector[];
  creatures: ICreature[];
  features: IRoomFeature[];
  items: IItem[];
  hazards: IHazard[];
  effects: IMobileEffect[];
  bindings: ElementBinding[];
  /**
   * Room details always appear in the room's description. Some are also things
   * a player will poke at -- chains, a nest, a bas-relief -- and those want to
   * be their own entity so they can change independently. That is a reading of
   * the fiction, not something a keyword settles, so the writing pass decides
   * and calls promoteDetail() for the ones it wants.
   */
  detailCandidates: DetailCandidate[];
  /** the goal room; the writing pass must create one entity of its choosing here */
  pendingGoal: { roomId: string; reward: string; mission: string; instruction: string };
  /**
   * The entity the writing pass made of the objective, once it has run.
   *
   * ABSENT UNTIL THEN, and that is the whole reason it is here rather than
   * derived: `GoalDirective` deliberately does not pick an entity type, so
   * nothing before `applyContentPass` knows whether the objective is an item, a
   * creature, or a feature of the room -- and afterwards there is no way to tell
   * it from the other entities in that room. The keys pass needs it to mint the
   * objective's keyable properties, and the tally needs it to know what
   * "completed" was about.
   */
  goalEntityId?: string;
}
