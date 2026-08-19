/**
 * VIEW MODELS
 * ===========
 *
 * Everything the interface renders, derived here rather than in JSX. Components
 * that compute their own view state put logic somewhere it cannot be tested and
 * duplicate it the moment a second component needs the same answer.
 *
 * Framework-free on purpose: these are plain functions over state, so the turn
 * machine can use the same room view for prompt assembly that the screen uses
 * for display. One place where "what is in this room" is decided means the
 * player and the referee cannot end up looking at different rooms.
 */

import {
  abilityDefense as creatureAbilityDefense,
  armorDefense as bodyArmorDefense,
  attackBonus as creatureAttackBonus,
  damageDie,
  DEFAULT_MORALE,
  needsComposition as entityNeedsComposition,
  inventoryStatus,
  maxHp,
  meleeAttackBonus,
  pcArmorDefense,
  rangedAttackBonus,
  itemValue,
  resolveBase,
  type Ability,
  type AnyEntity,
  type EntityPassResult,
  type EntityType,
  type EquipSlot,
  type ICreature,
  type IItem,
  type IRoomConnector,
  type PlayerCharacter,
  type SlotReport,
  type TemplateRegistry,
} from "../engine/index.ts";
import { EQUIP_SLOTS, farSide, heldItem, isArmor, isBook, isSurfaceExit, itemSummary, touches } from "../engine/index.ts";
import { describeGeometry, exitPhrase, positionPhrase, siteRooms } from "../engine/index.ts";
import type { RoomGeometry } from "../engine/index.ts";
import { directContents, heldItems } from "../runtime/occupancy.ts";
import { roomDistances } from "../runtime/travel.ts";
import {
  pointLayout,
  type Layout,
  type LayoutConnector,
  type LayoutFixture,
  type LayoutRoom,
} from "../runtime/layout.ts";
import type { GeneratedDungeon } from "../runtime/generate.ts";
import type { RunState } from "./game.ts";

// ===========================================================================
// ENTITIES
// ===========================================================================

/**
 * A creature's numbers, for whoever has to set a difficulty.
 *
 * REFEREE ONLY, and that is why it is optional and gated rather than always
 * present: a defense on a panel is a defense the player has read, and the whole
 * of step 4 rests on the difficulty staying hidden. `roomView` fills it in only
 * when asked, prompt assembly asks, and nothing in `ui/` does.
 */
export interface CombatView {
  /** what an attack against it has to beat */
  armorDefense: number;
  /** what a save against this creature's own threat is set from */
  defenses: Record<Ability, number>;
  attackBonus: number;
  damage: string;
  morale: number;
}

export interface EntityView {
  id: string;
  name: string;
  kind: EntityType;
  /** what the player reads; absent means never encountered */
  composed?: string;
  /** what is true of it now */
  state?: string;
  /** its standing identity, resolved through the registry */
  base?: string;
  /** its description is out of date and wants rewriting on next encounter */
  needUpdate: boolean;
  /** the player is not aware of it yet */
  isHidden: boolean;
  /** creatures only */
  activity?: string;
  count?: number;
  hp?: { current: number; max: number };
  /** creatures only, and only when explicitly asked for — see CombatView */
  combat?: CombatView;
  /** items only */
  slots?: number;
  quality?: { current: number; original: number };
  /**
   * How much of it is left — "3 days", "50 feet", "a handful".
   *
   * Writable since the applier existed and rendered nowhere until Phase 15: the
   * referee could write how many rations were down to and neither it nor the
   * player could read it back. It surfaces here because a meal is the one thing
   * rest cannot happen without.
   */
  amount?: string;
  /** items only: what it is worth in copper. Absent when it is worth nothing. */
  value?: number;
  /**
   * books only: what it is about, how many readings it has had, and whether
   * there is anything left in it.
   *
   * Carried through to the referee rather than kept for the panel, because the
   * `consult` roll takes the current `uses` and the suggestion rule in step 3
   * turns on the subject. A book the referee cannot see the subject of is a
   * book nobody is ever told they are carrying.
   */
  book?: { subject: string; uses: number; exhausted: boolean };
  /**
   * Where in the room it stands, as one of the position words — "the north
   * wall", "the far end". Absent for anything that was never placed, which is
   * every creature and every dungeon generated without a drawing.
   *
   * This is the referee's half of the agreement the map keeps: the same word
   * the content pass chose, so "the altar at the far end" is something the
   * player can check against the dot.
   */
  position?: string;
  /** things this thing holds — a chest's contents, a body's gear */
  contains: EntityView[];
}

