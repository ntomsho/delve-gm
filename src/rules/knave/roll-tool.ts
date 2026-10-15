/**
 * THE DICE TOOL
 * =============
 *
 * The game master's half of the split described in BUILD-PLAN §4.2. The player's
 * roll is thrown by the interface and arrives with their next message; every
 * other roll in the game — the creature that strikes back, the nerve that
 * breaks, the ceiling that comes down — is asked for here.
 *
 * IT TAKES A LIST, AND THAT IS THE WHOLE DESIGN. A resolution with three
 * creatures in it costs ONE extra exchange rather than three, so the playbook
 * can tell the game master to roll wide and discard rather than go back for more.
 * A morale check it did not end up needing is a rounding error; a second round
 * trip is not.
 *
 * Every kind maps onto `engine/dungeon-rolls`, which means advantage keep-best,
 * the natural 20's extra die, the well-suited bonus, the d6 that empties a book
 * and damage summation stay in tested code rather than moving into the prompt. Nothing here decides a
 * rule; it translates a request and reports what the dice said.
 *
 * The RNG is the run's, positioned where the run left off — the same stream the
 * player's own rolls draw from, advanced in list order. Two runs on one seed
 * roll the same dice.
 */

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
import type { RollRequestParsed } from "../../llm/schemas.ts";
import { signed } from "../../shared/utils/format.ts";

export interface DiceOutcome {
  /** the game master's own label for this roll */
  id: string;
  kind: RollRequestParsed["kind"];
  /** the result, as the game master will read it */
  line: string;
  /** the request could not be rolled as stated */
  failed: boolean;
  /**
   * THE SAME RESULT, STRUCTURED, FOR THE SCREEN. The player is shown a
   * creature's attack on them as dice (see `FoeRolls`), and a screen that
   * parsed `line` would be one rewording away from showing nothing. The number
   * the d20 had to meet is deliberately not here: `line` carries it for the
   * game master, and nothing the player can be shown does.
   */
  d20?: { rolled: number[]; kept: number; bonus: number; total: number; success: boolean; nat20: boolean; nat1: boolean };
  damage?: { expr: string; rolls: number[]; total: number };
  /** attack and stunt: the defense aimed at — how an attack on the player is told apart */
  targetDefense?: number;
}

/** A d20 result as the screen may see it — everything but the DC. */
function shown(o: { rolled: number[]; kept: number; bonus: number; total: number; success: boolean; nat20: boolean; nat1: boolean }) {
  return { rolled: [...o.rolled], kept: o.kept, bonus: o.bonus, total: o.total, success: o.success, nat20: o.nat20, nat1: o.nat1 };
}


/** The d20 and its bonus, spelled out so a total can never be a bare claim. */
function d20Line(o: { rolled: number[]; kept: number; bonus: number; total: number; dc: number }): string {
  const dice = o.rolled.length > 1 ? `[${o.rolled.join(", ")}] keep ${o.kept}` : `${o.kept}`;
  return `d20 ${dice} ${signed(o.bonus)} = ${o.total} vs ${o.dc}`;
}

/** Crits report themselves; spending the quality point is the game master's diff. */
function critNote(o: { nat20: boolean; nat1: boolean }): string {
  if (o.nat20) return " · NATURAL 20 — the defender's armour loses 1 currentQuality";
  if (o.nat1) return " · NATURAL 1 — the attacker's weapon loses 1 currentQuality";
  return "";
}

/**
 * Roll one request. Draws from `rng` in call order, so the batch is
 * deterministic in the order the game master listed it.
 */
function one(rng: RollRng, r: RollRequestParsed): DiceOutcome {
  const edge: Edge = r.edge ?? "none";
  const bonus = r.bonus ?? 0;
  const failed = (why: string): DiceOutcome => ({ id: r.id, kind: r.kind, line: `CANNOT ROLL — ${why}`, failed: true });

  switch (r.kind) {
    case "save": {
      // A creature is the source of the risk, or it is the ordinary bar.
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
        // Stunts deal no damage of their own — the rule lives here so the
        // prompt does not have to be trusted to remember it.
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
      // Says what to write, for the same reason a crit does: the game master is
      // reporting a number it was given, never choosing one.
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

/** The batch's results, keyed by the game master's own ids. */
export function renderOutcomes(outcomes: DiceOutcome[]): string {
  return outcomes.map((o) => `${o.id}: ${o.line}`).join("\n");
}
