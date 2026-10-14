/**
 * DICE
 * ====
 *
 * Every number in the game comes from here. The model never states one it did
 * not receive from these functions.
 *
 * ONE THRESHOLD CONVENTION. Knave phrases success as "greater than" a target;
 * the game master's playbook phrases it as a DC of 16. They are the same rule, and
 * the model reads the playbook — so the code takes a DC and succeeds on
 * `total >= dc`. The one place the two meet is `dcFromDefense`: a *contest*
 * must exceed the opposing defense, so attacks and stunts convert internally
 * and no caller ever writes `+ 1` by hand.
 *
 * These functions are pure. They report that a critical happened; they do not
 * spend the quality point, because quality lives on an entity and this file
 * knows nothing about entities.
 */

/** Anything that yields a float in [0,1). `Rng` satisfies it, as does CountingRng. */
export interface RollRng {
  next(): number;
}

export type Edge = "none" | "advantage" | "disadvantage";

/** An ordinary save. Knave: beat 15, i.e. meet 16. */
export const ORDINARY_DC = 16;

/** Default 2d6 morale rating. */
export const DEFAULT_MORALE = 7;

/**
 * A defense used as a roll target. Knave contests must EXCEED the defense, so
 * meeting `defense + 1` is the same bar. The only `+1` in the codebase.
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
 * Advantage and disadvantage are roll-two-keep-best / keep-worst, on the d20
 * only — never on damage. A natural 20 or 1 is read off the die that counts,
 * not off whichever die happened to show it.
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
 * `extraDice` adds dice of the weapon's own type — a natural 20, or the right
 * weapon against the right enemy. Damage never takes advantage.
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
 * The contest underneath all three: d20 + bonus against a number to meet.
 *
 * Exported because the turn machine resolves a `RollSpec` whose `dc` has
 * already been converted from a defense by whoever offered the roll — so it
 * needs the bare contest, and taking it from here keeps `dcFromDefense` the
 * only place a defense turns into a target.
 */
export function checkRoll(rng: RollRng, bonus: number, dc: number, edge: Edge = "none"): RollOutcome {
  const roll = d20(rng, edge);
  const total = roll.kept + bonus;
  return { ...roll, bonus, total, dc, success: total >= dc };
}

/**
 * A save. `dc` defaults to the ordinary 16; when a creature is the source of
 * the risk, pass `dcFromDefense(creatureDefense)` instead — that is also how an
 * opposed save is expressed, since a defense is always bonus + 10.
 */
export function saveRoll(rng: RollRng, bonus: number, dc: number = ORDINARY_DC, edge: Edge = "none"): RollOutcome {
  return checkRoll(rng, bonus, dc, edge);
}

/**
 * Which items a critical costs, and how much extra damage it deals.
 *
 * Knave's rule is symmetric across attacker and defender, but every roll in
 * this game is made by the attacker — creature turns resolve inside the action,
 * and stopping to ask the player for a defense roll would break the turn apart.
 * So only the attacker's two branches are reachable.
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
  /** the right weapon for the enemy — a blunt weapon against a skeleton */
  wellSuited?: boolean;
}

export interface AttackResult extends RollOutcome {
  crit: CritEffects;
  /** present only on a hit that deals damage */
  damage?: DamageResult;
}

/**
 * An attack. Takes the target's DEFENSE, not a DC — that is the vocabulary the
 * playbook uses. Rolls its own damage on a hit, including the extra die for a
 * natural 20 and for a well-suited weapon.
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
 * A stunt — stunning, shoving, disarming, tripping, sundering. Resolved as a
 * contest against the target's defense and dealing no damage of its own.
 *
 * A player with advantage may instead spend it to stunt AND deal damage on the
 * same hit; the playbook passes `edge: "none"` in that case, because the
 * advantage bought the combination rather than a reroll.
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
  /** they stand; false means they flee, retreat, or parley */
  holds: boolean;
}

/**
 * 2d6 against the group's morale rating. They break when the roll comes up
 * HIGHER than the rating, so equalling it still holds.
 *
 * Triggered by half the group falling, the leader going down, or a lone
 * creature dropping to half its hit points.
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
  /** consultations made, this one included */
  uses: number;
  rolled: number;
  /** this reading was the last the book had in it */
  exhausted: boolean;
}

/**
 * A book gives up what it has, and then it has no more.
 *
 * Add one to the count of readings, roll a d6, and the book is spent when the
 * die comes up at or under that count. Nothing decides in advance how much is
 * in a book: the first reading is safe five times in six, the third is even
 * money, the sixth is certain, and the expected book answers between two and
 * three questions.
 *
 * The roll happens at the READING, not at the writing — which is the difference
 * between a book whose depth is a fact about the world and one whose depth is
 * found out by using it. Only the second can surprise the person holding it.
 */
export function consultRoll(rng: RollRng, priorUses = 0): ConsultResult {
  const uses = Math.max(0, priorUses) + 1;
  const rolled = die(rng, 6);
  return { uses, rolled, exhausted: rolled <= uses };
}