function toView(
  entity: AnyEntity,
  entities: EntityPassResult,
  registry: TemplateRegistry,
  stats = false
): EntityView {
  const view: EntityView = {
    id: entity.id,
    name: entity.name,
    kind: entity.type,
    composed: entity.composed,
    state: entity.state,
    base: resolveBase(entity, registry),
    needUpdate: entity.needUpdate === true,
    isHidden: entity.isHidden === true,
    // Only a feature or a loose item carries one; the field is absent on the
    // other five types and reads as undefined, which is the right answer.
    position: (entity as { place?: { position: string } }).place?.position,
    contains: heldItems(entity.id, entities).map((i) => toView(i, entities, registry, stats)),
  };

  if (entity.type === "Creature") {
    const c = entity as ICreature;
    view.activity = c.activity;
    view.count = c.count;
    view.hp = { current: c.stats.hp, max: maxHp(c.stats) };
    if (stats) {
      view.combat = {
        armorDefense: bodyArmorDefense(c.stats),
        defenses: Object.fromEntries(
          ABILITIES.map((a) => [a, creatureAbilityDefense(c.stats, a)])
        ) as Record<Ability, number>,
        attackBonus: creatureAttackBonus(c.stats),
        damage: damageDie(c.stats),
        morale: c.stats.morale ?? DEFAULT_MORALE,
      };
    }
  }
  if (entity.type === "Item") {
    const i = entity as IItem;
    view.slots = i.slots;
    if (i.amount !== undefined) view.amount = i.amount;
    if (i.quality !== undefined) {
      view.quality = { current: i.currentQuality ?? i.quality, original: i.quality };
    }
    if (itemValue(i) > 0) view.value = itemValue(i);
    if (isBook(i)) {
      view.book = { ...i.book, exhausted: i.book.exhausted === true };
    }
  }
  return view;
}

// ===========================================================================
// THE CURRENT ROOM
// ===========================================================================

export interface ExitView {
  connectorId: string;
  /** the room on the other side, or null for a way out of the dungeon */
  toRoomId: string | null;
  /**
   * Out of the dungeon entirely. Stepping through it ends the run, so it is
   * marked wherever it is shown rather than reading as one more door.
   */
  surface: boolean;
  /** its name — for `exitLabel`, which decides whether it may be shown */
  toRoomName: string;
  /**
   * The connector's own name, which says what it is and never where it goes.
   * Read `exitLabel` instead unless you specifically want the bare form.
   */
  name: string;
  /** what it physically is */
  form?: string;
  /** something stands in the way */
  blocked: boolean;
  /** what stands in the way, as it looks from this side */
  requirement?: string;
  /** the player has been through to the other side */
  toKnown: boolean;
  /** the way they walked in by — first in the list, and set apart from it */
  cameFrom: boolean;
  /**
   * The player has not found it yet.
   *
   * Only ever true under `includeHidden`, since without it a concealed way is
   * filtered out of this list entirely — so on anything the player looks at
   * this is false throughout, and it exists for the one reader that is shown
   * concealed things and must not describe them.
   */
  isHidden: boolean;
  /**
   * Which wall of THIS room it cuts, and where along it — "the east wall,
   * toward the north end". The same phrase the content pass was given when it
   * wrote the room, so the referee and the prose already on the page agree.
   */
  wall?: string;
}

