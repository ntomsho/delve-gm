/**
 * THE CHARACTER PANEL: the sheet as the screen shows it.
 */

import {
  abilityDefense as creatureAbilityDefense,
  type Ability,
  type ICreature,
} from "../../shared/world/entities.ts";
import {
  inventoryStatus,
  meleeAttackBonus,
  armorDefense as pcArmorDefense,
  rangedAttackBonus,
  type EquipSlot,
  type PlayerCharacter,
  type SlotReport,
} from "../../rules/knave/character.ts";
import { EQUIP_SLOTS, heldItem, itemSummary } from "../../rules/knave/character.ts";
import type { RunState } from "../state/store.ts";
import { toView, type EntityView } from "./entities.ts";
import { ABILITIES } from "../../rules/knave/character-creation.ts";

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

/** A creature's defense, for the game master — never shown to the player. */
export function creatureDefense(creature: ICreature, ability: Ability): number {
  return creatureAbilityDefense(creature.stats, ability);
}
