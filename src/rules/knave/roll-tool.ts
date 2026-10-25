/**
 * The `roll` tool: how the game master asks for dice.
 *
 * See docs/ARCHITECTURE.md section 7. The player's own roll is made in code
 * when they press the roll button. Every other roll (a creature striking
 * back, a group losing its nerve, a ceiling coming down) is requested through
 * this tool.
 *
 * The tool takes a list of rolls, so a resolution with three creatures in it
 * needs one extra model exchange, not three. That is why the prompt tells the
 * game master to ask for every roll it might need at once and ignore the
 * unused ones: an unneeded morale roll costs nothing, while a second round
 * trip costs time and money.
 *
 * Each kind of request calls a function in `src/rules/knave/rolls.ts`, so the
 * rules (keep the higher die with advantage, the extra die on a natural 20 or
 * for a well-suited weapon, the d6 that uses up a book, adding up damage) are
 * in tested code, not in the prompt. This file only translates the request
 * and reports what the dice said.
 *
 * The dice come from the run's RNG, continuing from where the run left off.
 * It is the same stream the player's rolls use, and requests are rolled in
 * list order, so two runs with the same seed roll the same dice.
 */

import { z } from "zod";
import {
  attackRoll,
  consultRoll,
  DEFAULT_MORALE,
  dcFromDefense,
  moraleRoll,
  ORDINARY_DC,
  rollDamage,
  saveRoll,
  stuntRoll,
  type Edge,
} from "./rolls.ts";
import type { RollRng } from "../../shared/utils/rng.ts";
import { signed } from "../../shared/utils/format.ts";
import { nonEmpty } from "../../shared/utils/schema.ts";

// ---------------------------------------------------------------------------
// THE REQUEST
// ---------------------------------------------------------------------------

/** Advantage, disadvantage or neither. Also used for the roll a commit offers the player. */
export const edgeSchema = z.enum(["none", "advantage", "disadvantage"]);

/**
 * One roll in the list. It is one flat object with a `kind`, not a separate
 * shape per kind, because the model fills in a flat object more reliably.
 * Fields a kind needs are checked when the roll is made (`one` below).
 */
const rollSpecRequest = z.object({
  /** a label the game master chooses, so it can tell the results apart */
  id: nonEmpty,
  kind: z.enum(["save", "attack", "stunt", "morale", "damage", "consult"]),
  /**
   * Whose roll this is. `"player"` isn't an option, because the player's own
   * rolls are offered to them, never rolled by the game master.
   *
   * `playersOwnDice` in `src/gameplay/game-master/game-master.ts` refuses a
   * roll whose bonus matches one of the player's ability bonuses, assuming it
   * is the player's roll. When a creature's bonus just happens to match, the
   * game master sets `actor` to say so and the roll is allowed. Nothing else
   * reads it.
   */
  actor: z.enum(["creature", "world"]).optional(),
  edge: edgeSchema.optional(),
  /** save, attack, stunt */
  bonus: z.number().int().optional(),
  /** save: the number to meet. Defaults to 16. */
  dc: z.number().int().optional(),
  /** save: when a creature causes the danger, its defense, used instead of `dc` */
  defenseAsDc: z.number().int().optional(),
  /** attack, stunt */
  targetDefense: z.number().int().optional(),
  /** attack: the weapon's die. damage: the expression to roll. */
  damage: z.string().optional(),
  expr: z.string().optional(),
  extraDice: z.number().int().optional(),
  /** attack: the weapon is well suited to the target, which adds a damage die */
  wellSuited: z.boolean().optional(),
  /** morale: the group's rating. Defaults to 7. */
  rating: z.number().int().optional(),
  /**
   * consult: how many times the book has already been read (its current
   * `book.uses`, or 0 if it has never been opened). The tool counts this
   * reading itself and tells the game master what to write back.
   */
  uses: z.number().int().optional(),
});

export const rollBatchSchema = z.object({ rolls: z.array(rollSpecRequest).min(1) });

export type RollBatchParsed = z.infer<typeof rollBatchSchema>;
export type RollRequestParsed = z.infer<typeof rollSpecRequest>;

export interface DiceOutcome {
  /** the game master's own label for this roll */
  id: string;
  kind: RollRequestParsed["kind"];
  /** the result, as the game master will read it */
  line: string;
  /** the request could not be rolled as stated */
  failed: boolean;
  /**
   * The same result as fields, for the screen. The player is shown a
   * creature's attack on them as dice (`foeRolls` in
   * `src/gameplay/mechanics/effects.ts`). Reading these fields is safer than
   * parsing `line`, which breaks as soon as its wording changes.
   *
   * The DC is left out on purpose. `line` includes it for the game master, but
   * the player must never see it.
   */
  d20?: { rolled: number[]; kept: number; bonus: number; total: number; success: boolean; nat20: boolean; nat1: boolean };
  damage?: { expr: string; rolls: number[]; total: number };
  /** attack and stunt: the target's defense; matching the player's armour marks an attack on the player */
  targetDefense?: number;
}

/** A d20 result with everything except the DC, which the player must not see. */
function shown(o: { rolled: number[]; kept: number; bonus: number; total: number; success: boolean; nat20: boolean; nat1: boolean }) {
  return { rolled: [...o.rolled], kept: o.kept, bonus: o.bonus, total: o.total, success: o.success, nat20: o.nat20, nat1: o.nat1 };
}