export interface RoomView {
  id: string;
  name: string;
  /** the paragraph the player reads on arrival */
  composed?: string;
  state?: string;
  base?: string;
  needUpdate: boolean;
  /** everything in the room, each carrying what it holds */
  contents: EntityView[];
  exits: ExitView[];
  /** theme, history, who lives here, the goal — so nothing contradicts it */
  fiction: string;
  /**
   * The room as it was DRAWN — size, proportions, outline, ways out by wall.
   * Absent for a dungeon with no block plan.
   *
   * The same sentence `buildContentPassPayload` was given, from the same
   * function, on purpose. The prose on the page was written to it, so the
   * referee reading a different description of the same room is the one way
   * this could go wrong — and rendering it twice from one derivation is how
   * that is made impossible rather than merely unlikely.
   */
  geometry?: string;
}

export interface RoomViewOptions {
  /**
   * Include what the player is not aware of. FALSE for anything the player
   * sees — a concealed thing listed in the panel is a concealed thing no
   * longer. TRUE for prompt assembly, where the referee has to know what is
   * there to be found.
   *
   * Concealment is transitive: a coin in a false-backed drawer is not visible
   * because the drawer is not, even though nobody marked the coin.
   */
  includeHidden?: boolean;
  /**
   * Include each creature's defenses, attack bonus, damage die and morale.
   * TRUE for prompt assembly, where the referee sets difficulties off them.
   * FALSE — always — for anything the player sees. See CombatView.
   */
  includeStats?: boolean;
}

export function roomView(
  run: RunState,
  dungeon: GeneratedDungeon,
  roomId: string = run.currentRoomId,
  opts: RoomViewOptions = {}
): RoomView | undefined {
  const e = run.entities;
  const room = e.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;

  const registry = e.registry;
  const showAll = opts.includeHidden === true;
  const stats = opts.includeStats === true;
  const visible = (x: AnyEntity) => showAll || x.isHidden !== true;

  const contents = directContents(roomId, e)
    .filter(visible)
    .map((x) => toView(x, e, registry, stats))
    // A thing inside a concealed thing is concealed too, whoever marked it.
    .map((v) => (showAll ? v : { ...v, contains: v.contains.filter((c) => !c.isHidden) }));

  // The drawing, read back. Derived rather than persisted — see the note on
  // `RoomView.geometry` for why it comes from the same function the content
  // pass used rather than from a copy of what that function once said.
  const drawn = geometryOf(dungeon, roomId);

  // CONCEALED WAYS ARE NOT COUNTED IN THE SENTENCE. The geometry line says how
  // many ways out there are and which walls they are in, and it is read by the
  // referee and rendered beside prose the player will read. A secret door
  // included in that count is a secret door described. It comes back the moment
  // `isHidden` goes false, which is exactly when the player has found it.
  const concealed = new Set(
    e.connectors.filter((c) => touches(c, roomId) && c.isHidden === true).map((c) => c.id)
  );

  const exits: ExitView[] = e.connectors
    .filter((c) => touches(c, roomId))
    .filter(visible)
    .map((c: IRoomConnector) => {
      const toRoomId = farSide(c, roomId);
      const to = toRoomId === null ? undefined : e.rooms.find((r) => r.id === toRoomId);
      return {
        connectorId: c.id,
        toRoomId,
        surface: isSurfaceExit(c),
        toRoomName: to?.name ?? "",
        name: c.name,
        form: resolveBase(c, registry),
        blocked: c.conditional !== undefined,
        requirement: c.conditional,
        // The surface is somewhere they have certainly been — they walked in
        // through it — and it is the one destination that needs no describing.
        toKnown: isSurfaceExit(c) || to?.composed !== undefined,
        // Only in the room they are actually standing in. Asked about anywhere
        // else, the way they last came in by is a fact about a different room.
        cameFrom: roomId === run.currentRoomId && c.id === run.arrivedVia,
        // Only reachable with `includeHidden`, which is prompt assembly — where
        // the referee has to know a secret way is there without being free to
        // mention it. Rendered as the same NOT YET FOUND mark a concealed thing
        // standing in the room carries, because it means the same thing and
        // reading it twice two ways is how one of them gets missed.
        isHidden: c.isHidden === true,
        // The surface exit is on no graph edge, so the geometry knows it by its
        // missing far end rather than by an id — the same join `mapView` makes.
        wall: drawn?.walls.get(isSurfaceExit(c) ? null : c.id),
      };
    })
    .sort(byUsefulness);

  return {
    id: room.id,
    name: room.name,
    composed: room.composed,
    state: room.state,
    base: resolveBase(room, registry),
    needUpdate: room.needUpdate === true,
    contents,
    exits,
    fiction: dungeon.dungeonContext,
    geometry: drawn && describeGeometry(drawn.geometry, { omit: concealed }),
  };
}

