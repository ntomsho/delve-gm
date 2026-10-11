/**
 * LEVELLING UP
 * ============
 *
 * What a thousand experience points buys, and it is Knave's own answer: roll a
 * number of d8s equal to your NEW level for a new hit point maximum, and raise
 * three different abilities by one each.
 *
 * Pure and seeded like everything else here, and the seed is DERIVED FROM THE
 * CHARACTER rather than taken from the clock — see `levelUpSeed`. So the dice
 * for a given character's next level are decided before anybody presses
 * anything, and closing the screen to try again finds the same ones.
 *
 * THE TRACK IS CUMULATIVE AND NOTHING IS SPENT. `EndOfRun` has been counting
 * down to the next level as `XP_PER_LEVEL - (total % XP_PER_LEVEL)` since the
 * tally landed, and that sentence only means anything if a career total of 2,400
 * XP is a level 3 character with 400 towards the next. So `xp` accumulates
 * forever and `level` is what has been *claimed* of it — `pendingLevels` is the
 * difference, and it is the only thing that decides whether the button exists.
 *
 * ONE LEVEL PER CALL. A character who comes up from a size 5 dungeon with 3,000
 * XP has three levels owed, and each is its own roll and its own three raises —
 * so this hands back a sheet one level higher and the screen offers the button
 * again. Batching them would mean rolling 2d8, 3d8 and 4d8 at once and calling
 * it a choice.
 *
 * WHERE WE DEPART FROM THE BOOK, and it is one comparison: Knave says the
 * maximum goes up by 1 when the roll comes in *less than* the old maximum, which
 * leaves rolling exactly your old maximum as the one result that pays nothing —
 * strictly worse than rolling one under it. `hpFromRoll` uses `prev + 1` as the
 * floor, so the curve is monotonic and a level always buys at least a point. See
 * `CREATION_RULES` in `character-creation.ts` for the same kind of departure,
 * made for the same kind of reason.
 */

import { Rng } from "./dungeon-blueprint.ts";
import type { Ability } from "./dungeon-entities.ts";
import { ABILITIES } from "./character-creation.ts";
import type { PlayerCharacter } from "./dungeon-character.ts";
import { XP_PER_LEVEL } from "./dungeon-tally-pass.ts";

/**
 * Knave's ceiling, in the units a sheet stores. Abilities are held as BONUSES
 * and a defense is always bonus + 10, so "never higher than 20/+10" is one
 * number here rather than two that could disagree.
 */
export const ABILITY_MAX = 10;

/** Three different abilities, each by one point. */
export const RAISES_PER_LEVEL = 3;

/**
 * How many levels a career total has bought that have not been taken.
 *
 * The two numbers rather than the sheet, because the end-of-run screen asks the
 * same question about a total that includes an award which is not on any sheet
 * yet — and two answers to "is a level owed" is one too many.
 */
export function levelsOwed(xp: number, level: number): number {
  return Math.max(0, Math.floor(xp / XP_PER_LEVEL) + 1 - level);
}

/** How many levels this character has earned and not yet taken. */
export function pendingLevels(pc: PlayerCharacter): number {
  return levelsOwed(pc.xp ?? 0, pc.level);
}

/** Whether there is a level waiting to be taken. */
export function canLevelUp(pc: PlayerCharacter): boolean {
  return pendingLevels(pc) > 0;
}

/** The level this call would take them to. */
export const nextLevel = (pc: PlayerCharacter): number => pc.level + 1;

export interface LevelUpRoll {
  /** One d8 per level of the level being taken, in the order rolled. */
  dice: number[];
  /** What the dice actually said, before anything was done about it. */
  total: number;
  /** The new maximum. Never below the old one plus a point. */
  hpMax: number;
  /** Whether the rule did the work rather than the dice. */
  floored: boolean;
}

/**
 * The new maximum from a raw total. Separate from the roll so the rule can be
 * tested without dice, and so the screen can say what the alternative was.
 */
export function hpFromRoll(total: number, previousMax: number): number {
  return Math.max(total, previousMax + 1);
}

/**
 * Roll the new hit point maximum: `nextLevel(pc)` d8s, floored at one better
 * than what they had.
 *
 * ROLLED ONCE, and the interface offers no reroll — an unlimited handful of d8s
 * is a handful of 8s, which is the same reasoning `StepHp` is built on.
 */
export function rollLevelUpHp(rng: Rng, pc: PlayerCharacter): LevelUpRoll {
  const dice = Array.from({ length: nextLevel(pc) }, () => rng.d(8));
  const total = dice.reduce((a, b) => a + b, 0);
  return { dice, total, hpMax: hpFromRoll(total, pc.hp.max), floored: total <= pc.hp.max };
}

/**
 * THE SEED FOR THIS LEVEL'S DICE, and it is a fact about the character rather
 * than about when the screen opened.
 *
 * Closing the modal and opening it again must not roll a second time — an
 * unlimited handful of d8s is a handful of 8s, which is the same reason
 * `StepHp` charges a reroll for one. Nothing is stored to enforce it: the seed
 * is derived from who they are and which level they are taking, so the dice are
 * decided before the button is pressed and pressing it again finds the same
 * ones. Taking the level moves `level`, which is what lets the next one differ.
 *
 * The hash is `makeRng`'s (xmur3, in `dungeon-phase-a.ts`), stopped at the
 * integer — `Rng` wants a number and does its own mixing.
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

/** This character's roll for this level, and the same one every time it is asked. */
export function levelUpRoll(pc: PlayerCharacter): LevelUpRoll {
  return rollLevelUpHp(new Rng(levelUpSeed(pc)), pc);
}

/** The abilities that are still under the ceiling, in sheet order. */
export function raisableAbilities(pc: PlayerCharacter): Ability[] {
  return ABILITIES.filter((a) => pc.abilities[a] < ABILITY_MAX);
}

/**
 * How many raises this level-up takes — three, or every ability still under the
 * ceiling when there are fewer than three of those left. A character at +10 in
 * five of six may still take the level; they simply cannot spend all of it.
 */
export function requiredRaises(pc: PlayerCharacter): number {
  return Math.min(RAISES_PER_LEVEL, raisableAbilities(pc).length);
}

export interface LevelUpChoice {
  roll: LevelUpRoll;
  /** Which abilities go up by one. Different from each other, and none at the cap. */
  raises: readonly Ability[];
}

/**
 * Take the level. Returns a NEW sheet; the argument is not touched.
 *
 * THE CURRENT TOTAL RIDES UP WITH THE MAXIMUM. `carriedOut` heals a survivor to
 * full on the way out of the dungeon, so a character standing on the roster is
 * at full hit points and a level that raised only the maximum would read as a
 * wound they did not take. Anyone below full — a sheet mid-repair, a test —
 * gains the same points rather than being quietly healed to the new top.
 *
 * IT THROWS on a choice that breaks a rule, exactly as `checkout` throws on an
 * unaffordable cart: the screen disables the button that would do it, so getting
 * here with four raises or a duplicate is a bug in the caller and not a decision
 * to be silently rounded off.
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
