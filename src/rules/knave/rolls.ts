/**
 * Dice: the Knave 1.0 rolls.
 *
 * Every die roll in play comes from these functions. The model only reports
 * numbers it was given; it never makes one up.
 *
 * All rolls succeed on `total >= dc`. Knave says a save must beat 15; the game
 * master's prompt calls that a DC of 16, and the code uses the prompt's
 * convention. Attacks and stunts are different: in Knave they must beat the
 * target's defense. `dcFromDefense` converts a defense into a DC by adding 1,
 * so no caller has to add it themselves.
 *
 * These functions don't change anything. A critical is reported, but the
 * point of item quality it costs is spent elsewhere (by the game master's
 * diff), because quality belongs to an entity and this file knows nothing
 * about entities.
 */

import type { RollRng } from "../../shared/utils/rng.ts";

export type Edge = "none" | "advantage" | "disadvantage";

/** The DC of an ordinary save. Knave says "beat 15", which is the same as "meet 16". */
export const ORDINARY_DC = 16;

/** The morale rating a group has unless it says otherwise; morale rolls 2d6 against it. */
export const DEFAULT_MORALE = 7;

/**
 * Converts a defense into a DC. In Knave an attack or stunt must exceed the
 * target's defense, which is the same as meeting `defense + 1`. This is the
 * only place in the codebase that adds that 1.
 */
export function dcFromDefense(defense: number): number {
  return defense + 1;
}

// ---------------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------------

export function die(rng: RollRng, sides: number): number {
  return Math.floor(rng.next() * sides) + 1;
}

export interface D20Result {
  /** one die, or two under advantage / disadvantage */
  rolled: number[];
  /** the die that counts */
  kept: number;
  nat20: boolean;
  nat1: boolean;
}

/**
 * Rolls a d20. With advantage, roll two and keep the higher; with
 * disadvantage, keep the lower. (Damage dice never get advantage.) A natural
 * 20 or 1 counts only if it is on the kept die.
 */
export function d20(rng: RollRng, edge: Edge = "none"): D20Result {
  const rolled = edge === "none" ? [die(rng, 20)] : [die(rng, 20), die(rng, 20)];
  const kept =
    edge === "advantage" ? Math.max(...rolled)
    : edge === "disadvantage" ? Math.min(...rolled)
    : rolled[0];

  return { rolled, kept, nat20: kept === 20, nat1: kept === 1 };
}

// ---------------------------------------------------------------------------
// DAMAGE
// ---------------------------------------------------------------------------

export interface DamageSpec {
  count: number;
  sides: number;
  flat: number;
}

export interface DamageResult {
  expr: string;
  rolls: number[];
  flat: number;
  total: number;
}

const DAMAGE_RE = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** "1d6", "2d8+1", "d10", "1d6-1". Throws on anything else. */
export function parseDamage(expr: string): DamageSpec {
  const m = DAMAGE_RE.exec(expr);
  if (!m) throw new Error(`unparseable damage expression: ${JSON.stringify(expr)}`);

  const count = m[1] === "" ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const flat = m[3] === undefined ? 0 : (m[3] === "-" ? -1 : 1) * Number(m[4]);

  if (count < 1 || sides < 1) throw new Error(`nonsensical damage expression: ${JSON.stringify(expr)}`);
  return { count, sides, flat };
}

/**
 * Rolls damage. `extraDice` adds more dice of the same size, for a natural 20
 * or for a weapon well suited to the enemy. The total is never below 0.
 */
export function rollDamage(rng: RollRng, expr: string, extraDice = 0): DamageResult {
  const { count, sides, flat } = parseDamage(expr);
  const rolls: number[] = [];
  for (let i = 0; i < count + extraDice; i++) rolls.push(die(rng, sides));
  const total = Math.max(0, rolls.reduce((a, b) => a + b, 0) + flat);
  return { expr, rolls, flat, total };
}

// ---------------------------------------------------------------------------
// OUTCOMES
// ---------------------------------------------------------------------------

export interface RollOutcome extends D20Result {
  bonus: number;
  total: number;
  dc: number;
  success: boolean;
}

/**
 * The basic roll behind saves, attacks and stunts: d20 + bonus, succeeding on
 * a total of at least `dc`.
 *
 * Exported for the turn machine (`src/gameplay/turn.ts`). When it rolls the
 * player's offered roll, the `RollSpec.dc` was already converted from a
 * defense when the roll was offered, so it needs this plain version rather
 * than `attackRoll` or `stuntRoll`, which would convert again.
 */
export function checkRoll(rng: RollRng, bonus: number, dc: number, edge: Edge = "none"): RollOutcome {
  const roll = d20(rng, edge);
  const total = roll.kept + bonus;
  return { ...roll, bonus, total, dc, success: total >= dc };
}