// ===========================================================================
// EVERY OTHER CREATURE IN THE DUNGEON
// ===========================================================================

/**
 * One line of the census — a creature the player is not standing next to.
 *
 * REFEREE ONLY, like `CombatView` above and for a stronger reason: this is the
 * one thing the runtime hands over that the *character* does not have. Nothing
 * in `ui/` reads it.
 */
export interface CensusEntry {
  id: string;
  name: string;
  /** how many bodies; 1 for a lone specimen */
  count: number;
  roomId: string;
  roomName: string;
  /** rooms crossed to get there; absent when no way leads to it at all */
  roomsAway?: number;
  /** the player has stood in that room, so they could name it */
  roomVisited: boolean;
  /** hurt, without saying how badly — the numbers are `renderRoom`'s job */
  wounded: boolean;
  activity?: string;
}

/**
 * ALL OF THEM, EVERY CALL.
 *
 * The whole design turns on how many there are, so it was measured before it
 * was designed: the largest dump in the repo — 18 rooms — holds 12 creature
 * entities across 6 rooms, and a full census one line each is about 625 tokens
 * against ~11,500 for a resolution turn. There is no version of this worth
 * being clever about, so there is no filtering, no radius and no budget.
 *
 * WHAT IS NOT IN IT is the room the player is standing in. `roomView` already
 * carries those creatures with `base`, `state`, `composed`, `activity`,
 * defenses and hit points; a census line for them would be a second, poorer
 * copy, and two renderings of one creature is an invitation for the two to
 * disagree.
 *
 * A GROUP OF NONE IS GONE. `count: 0` is a wiped-out group the applier has not
 * removed, and listing it invites the referee to send a dead pack somewhere.
 *
 * Distances come from `roomDistances`, which walks the graph WITHOUT the
 * visited-only rule `shortestPath` applies to the player — a creature knows its
 * own home. One BFS answers for every line.
 */
export function censusView(run: RunState): CensusEntry[] {
  const e = run.entities;
  const away = roomDistances(run, run.currentRoomId);

  return e.creatures
    .filter((c) => c.roomId !== run.currentRoomId)
    .filter((c) => c.count === undefined || c.count > 0)
    .map((c): CensusEntry => {
      const room = e.rooms.find((r) => r.id === c.roomId);
      const distance = away.get(c.roomId);
      return {
        id: c.id,
        name: c.name,
        count: c.count ?? 1,
        roomId: c.roomId,
        roomName: room?.name ?? "(nowhere)",
        ...(distance !== undefined ? { roomsAway: distance } : {}),
        // The same test the map uses for "the player has been here" — a room's
        // `composed` is written the first time they walk in and never before.
        roomVisited: room?.composed !== undefined,
        wounded: c.stats.hp < maxHp(c.stats),
        ...(c.activity !== undefined ? { activity: c.activity } : {}),
      };
    });
}