/** The d20, bonus, total and DC written out, so the game master sees how the total was reached. */
function d20Line(o: { rolled: number[]; kept: number; bonus: number; total: number; dc: number }): string {
  const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`;
  return `d20 ${dice} ${signed(o.bonus)} = ${o.total} vs ${o.dc}`;
}

/** Tells the game master about a critical. Spending the quality point is left to the game master's diff. */
function critNote(o: { nat20: boolean; nat1: boolean }): string {
  if (o.nat20) return " · NATURAL 20 — the defender's armour loses 1 currentQuality";
  if (o.nat1) return " · NATURAL 1 — the attacker's weapon loses 1 currentQuality";
  return "";
}

/**
 * Rolls one request. Returns a failed outcome, with a `CANNOT ROLL` line, if a
 * field the kind needs is missing. Draws from `rng` as it goes, so the same
 * list on the same seed always rolls the same.
 */
function one(rng: RollRng, r: RollRequestParsed): DiceOutcome {
  const edge: Edge = r.edge ?? "none";
  const bonus = r.bonus ?? 0;
  const failed = (why: string): DiceOutcome => ({ id: r.id, kind: r.kind, line: `CANNOT ROLL — ${why}`, failed: true });

  switch (r.kind) {
    case "save": {
      // Against a creature's defense if one was given, else the DC, else 16.
      const dc = r.defenseAsDc !== undefined ? dcFromDefense(r.defenseAsDc) : r.dc ?? ORDINARY_DC;
      const o = saveRoll(rng, bonus, dc, edge);
      return {
        id: r.id,
        kind: r.kind,
        line: `save — ${d20Line(o)} — ${o.success ? "SUCCESS" : "FAILURE"}${critNote(o)}`,
        failed: false,
        d20: shown(o),
      };
    }

    case "attack": {
      if (r.targetDefense === undefined) return failed("an attack needs targetDefense");
      const o = attackRoll(rng, {
        bonus,
        targetDefense: r.targetDefense,
        edge,
        damage: r.damage,
        wellSuited: r.wellSuited,
      });
      const damage = o.damage
        ? ` · damage ${o.damage.expr} → [${o.damage.rolls.join(", ")}] = ${o.damage.total}`
        : o.success && r.damage === undefined
          ? ` · no damage die was given, so none was rolled`
          : "";
      return {
        id: r.id,
        kind: r.kind,
        line: `attack — ${d20Line(o)} — ${o.success ? "HIT" : "MISS"}${critNote(o)}${damage}`,
        failed: false,
        d20: shown(o),
        targetDefense: r.targetDefense,
        ...(o.damage ? { damage: { expr: o.damage.expr, rolls: [...o.damage.rolls], total: o.damage.total } } : {}),
      };
    }

    case "stunt": {
      if (r.targetDefense === undefined) return failed("a stunt needs targetDefense");
      const o = stuntRoll(rng, bonus, r.targetDefense, edge);
      return {
        id: r.id,
        kind: r.kind,
        // The line says outright that a stunt deals no damage, so the game
        // master doesn't have to remember the rule.
        line: `stunt — ${d20Line(o)} — ${o.success ? "SUCCESS, and it deals no damage" : "FAILURE"}${critNote(o)}`,
        failed: false,
        d20: shown(o),
        targetDefense: r.targetDefense,
      };
    }

    case "morale": {
      const rating = r.rating ?? DEFAULT_MORALE;
      const o = moraleRoll(rng, rating);
      return {
        id: r.id,
        kind: r.kind,
        line: `morale — 2d6 [${o.rolled.join(", ")}] = ${o.total} vs ${rating} — ${o.holds ? "THEY HOLD" : "THEY BREAK"}`,
        failed: false,
      };
    }

    case "consult": {
      const o = consultRoll(rng, r.uses ?? 0);
      // Tells the game master exactly what to write back, so it reports the
      // count it was given rather than working one out.
      const verdict = o.exhausted
        ? `THE LAST OF IT · write book.uses ${o.uses} and book.exhausted true`
        : `THERE IS MORE IN IT · write book.uses ${o.uses}`;
      return {
        id: r.id,
        kind: r.kind,
        line: `consult — reading ${o.uses}, d6 [${o.rolled}] vs ${o.uses} — ${verdict}`,
        failed: false,
      };
    }

    case "damage": {
      const expr = r.expr ?? r.damage;
      if (expr === undefined) return failed("damage needs an expression, e.g. 2d6");
      try {
        const o = rollDamage(rng, expr, r.extraDice ?? 0);
        return {
          id: r.id,
          kind: r.kind,
          line: `damage — ${o.expr} → [${o.rolls.join(", ")}] = ${o.total}`,
          failed: false,
          damage: { expr: o.expr, rolls: [...o.rolls], total: o.total },
        };
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    }
  }
}

export function rollBatch(rng: RollRng, rolls: RollRequestParsed[]): DiceOutcome[] {
  return rolls.map((r) => one(rng, r));
}

/** The results as text for the game master, one line per roll, each starting with its `id`. */
export function renderOutcomes(outcomes: DiceOutcome[]): string {
  return outcomes.map((o) => `${o.id}: ${o.line}`).join("\n");
}
