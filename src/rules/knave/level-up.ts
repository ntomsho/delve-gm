/**
 * Levelling up, by Knave's rule: roll as many d8s as the new level for a new
 * maximum hit points, and raise three different abilities by 1 each.
 *
 * The dice are seeded from the character and the level being taken, not from
 * the clock (`levelUpSeed`). So the result for a character's next level is
 * fixed before the screen opens, and closing the screen and reopening it shows
 * the same roll.
 *
 * XP is never spent. `xp` is a lifetime total, and `level` is how many levels
 * the player has taken from it; `pendingLevels` is the difference, and the
 * level-up button appears only when it is above 0. So 2,400 XP means level 3
 * (once both levels are taken) with 400 towards the next, which is what the
 * end-of-run screen (`src/ui/play/EndOfRun.tsx`) counts down to.
 *
 * Each call takes one level. A character who comes back with 3,000 XP is owed
 * three levels; each gets its own roll and its own three raises, and the
 * screen offers the button again after each one.
 *
 * One change from Knave. Knave raises the maximum by 1 when the roll is less
 * than the old maximum, which makes rolling exactly the old maximum the only
 * result that gives nothing, worse than rolling one less. `hpFromRoll` makes
 * the new maximum at least the old one plus 1, so every level gives at least
 * a point. `CREATION_RULES` in `character-creation.ts` changes Knave for a
 * similar reason.
 */

import { Rng } from "../../shared/utils/rng.ts";
import type { Ability } from "../../shared/world/entities.ts";
import { ABILITIES } from "./character-creation.ts";
import type { PlayerCharacter } from "./character.ts";

/**
 * XP needed for each level.
 *
 * An open balance question: a size 5 dungeon has about thirty challenges,
 * mostly moderate, which comes to roughly 3,000 XP, or three levels from one
 * dungeon. Either this number or the XP awards may need to change.
 */
export const XP_PER_LEVEL = 1000;

/**
 * The highest an ability bonus can go. Knave's limit is "20/+10"; the sheet
 * stores bonuses, and a defense is always bonus + 10, so one number covers
 * both.
 */
export const ABILITY_MAX = 10;

/** Three different abilities, each by one point. */
export const RAISES_PER_LEVEL = 3;

/**
 * How many levels an XP total has earned beyond the current level.
 *
 * Takes the two numbers rather than a sheet because the end-of-run screen also
 * needs this answer for a total that includes XP not yet saved to any sheet.
 * Having one function answer for both keeps them from disagreeing.
 */
export function levelsOwed(xp: number, level: number): number {
  return Math.max(0, Math.floor(xp / XP_PER_LEVEL) + 1 - level);
}

/** How many levels this character has earned and not yet taken. */
export function pendingLevels(pc: PlayerCharacter): number {
  return levelsOwed(pc.xp ?? 0, pc.level);
}

/** The level this call would take them to. */
export const nextLevel = (pc: PlayerCharacter): number => pc.level + 1;

export interface LevelUpRoll {
  /** One d8 per level of the level being taken, in the order rolled. */
  dice: number[];
  /** The sum of the dice, before `hpFromRoll`'s minimum is applied. */
  total: number;
  /** The new maximum. Never below the old one plus a point. */
  hpMax: number;
  /** True if the dice came in at or below the old maximum, so the minimum set `hpMax`. */
  floored: boolean;
}

/**
 * The new maximum hit points from the dice total: the total, or the old
 * maximum plus 1, whichever is higher. Separate from the roll so the rule can
 * be tested without dice.
 */
export function hpFromRoll(total: number, previousMax: number): number {
  return Math.max(total, previousMax + 1);
}

/**
 * Rolls the new maximum hit points: `nextLevel(pc)` d8s, and at least the old
 * maximum plus 1.
 *
 * There is no reroll. With unlimited rerolls a player would just keep rolling
 * until every die showed 8. Character creation's hit point step
 * (`src/ui/create/StepHp.tsx`) limits rerolls for the same reason.
 */
export function rollLevelUpHp(rng: Rng, pc: PlayerCharacter): LevelUpRoll {
  const dice = Array.from({ length: nextLevel(pc) }, () => rng.d(8));
  const total = dice.reduce((a, b) => a + b, 0);
  return { dice, total, hpMax: hpFromRoll(total, pc.hp.max), floored: total <= pc.hp.max };
}

/**
 * The seed for this level's dice, made from the character's id and the level
 * being taken.
 *
 * Closing the level-up screen and opening it again must not give a new roll,
 * or the player could reroll for free. Nothing is stored to prevent it: the
 * seed depends only on the character and the level, so every opening rolls
 * the same dice. Taking the level raises `level`, which changes the seed for
 * the next one.
 *
 * The string hash is the same xmur3 hash as in `makeRng`
 * (`src/generation/floorplan/graph.ts`), but returns the integer directly,
 * because `Rng` takes a number and does its own mixing.
 */
export function levelUpSeed(pc: PlayerCharacter): number {
  const key = `${pc.id}:${nextLevel(pc)}`;
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** This character's roll for their next level. Always the same for the same character and level. */
export function levelUpRoll(pc: PlayerCharacter): LevelUpRoll {
  return rollLevelUpHp(new Rng(levelUpSeed(pc)), pc);
}

/** The abilities still below `ABILITY_MAX`, in sheet order. */
export function raisableAbilities(pc: PlayerCharacter): Ability[] {
  return ABILITIES.filter((a) => pc.abilities[a] < ABILITY_MAX);
}

/**
 * How many abilities this level-up must raise: three, or fewer if fewer than
 * three abilities are below the cap. A character at +10 in five abilities can
 * still take the level; they just raise only the sixth.
 */
export function requiredRaises(pc: PlayerCharacter): number {
  return Math.min(RAISES_PER_LEVEL, raisableAbilities(pc).length);
}

export interface LevelUpChoice {
  roll: LevelUpRoll;
  /** Which abilities go up by 1. They must all be different, and none may be at the cap. */
  raises: readonly Ability[];
}

/**
 * Takes the level. Returns a new sheet and leaves `pc` unchanged.
 *
 * Current hit points go up by the same amount as the maximum.
 * `carriedOut` (`src/server/db/characters.ts`) heals a survivor to full when
 * they leave a dungeon, so characters between runs are at full hit points.
 * Raising only the maximum would make them look wounded. A character below
 * full (in a test, say) gains the same points rather than being healed to the
 * new maximum.
 *
 * Throws on a choice that breaks the rules, as `checkout` in `shop.ts` does
 * for a cart the player can't afford. The screen disables any button that
 * would make such a choice, so reaching this with four raises or a duplicate
 * is a bug in the caller.
 */
export function applyLevelUp(pc: PlayerCharacter, choice: LevelUpChoice): PlayerCharacter {
  const { roll, raises } = choice;
  const wanted = requiredRaises(pc);
  if (raises.length !== wanted) {
    throw new Error(`a level raises ${wanted} abilities, not ${raises.length}`);
  }
  if (new Set(raises).size !== raises.length) {
    throw new Error("the three abilities raised must be different");
  }
  for (const a of raises) {
    if (pc.abilities[a] >= ABILITY_MAX) {
      throw new Error(`${a.toUpperCase()} is already at +${ABILITY_MAX}, the ceiling`);
    }
  }

  const next = structuredClone(pc);
  next.level = nextLevel(pc);
  const gained = roll.hpMax - pc.hp.max;
  next.hp = { current: pc.hp.current + gained, max: roll.hpMax };
  for (const a of raises) next.abilities[a] += 1;
  return next;
}