/**
 * One room's drawing, as the sentence and the per-connector walls.
 *
 * MEMOISED ON THE DUNGEON, because `roomView` runs on every render and on every
 * prompt assembly while `siteRooms` covers all thirty rooms. It is pure and the
 * inputs are write-once — `blockplan` and `graph` are set at generation and
 * never written again — so a WeakMap keyed on the dungeon is a cache that
 * cannot go stale and cannot leak.
 */
/**
 * The GEOMETRY is memoised, not the sentence it renders to.
 *
 * The drawing is write-once and the walls with it, but which ways out are
 * concealed is run state — a secret door found on turn nine has to start being
 * counted — so the sentence is rendered per call against the concealed set of
 * the moment. `describeGeometry` is a map over four or five exits; the siting
 * pass it is memoising is the expensive half.
 */
const SITED = new WeakMap<GeneratedDungeon, Map<string, SitedRoom>>();

interface SitedRoom {
  geometry: RoomGeometry;
  walls: Map<string | null, string>;
}

function geometryOf(dungeon: GeneratedDungeon, roomId: string): SitedRoom | undefined {
  if (!dungeon.blockplan) return undefined;
  let byRoom = SITED.get(dungeon);
  if (!byRoom) {
    byRoom = new Map();
    const corridors = new Set(
      dungeon.stocked.rooms.filter((r) => r.isCorridor).map((r) => r.index)
    );
    const site = siteRooms(dungeon.blockplan, dungeon.graph, {
      isCorridor: (i) => corridors.has(i),
    });
    for (const [i, g] of site.geometry.entries()) {
      byRoom.set(dungeon.graph.rooms[i].entityId, {
        geometry: g,
        walls: new Map(g.exits.map((x) => [x.connectorId, exitPhrase(x)])),
      });
    }
    SITED.set(dungeon, byRoom);
  }
  return byRoom.get(roomId);
}

/**
 * THE ORDER THE WAYS OUT ARE READ IN.
 *
 * Three bands, and the reasoning is the same in each: put what the player is
 * most likely to be looking for where they will find it without reading.
 *
 *   1. the way they came in     — where they are, and the way back
 *   2. ways to rooms they know  — the ones they can plan a route through
 *   3. everything unexplored    — the decisions, at the bottom
 *
 * Stable within a band: `sort` on an array built in world order leaves ties in
 * world order, so a room's exits do not shuffle between turns. Used by the panel
 * AND by `renderRoom`, because the referee offering a way out in a different
 * order than the player is reading them is how "the second door" stops meaning
 * anything.
 */
function byUsefulness(a: ExitView, b: ExitView): number {
  const band = (e: ExitView) => (e.cameFrom ? 0 : e.toKnown ? 1 : 2);
  return band(a) - band(b);
}

/**
 * A way out, as it should be read from the side you are standing on.
 *
 * Connectors are named for what they are and never for where they go — one
 * entity, two ends, and a name that points is wrong from one of them. The
 * destination is joined on here instead, correct by construction whichever end
 * is being read.
 *
 * Withheld until the player has been through, because a room's name is a thing
 * they learn by arriving. That withholding is why this is the one place the
 * label is built: the panel and the referee's prompt must agree about what the
 * player is able to name, or the referee will offer them a room they cannot
 * ask for.
 */
export function exitLabel(e: ExitView): string {
  if (e.surface) return `${e.name} — out of the dungeon`;
  if (!e.toKnown || e.toRoomName === "") return e.name;
  return `${e.name} to ${theRoom(e.toRoomName)}`;
}

/**
 * A room name with an article in front, unless it brought its own.
 *
 * Names are written by the content pass and arrive both ways — "Kennel" and
 * "The Long Gallery" out of the same run. Anything building a sentence around
 * one goes through here rather than gambling on "the The Long Gallery".
 */
export function theRoom(name: string): string {
  return /^(the|a|an)\s/i.test(name) ? name : `the ${name}`;
}

