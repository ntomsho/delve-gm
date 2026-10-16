/**
 * ONE ENTITY, AS THE SCREEN AND THE GAME MASTER SEE IT: its view, and the
 * combat numbers only the game master is shown.
 */

import {
  abilityDefense as creatureAbilityDefense,
  armorDefense as bodyArmorDefense,
  attackBonus as creatureAttackBonus,
  damageDie,
  maxHp,
  itemValue,
  resolveBase,
  type Ability,
  type AnyEntity,
  type EntityType,
  type ICreature,
  type IItem,
  type TemplateRegistry,
} from "../../shared/world/entities.ts";
import { DEFAULT_MORALE } from "../../rules/knave/rolls.ts";
import type { EntityPassResult } from "../../shared/world/entities.ts";
import { isBook } from "../../shared/world/entities.ts";
import { heldItems } from "../mechanics/occupancy.ts";
import { ABILITIES } from "../../rules/knave/character-creation.ts";

// ===========================================================================
// ENTITIES
// ===========================================================================

/**
 * A creature's numbers, for whoever has to set a difficulty.
 *
 * GAME MASTER ONLY, and that is why it is optional and gated rather than always
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
   * game master could write how many rations were down to and neither it nor the
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
   * Carried through to the game master rather than kept for the panel, because the
   * `consult` roll takes the current `uses` and the suggestion rule in step 3
   * turns on the subject. A book the game master cannot see the subject of is a
   * book nobody is ever told they are carrying.
   */
  book?: { subject: string; uses: number; exhausted: boolean };
  /**
   * Where in the room it stands, as one of the position words — "the north
   * wall", "the far end". Absent for anything that was never placed, which is
   * every creature and every dungeon generated without a drawing.
   *
   * This is the game master's half of the agreement the map keeps: the same word
   * the content pass chose, so "the altar at the far end" is something the
   * player can check against the dot.
   */
  position?: string;
  /** things this thing holds — a chest's contents, a body's gear */
  contains: EntityView[];
}

export function toView(
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
