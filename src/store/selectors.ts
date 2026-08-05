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
  needsComposition as entityNeedsComposition,
  inventoryStatus,
  maxHp,
  meleeAttackBonus,
  pcArmorDefense,
  rangedAttackBonus,
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
import { EQUIP_SLOTS, heldItem, itemSummary } from "../engine/index.ts";
import { directContents, heldItems } from "../runtime/occupancy.ts";
import { pointLayout, type Layout, type LayoutConnector, type LayoutRoom } from "../runtime/layout.ts";
import type { GeneratedDungeon } from "../runtime/generate.ts";
import type { RunState } from "./game.ts";

// ===========================================================================
// ENTITIES
// ===========================================================================

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
  /** items only */
  slots?: number;
  quality?: { current: number; original: number };
  /** things this thing holds — a chest's contents, a body's gear */
  contains: EntityView[];
}

function toView(entity: AnyEntity, entities: EntityPassResult, registry: TemplateRegistry): EntityView {
  const view: EntityView = {
    id: entity.id,
    name: entity.name,
    kind: entity.type,
    composed: entity.composed,
    state: entity.state,
    base: resolveBase(entity, registry),
    needUpdate: entity.needUpdate === true,
    isHidden: entity.isHidden === true,
    contains: heldItems(entity.id, entities).map((i) => toView(i, entities, registry)),
  };

  if (entity.type === "Creature") {
    const c = entity as ICreature;
    view.activity = c.activity;
    view.count = c.count;
    view.hp = { current: c.stats.hp, max: maxHp(c.stats) };
  }
  if (entity.type === "Item") {
    const i = entity as IItem;
    view.slots = i.slots;
    if (i.quality !== undefined) {
      view.quality = { current: i.currentQuality ?? i.quality, original: i.quality };
    }
  }
  return view;
}

// ===========================================================================
// THE CURRENT ROOM
// ===========================================================================

export interface ExitView {
  connectorId: string;
  /** the room on the other side */
  toRoomId: string;
  name: string;
  /** what it physically is */
  form?: string;
  /** something stands in the way */
  blocked: boolean;
  /** what stands in the way, as it looks from this side */
  requirement?: string;
  /** the player has been through to the other side */
  toKnown: boolean;
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
  const visible = (x: AnyEntity) => showAll || x.isHidden !== true;

  const contents = directContents(roomId, e)
    .filter(visible)
    .map((x) => toView(x, e, registry))
    // A thing inside a concealed thing is concealed too, whoever marked it.
    .map((v) => (showAll ? v : { ...v, contains: v.contains.filter((c) => !c.isHidden) }));

  const exits: ExitView[] = e.connectors
    .filter((c) => c.endpointA === roomId || c.endpointB === roomId)
    .filter(visible)
    .map((c: IRoomConnector) => {
      const toRoomId = c.endpointA === roomId ? c.endpointB : c.endpointA;
      return {
        connectorId: c.id,
        toRoomId,
        name: c.name,
        form: resolveBase(c, registry),
        blocked: c.conditional !== undefined,
        requirement: c.conditional,
        toKnown: e.rooms.find((r) => r.id === toRoomId)?.composed !== undefined,
      };
    });

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
  };
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
    if (!item?.armor) return [];
    return [{ slot, name: item.name, defense: slot === "armor" ? item.armor.defense : 1 }];
  });
}

/** Unarmoured is 11. Exposed so a panel can show what armour is worth. */
export const UNARMORED_DEFENSE = bodyArmorDefense({ hitDice: 0, hp: 0, modifiers: {} });

// ===========================================================================
// THE MAP
// ===========================================================================

export interface MapRoomView extends LayoutRoom {
  /** the player has been here; unvisited rooms are drawn as nothing */
  known: boolean;
  current: boolean;
  /** only once known — an unvisited room has no name to show */
  name?: string;
}

export interface MapConnectorView extends LayoutConnector {
  /** at least one end has been visited, so the player knows this way exists */
  known: boolean;
  /** it leads somewhere the player has not been — draw it as a stub, not a link */
  toUnknown: boolean;
  blocked: boolean;
  requirement?: string;
}

export interface MapViewOptions {
  /** draw concealed ways too. Debug and the jump-to-room tool only. */
  includeHidden?: boolean;
}

export interface MapView {
  bounds: Layout["bounds"];
  rooms: MapRoomView[];
  connectors: MapConnectorView[];
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

  return {
    bounds: base.bounds,
    rooms: base.rooms.map((r) => ({
      ...r,
      known: known(r.id),
      current: r.id === run.currentRoomId,
      name: known(r.id) ? rooms.get(r.id)?.name : undefined,
    })),
    connectors: base.connectors
      .filter((c) => opts.includeHidden === true || connectors.get(c.id)?.isHidden !== true)
      .map((c) => {
        const entity = connectors.get(c.id);
        const fromKnown = known(c.from);
        const toKnown = known(c.to);
        return {
          ...c,
          known: fromKnown || toKnown,
          toUnknown: fromKnown !== toKnown,
          blocked: entity?.conditional !== undefined,
          requirement: entity?.conditional,
        };
      }),
  };
}