/**
 * The room the interface should be showing, which is not always the room the
 * player is standing in.
 *
 * A move applies before the arrival is written, so between the two the player is
 * somewhere they have been told nothing about. The panel and the map marker stay
 * where the player's reading is until the arrival lands — see `shownRoomId` on
 * RunState. Undefined only before the first arrival of a run, when the honest
 * thing to show is nothing.
 *
 * The referee is NOT shown this. It is told where they actually stand.
 */
export function shownRoom(run: RunState): string | undefined {
  // A run saved before this existed comes back with nothing here; anything but
  // a room entry in flight means the narration has long since caught up.
  return run.shownRoomId ?? (run.stage === "room_entry" ? undefined : run.currentRoomId);
}

/**
 * Everything in the room that owes the player fresh prose. Empty means the room
 * can be re-shown exactly as they last read it, with no call at all.
 *
 * Concealed things fall out of this on their own — hiding something settles its
 * description debt, because `composed` is prose for the player and a concealed
 * thing owes them none. Revealing it opens the debt again, which is exactly
 * when there is somebody to read it.
 */
export function needsComposition(run: RunState, roomId: string = run.currentRoomId): AnyEntity[] {
  const e = run.entities;
  const room = e.rooms.find((r) => r.id === roomId);
  if (!room) return [];
  return [
    ...(entityNeedsComposition(room) ? [room] : []),
    ...directContents(roomId, e).filter(entityNeedsComposition),
  ];
}

// ===========================================================================
// THE CHARACTER PANEL
// ===========================================================================

export interface AbilityView {
  key: Ability;
  bonus: number;
  /** always bonus + 10 */
  defense: number;
}

export interface EquippedView {
  slot: EquipSlot;
  item?: EntityView;
  summary?: string;
}

export interface CharacterView {
  name: string;
  level: number;
  hp: { current: number; max: number };
  abilities: AbilityView[];
  /** armour + 1 per helmet + 1 per shield, or 11 unarmoured */
  armorDefense: number;
  /** Knave: melee is STR, ranged is WIS */
  meleeBonus: number;
  rangedBonus: number;
  slots: SlotReport;
  inventory: EntityView[];
  equipped: EquippedView[];
  conditions: string[];
  traits: PlayerCharacter["traits"];
}

const ABILITIES: readonly Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export function characterView(run: RunState): CharacterView {
  const pc = run.pc;
  const registry = run.entities.registry;

  return {
    name: pc.name,
    level: pc.level,
    hp: { ...pc.hp },
    abilities: ABILITIES.map((key) => ({
      key,
      bonus: pc.abilities[key],
      defense: pc.abilities[key] + 10,
    })),
    armorDefense: pcArmorDefense(pc),
    meleeBonus: meleeAttackBonus(pc),
    rangedBonus: rangedAttackBonus(pc),
    slots: inventoryStatus(pc),
    inventory: pc.inventory.map((i) => toView(i, run.entities, registry)),
    equipped: EQUIP_SLOTS.map((slot) => {
      const item = heldItem(pc, pc.equipped[slot]);
      return {
        slot,
        item: item ? toView(item, run.entities, registry) : undefined,
        summary: item ? itemSummary(item) : undefined,
      };
    }),
    conditions: [...pc.conditions],
    traits: pc.traits,
  };
}

/** A creature's defense, for the referee — never shown to the player. */
export function creatureDefense(creature: ICreature, ability: Ability): number {
  return creatureAbilityDefense(creature.stats, ability);
}

/** A worn item's contribution, for a panel that wants to break the number down. */
export function armorPieces(pc: PlayerCharacter): { slot: EquipSlot; name: string; defense: number }[] {
  return EQUIP_SLOTS.flatMap((slot) => {
    const item = heldItem(pc, pc.equipped[slot]);
    if (!item || !isArmor(item)) return [];
    return [{ slot, name: item.name, defense: slot === "armor" ? item.armor.defense : 1 }];
  });
}

