/**
 * THE STARTER: a character every new account finds already on its roster, so a
 * visitor can walk into a dungeon before they have learnt what a gear table is.
 *
 * AVERAGE ON PURPOSE. It is a finished normal-mode character with its choices
 * made for it, not a gift: the ten point-buy points spent as +3 STR, DEX, CON
 * and WIS and +2 INT and CHA, 10 hit points (the 2d8 average, just over the floor of 9),
 * a sword, a gambeson and a shield, and the usual rations, torches and rope. A
 * fighter's shape, because swinging a sword is the action a newcomer reaches for
 * first and the one that needs the least explaining.
 *
 * THE GEAR IS CHOSEN, NOT ROLLED, but every piece is a real row of the table it
 * would have come from, and each group carries the d20 face that gives it. A
 * kit that nothing could roll would be a kit the creation screen could not
 * show honestly.
 *
 * WHO THEY ARE IS ROLLED: name, traits and gender come from an `Rng` the caller
 * seeds (the server seeds it from the account id, `seedFromText`), so two
 * players do not meet the same stranger and one player always gets the same one.
 *
 * Every item still goes through `finishCharacter`, the one place a sheet is
 * made, so ids, `parentId`s and equipped slots are exactly what a hand-made
 * character gets.
 */

import type { Rng } from "../../shared/utils/rng.ts";
import { GENDERS, type CharacterAbilities, type PlayerCharacter } from "./character.ts";
import {
  finishCharacter,
  rollName,
  rollTraits,
  type GearGroup,
  type GearSlot,
  type StartingKit,
} from "./character-creation.ts";
import { mintItem, type EquipmentKey } from "./equipment.ts";
import {
  DUNGEONEERING_GEAR,
  STARTING_RATIONS,
  rollArmorTable,
  rollHelmetShieldTable,
  type GearRow,
} from "./tables.ts";

/**
 * Ten points of point buy: +3 costs 2 over the base and +2 costs 1, so
 * 2×4 + 1×2. Around what 2d6-keep-lowest rolls on average (about +2.5), with
 * the thinking abilities left at the lower end.
 */
export const STARTER_ABILITIES: CharacterAbilities = { str: 3, dex: 3, con: 3, int: 2, wis: 3, cha: 2 };

export const STARTER_HP = 10;

/** The `parentId` a kit item holds until `finishCharacter` gives it the real one. */
const UNOWNED = "";

const item = (row: GearRow, rng: Rng) =>
  mintItem(row.key, UNOWNED, rng, {
    ...(row.amount !== undefined ? { amount: row.amount } : {}),
    ...(row.value !== undefined ? { value: row.value } : {}),
  });

/** The first face of a d20 table that gives what is wanted. Throws if none does. */
function faceFor(wanted: (d20: number) => boolean, what: string): number {
  for (let d20 = 1; d20 <= 20; d20++) if (wanted(d20)) return d20;
  throw new Error(`no face of the d20 gives ${what}`);
}

/** One row of the dungeoneering table, as a group with its real d20 face. */
function dungeoneering(slot: GearSlot, key: EquipmentKey, rng: Rng): GearGroup {
  const index = DUNGEONEERING_GEAR.findIndex((r) => r.key === key);
  if (index < 0) throw new Error(`${key} is not on the dungeoneering table`);
  return { slot, d20: index + 1, items: [item(DUNGEONEERING_GEAR[index], rng)] };
}

function starterKit(rng: Rng): StartingKit {
  const armorFace = faceFor((d) => {
    const r = rollArmorTable(d);
    return r.armor === "gambeson" && r.spellbooks === 0;
  }, "a gambeson");
  const shieldFace = faceFor((d) => {
    const r = rollHelmetShieldTable(d);
    return r.shield && !r.helmet && r.spellbooks === 0;
  }, "a shield alone");

  return {
    rations: item(STARTING_RATIONS, rng),
    weapon: mintItem("sword", UNOWNED, rng),
    groups: [
      { slot: "armor", d20: armorFace, items: [mintItem("gambeson", UNOWNED, rng)] },
      { slot: "helmetShield", d20: shieldFace, items: [mintItem("shield", UNOWNED, rng)] },
      dungeoneering("dungeoneering1", "torch", rng),
      dungeoneering("dungeoneering2", "rope", rng),
    ],
    copper: 0,
  };
}

/** The starter character, ready to save. Everything that varies comes from `rng`. */
export function starterCharacter(rng: Rng): PlayerCharacter {
  const name = rollName(rng);
  const traits = rollTraits(rng);
  const gender = rng.pick(GENDERS);
  return finishCharacter({
    mode: "normal",
    name,
    abilities: { ...STARTER_ABILITIES },
    traits,
    gender,
    hp: STARTER_HP,
    kit: starterKit(rng),
  });
}

/**
 * A 32-bit seed from a piece of text (FNV-1a), so an account id can seed the
 * roll. Not a security hash; it only has to spread similar ids apart.
 */
export function seedFromText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