/**
 * A save. `dc` defaults to the ordinary 16. When a creature causes the danger,
 * pass `dcFromDefense(creatureDefense)` instead. That also covers a save
 * opposed by a creature, because in Knave a defense is always bonus + 10.
 */
export function saveRoll(rng: RollRng, bonus: number, dc: number = ORDINARY_DC, edge: Edge = "none"): RollOutcome {
  return checkRoll(rng, bonus, dc, edge);
}

/**
 * Which items a critical damages, and how many extra damage dice it adds.
 *
 * Knave's critical rules cover both an attack roll and a defense roll. This
 * game only ever has the attacker roll: creatures act during the player's
 * turn, and stopping to ask the player for a defense roll would split the turn
 * in two. So only the attacker's two cases can happen.
 */
export interface CritEffects {
  /** natural 20: the defender's armor loses a point of quality */
  defenderArmor: boolean;
  /** natural 1: the attacker's weapon loses a point of quality */
  attackerWeapon: boolean;
  /** dice added to the damage roll */
  extraDamageDice: number;
}

export function critEffects(o: D20Result, wellSuited = false): CritEffects {
  return {
    defenderArmor: o.nat20,
    attackerWeapon: o.nat1,
    extraDamageDice: (o.nat20 ? 1 : 0) + (wellSuited ? 1 : 0),
  };
}

export interface AttackOptions {
  bonus: number;
  /** the target's armor defense; converted to a DC internally */
  targetDefense: number;
  edge?: Edge;
  /** the weapon's die, e.g. "1d8"; omit for a stunt or an attack that deals none */
  damage?: string;
  /** the weapon is well suited to this enemy, like a blunt weapon against a skeleton */
  wellSuited?: boolean;
}

export interface AttackResult extends RollOutcome {
  crit: CritEffects;
  /** present only on a hit that deals damage */
  damage?: DamageResult;
}

/**
 * An attack. Takes the target's defense rather than a DC, because that is what
 * the prompt talks in. On a hit it also rolls the damage, adding a die for a
 * natural 20 and another for a well-suited weapon.
 */
export function attackRoll(rng: RollRng, opts: AttackOptions): AttackResult {
  const outcome = checkRoll(rng, opts.bonus, dcFromDefense(opts.targetDefense), opts.edge ?? "none");
  const crit = critEffects(outcome, opts.wellSuited);
  const result: AttackResult = { ...outcome, crit };
  if (outcome.success && opts.damage) {
    result.damage = rollDamage(rng, opts.damage, crit.extraDamageDice);
  }
  return result;
}

/**
 * A stunt: stunning, shoving, disarming, tripping, breaking a weapon or shield.
 * Rolled against the target's defense, and deals no damage.
 *
 * A player with advantage can spend it to stunt and deal damage on the same
 * hit instead of rolling twice. In that case the prompt
 * (`src/prompts/game-master/steps/4-confirm-and-roll.md`) tells the game
 * master to set `edge` to `"none"`.
 */
export function stuntRoll(rng: RollRng, bonus: number, targetDefense: number, edge: Edge = "none"): RollOutcome {
  return checkRoll(rng, bonus, dcFromDefense(targetDefense), edge);
}

// ---------------------------------------------------------------------------
// MORALE
// ---------------------------------------------------------------------------

export interface MoraleResult {
  rolled: [number, number];
  total: number;
  /** true if they keep fighting; false means they flee, retreat or try to talk */
  holds: boolean;
}

/**
 * A morale check: 2d6 against the group's morale rating. They break only if
 * the roll is higher than the rating, so rolling exactly the rating holds.
 *
 * Knave calls for one when half a group has fallen, when its leader falls, or
 * when a lone creature drops to half its hit points.
 */
export function moraleRoll(rng: RollRng, rating: number = DEFAULT_MORALE): MoraleResult {
  const rolled: [number, number] = [die(rng, 6), die(rng, 6)];
  const total = rolled[0] + rolled[1];
  return { rolled, total, holds: total <= rating };
}

// ---------------------------------------------------------------------------
// CONSULTING A BOOK
// ---------------------------------------------------------------------------

export interface ConsultResult {
  /** how many times the book has been read, counting this time */
  uses: number;
  rolled: number;
  /** this was the last useful reading; the book has nothing more to give */
  exhausted: boolean;
}

/**
 * Reading a book: each reading may use it up.
 *
 * Add one to the number of readings so far, then roll a d6. If the roll is
 * at or below that count, this reading was the book's last. The first reading
 * uses it up one time in six, the third half the time, and the sixth always.
 * On average a book answers two or three questions.
 *
 * How much a book holds is not decided when it is generated; it is rolled as
 * the player reads. That way the player finds out by using the book.
 */
export function consultRoll(rng: RollRng, priorUses = 0): ConsultResult {
  const uses = Math.max(0, priorUses) + 1;
  const rolled = die(rng, 6);
  return { uses, rolled, exhausted: rolled <= uses };
}