/**
 * Unarmoured is 11. Exposed so a panel can show what armour is worth.
 *
 * STATED, NOT DERIVED THROUGH A FAKE CREATURE. This used to read
 * `bodyArmorDefense({ hitDice: 0, ... })`, which was the same 11 only for as
 * long as HD 0 meant nothing; it is now the fodder band and answers 10, so the
 * borrowed derivation would have quietly cost the player a point of defense.
 * The player's unarmoured defense is a Knave constant and has no hit dice
 * behind it.
 */
export const UNARMORED_DEFENSE = 11;

// ===========================================================================
// THE MAP
// ===========================================================================

export interface MapRoomView extends LayoutRoom {
  /** the player has been here; unvisited rooms are drawn as nothing */
  known: boolean;
  current: boolean;
  /** only once known — an unvisited room has no name to show */
  name?: string;
  /**
   * What the player read on arrival, for the hover. Withheld under exactly the
   * same test as `name`: a description of a room they have not entered is the
   * one thing fog exists to withhold.
   */
  composed?: string;
}

export interface MapConnectorView extends LayoutConnector {
  /** at least one end has been visited, so the player knows this way exists */
  known: boolean;
  /** it leads somewhere the player has not been — draw it as a stub, not a link */
  toUnknown: boolean;
  blocked: boolean;
  requirement?: string;
  /** out of the dungeon entirely — drawn and confirmed unlike any other way */
  surface: boolean;
  /** what it is, for the hover. A connector is named for what it is, never where it goes. */
  name: string;
  composed?: string;
}

/**
 * A thing standing in a room, as the player is entitled to see it.
 *
 * THE RULE: an entity appears on the map, and changes on the map, only when its
 * `composed` changes. Nothing else about it reaches the drawing.
 *
 * That single test does every job at once, because `composed` is written in
 * exactly one circumstance — the player is looking at the thing. So:
 *
 *   never encountered   `composed === undefined`, and nothing is drawn
 *   concealed           room entry never composes a hidden thing, so likewise
 *   two rooms away       `setState` marks `needUpdate` and LEAVES `composed`;
 *                        the marker keeps saying where it was last seen
 *
 * The map is therefore a record of what the player observed, corrected only
 * when they observe again — which is the same precedence `dungeon-entities.ts`
 * sets for prose. What they were told binds.
 */
export interface MapFixtureView extends LayoutFixture {
  /** the entity's name, for the hover */
  name: string;
  /** what the player read about it. Never undefined: it is why this is drawn. */
  composed: string;
  /**
   * Where it stands, as prose — "along the north wall". The same fact the
   * referee is given, said the same way, so the hover and the narration match
   * word for word rather than merely agreeing.
   */
  position?: string;
}

export interface MapViewOptions {
  /** draw concealed ways too. Debug and the jump-to-room tool only. */
  includeHidden?: boolean;
}

export interface MapView {
  bounds: Layout["bounds"];
  rooms: MapRoomView[];
  connectors: MapConnectorView[];
  fixtures: MapFixtureView[];
}

/**
 * The layout with fog of war and gating laid over it.
 *
 * Fog is `composed === undefined` — never encountered. That is why `needUpdate`
 * exists rather than clearing `composed`: a room whose state moved while the
 * player was elsewhere must stay drawn on the map, not blink out of existence.
 *
 * An exit from a known room into an unknown one is an INFERRED exit — the
 * player knows a way leads off there without knowing what is on the other side
 * — so it is marked rather than dropped, and the room it points at stays dark.
 *
 * A CONCEALED way is dropped entirely. Drawing it, even as a stub, would tell
 * the player a secret door is there, which is the one thing a secret door must
 * not do. It reappears the moment `isHidden` goes false.
 *
 * The same is true of everything standing in a room — see `MapFixtureView`.
 * `Layout.fixtures` deliberately carries every placed entity, concealed ones
 * included, because that module knows only geometry; this is the only place the
 * filter exists, and it is the one filter in the file that cannot be walked
 * back if it is wrong.
 */
export function mapView(
  run: RunState,
  dungeon: GeneratedDungeon,
  layout?: Layout,
  opts: MapViewOptions = {}
): MapView {
  const base = layout ?? pointLayout(dungeon.graph);
  const rooms = new Map(run.entities.rooms.map((r) => [r.id, r]));
  const connectors = new Map(run.entities.connectors.map((c) => [c.id, c]));
  // Rooms are never hidden, so a written description means the player has
  // stood here — stale or not.
  const known = (id: string) => rooms.get(id)?.composed !== undefined;

  const view = (c: LayoutConnector): MapConnectorView => {
    const entity = connectors.get(c.id);
    const fromKnown = known(c.from);
    // A way OUT is known exactly when the room it leaves from is, and it never
    // leads into the dark — the player walked in through it. Answering the
    // far-side question with `true` instead would draw the exit stub hanging in
    // blank paper before the entrance room itself has been described.
    const toKnown = c.to === null ? fromKnown : known(c.to);
    return {
      ...c,
      known: fromKnown || toKnown,
      toUnknown: fromKnown !== toKnown,
      blocked: entity?.conditional !== undefined,
      requirement: entity?.conditional,
      surface: c.to === null,
      name: entity?.name ?? "",
      composed: entity?.composed,
    };
  };

  // The way out is not on `graph.edges` — it is minted by the entities pass
  // with a null far end — so the layout can place it but cannot name it. This
  // is where the geometry and the entity meet.
  const surface = base.surface;
  const exit = surface && run.entities.connectors.find(isSurfaceExit);

  // --- what is standing in the rooms ---------------------------------------
  //
  // Four tests, and every one of them is load-bearing. `includeHidden` is
  // honoured for the same debugging reason connectors honour it, and for no
  // other: it is never true on anything the player sees.
  const placed = new Map<string, AnyEntity>();
  for (const f of run.entities.features) placed.set(f.id, f);
  for (const i of run.entities.items) placed.set(i.id, i);

  const fixtures: MapFixtureView[] = [];
  for (const f of base.fixtures) {
    const entity = placed.get(f.id);
    if (!entity) continue;
    if (!known(f.roomId)) continue;
    if (opts.includeHidden !== true && entity.isHidden === true) continue;
    // THE RULE. Undrawn until the player has been shown it, and thereafter
    // showing what they were shown.
    if (entity.composed === undefined) continue;
    // An item that has left the room it was placed in is no longer lying there.
    // Every path that moves one today happens with the player watching — they
    // picked it up — so dropping the marker is what they saw. A thief carrying
    // something off while they are elsewhere wants a "last seen here" snapshot
    // instead, and that arrives with creature markers, which need it too.
    if (entity.type === "Item" && entity.parentId !== f.roomId) continue;
    const place = (entity as { place?: { position: string } }).place;
    fixtures.push({
      ...f,
      name: entity.name,
      composed: entity.composed,
      position: place ? positionPhrase(place.position) : undefined,
    });
  }

  return {
    bounds: base.bounds,
    rooms: base.rooms.map((r) => ({
      ...r,
      known: known(r.id),
      // The marker moves with the narration, not with the commit — otherwise it
      // points into an unlit room for as long as the arrival takes to write.
      current: r.id === (shownRoom(run) ?? run.currentRoomId),
      name: known(r.id) ? rooms.get(r.id)?.name : undefined,
      composed: known(r.id) ? rooms.get(r.id)?.composed : undefined,
    })),
    connectors: [
      ...base.connectors,
      ...(surface && exit
        ? [
            {
              id: exit.id,
              from: surface.roomId,
              to: null,
              interChunk: false,
              door: surface.door,
              path: { kind: "line" as const, from: surface.door.at, to: surface.door.through },
            },
          ]
        : []),
    ]
      .filter((c) => opts.includeHidden === true || connectors.get(c.id)?.isHidden !== true)
      .map(view),
    fixtures,
  };
}
